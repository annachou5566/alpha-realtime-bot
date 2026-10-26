#!/usr/bin/env python3
"""Owner-operated, fail-closed encrypted Supabase anon->publishable key cutover.
Never accepts a key in argv, never prints it, never writes plaintext to disk.
Only the existing Alpha reader credential is replaced, with encrypted rollback.
"""
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

UNIT = "alpha-realtime-production-readonly.service"
DROPIN = Path("/etc/systemd/system/alpha-realtime-production-readonly.service.d/zzzz-wa-alpha-read-key-primary.conf")
PROJECT = "https://akbcpryqjigndzpuoany.supabase.co"
NAME = "SUPABASE_ANON_KEY"
IDS = {216, 217, 218}

def ctl(*args, timeout=10):
    p = subprocess.run(["systemctl", *args], capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError("SYSTEMCTL_" + args[0].upper() + "_FAILED")
    return p.stdout.decode("utf-8", "replace").strip()

def state():
    return int(ctl("show", UNIT, "-p", "MainPID", "--value")), ctl("show", UNIT, "-p", "ActiveState", "--value")

def env_for(pid):
    raw = (Path("/proc") / str(pid) / "environ").read_bytes()
    return dict(x.split(b"=", 1) for x in raw.split(b"\0") if b"=" in x)

def source_path():
    if not DROPIN.is_file() or DROPIN.is_symlink():
        raise RuntimeError("EXPECTED_DROPIN_NOT_REGULAR")
    matches = []
    for line in DROPIN.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        for kind in ("LoadCredentialEncrypted=", "LoadCredential="):
            if line.startswith(kind):
                for part in line[len(kind):].split():
                    if part.split(":", 1)[0] == NAME:
                        matches.append((kind, part.partition(":")[2]))
    if len(matches) != 1 or matches[0][0] != "LoadCredentialEncrypted=":
        raise RuntimeError("ENCRYPTED_SINGLE_KEY_SOURCE_NOT_PROVEN")
    path = Path(matches[0][1])
    if not path.is_absolute() or path.is_symlink():
        raise RuntimeError("UNSAFE_SOURCE_PATH")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError("UNSAFE_SOURCE_PERMISSIONS")
    return path

def decrypt(path):
    p = subprocess.run(["systemd-creds", "decrypt", "--name=" + NAME, str(path), "-"],
                       capture_output=True, timeout=15)
    if p.returncode:
        raise RuntimeError("DECRYPT_GATE_FAILED")
    return p.stdout.strip()

def supabase_rows(key):
    qs = urllib.parse.urlencode({"select": "id,name,data", "id": "in.(216,217,218)", "limit": 3})
    req = urllib.request.Request(PROJECT + "/rest/v1/tournaments?" + qs,
                                 headers={"apikey": key, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as res:
        rows = json.loads(res.read(500000))
    if not isinstance(rows, list) or {int(x["id"]) for x in rows} != IDS:
        raise RuntimeError("SUPABASE_PROJECT_OR_READ_PERMISSION_MISMATCH")
    return {int(x["id"]): x for x in rows}

def local_api(pid):
    env = env_for(pid)
    directory = Path(env.get(b"CREDENTIALS_DIRECTORY", b"").decode())
    cred = directory / "PRODUCTION_READ_API_SECRET_KEY"
    if not directory.is_dir() or not cred.is_file() or cred.is_symlink():
        raise RuntimeError("READ_API_CREDENTIAL_NOT_PROVEN")
    auth = cred.read_bytes().strip().decode("ascii")
    port = env.get(b"PORT", b"3100").decode("ascii")
    if not port.isdecimal() or not (1 <= int(port) <= 65535):
        raise RuntimeError("LOCAL_PORT_INVALID")
    req = urllib.request.Request("http://127.0.0.1:" + port + "/api/competition-data",
                                 headers={"x-api-key": auth})
    with urllib.request.urlopen(req, timeout=7) as res:
        data = json.loads(res.read(12000000))
    found = {int(v.get("db_id")): v for v in data.values()
             if isinstance(v, dict) and str(v.get("db_id", "")).isdecimal()
             and int(v["db_id"]) in IDS}
    if set(found) != IDS:
        raise RuntimeError("LOCAL_API_MISSING_3_TOKENS")
    return found

def target(data):
    pairs = []
    for entry in data.get("history", []) or []:
        if isinstance(entry, dict):
            try:
                value = float(entry.get("target") or 0)
                if value > 0:
                    pairs.append((str(entry.get("date", "")), value))
            except (TypeError, ValueError):
                pass
    return max(pairs, default=None)

def health(oldpid):
    end = time.monotonic() + 75
    while time.monotonic() < end:
        try:
            pid, active = state()
            if active == "active" and pid > 0 and pid != oldpid:
                if env_for(pid).get(b"SUPABASE_ANON_KEY", b"").startswith(b"sb_publishable_"):
                    return pid, local_api(pid)
        except Exception:
            pass
        time.sleep(3)
    raise RuntimeError("NEW_SERVICE_HEALTH_GATE_FAILED")

def main():
    print("WA_ALPHA_COMP_CUTOVER_BEGIN", flush=True)
    if os.geteuid() or not sys.stdin.isatty():
        raise RuntimeError("REQUIRES_ROOT_INTERACTIVE_TTY")
    pid, active = state()
    if active != "active" or pid < 1:
        raise RuntimeError("BASELINE_SERVICE_NOT_ACTIVE")
    env = env_for(pid)
    if env.get(b"SUPABASE_URL", b"").rstrip(b"/") != PROJECT.encode():
        raise RuntimeError("WRONG_SUPABASE_PROJECT")
    if env.get(b"SUPABASE_SERVICE_ROLE_KEY"):
        raise RuntimeError("UNEXPECTED_ADMIN_KEY")
    old = env.get(b"SUPABASE_ANON_KEY", b"")
    if not old.startswith(b"eyJ"):
        raise RuntimeError("BASELINE_NOT_LEGACY")
    source = source_path()
    if decrypt(source) != old.strip():
        raise RuntimeError("SOURCE_NOT_EFFECTIVE_LEGACY_KEY")
    local_api(pid)  # Assert protected API works before changing service.
    print("PREFLIGHT=PASS_ENCRYPTED_SOURCE_AND_BASELINE_API", flush=True)
    new = getpass.getpass("Paste Supabase publishable key (hidden, NOT chat): ").strip()
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{12,}", new):
        raise RuntimeError("NOT_A_PUBLISHABLE_KEY")
    rows = supabase_rows(new)  # 200 with correct IDs proves read access.
    print("SUPABASE_NEW_KEY_READ=PASS_THREE_TOKENS", flush=True)
    backup = Path(tempfile.mkdtemp(prefix=".wa-alpha-key-backup-", dir=str(source.parent)))
    os.chmod(backup, 0o700)
    saved = backup / source.name
    shutil.copy2(source, saved)
    os.chmod(saved, 0o600)
    fd, name = tempfile.mkstemp(prefix=".wa-alpha-key-stage-", dir=str(source.parent))
    os.close(fd)
    stage = Path(name)
    os.chmod(stage, 0o600)
    replaced = False
    try:
        p = subprocess.run(["systemd-creds", "encrypt", "--name=" + NAME, "-", str(stage)],
                           input=new.encode(), capture_output=True, timeout=20)
        if p.returncode or decrypt(stage) != new.encode():
            raise RuntimeError("ENCRYPTION_SELF_TEST_FAILED")
        print("ENCRYPTED_STAGE=PASS_ROOT_ONLY_BACKUP", flush=True)
        os.replace(stage, source)
        os.chmod(source, 0o600)
        replaced = True
        try:
            ctl("restart", UNIT, timeout=45)
            freshpid, delivered = health(pid)
        except Exception as error:
            print("NEW_READER_HEALTH=FAIL_ROLLBACK_START", flush=True)
            os.replace(saved, source)
            replaced = False
            os.chmod(source, 0o600)
            try:
                ctl("restart", UNIT, timeout=45)
                oldpid, oldstate = state()
                print("ROLLBACK_SERVICE_ACTIVE=" + str(oldstate == "active" and oldpid > 0), flush=True)
            except Exception:
                print("ROLLBACK_MANUAL_ATTENTION=YES", flush=True)
            raise RuntimeError("CUTOVER_ROLLED_BACK_" + type(error).__name__)
        print("NEW_READER_ACTIVE=YES", flush=True)
        equal = []
        for ident in sorted(IDS):
            expected = target(rows[ident].get("data") or {})
            actual = target(delivered[ident])
            good = expected == actual
            equal.append(good)
            print("TARGET_ID_" + str(ident) + "=" + ("PASS" if good else "PENDING"), flush=True)
        print("MIN_VOL_GATE=" + ("PASS" if all(equal) else "NEEDS_UPSTREAM_DIAGNOSIS"), flush=True)
        print("CHART_VOLUME_GATE=REQUIRES_BROWSER_QUALIFICATION", flush=True)
        print("BACKUP_ENCRYPTED_ROOT_ONLY=YES", flush=True)
        print("WA_ALPHA_COMP_CUTOVER_RC=0", flush=True)
    finally:
        stage.unlink(missing_ok=True)
        print("SECRET_VALUES_PRINTED=NO", flush=True)
        print("WA_ALPHA_COMP_CUTOVER_END", flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Exception messages are fixed internal error labels; no key material.
        print("STATUS=HOLD_" + str(error)[:90].replace(" ", "_"), flush=True)
        print("SECRET_VALUES_PRINTED=NO", flush=True)
        print("WA_ALPHA_COMP_CUTOVER_RC=1", flush=True)
        sys.exit(1)
