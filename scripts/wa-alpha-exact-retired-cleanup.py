#!/usr/bin/env python3
"""WaveAlpha exact-path retired Alpha API credential cleanup. Oracle root only.

No restart, reboot, credential rotation, service change, secret disclosure or backup.
Deliberately never restores compromised old-key trust on a partial failure.
"""
import http.client
import os
import pathlib
import stat
import subprocess
import sys

HOST = "micro-server-auto-2"
SERVICE = "alpha-realtime-production-readonly.service"
SHADOW = "wave-alpha-unified-realtime-shadow.service"
ROOT = pathlib.Path("/opt/wave-alpha/alpha-realtime")
RELEASE = ROOT / "releases/ed0af597f525ce2295593d352530665ab4b38674"
UNIT_DIR = pathlib.Path("/etc/systemd/system") / (SERVICE + ".d")
BASE_UNIT = pathlib.Path("/etc/systemd/system") / SERVICE
DUAL = UNIT_DIR / "60-wavealpha-api-next.conf"
PRIMARY = UNIT_DIR / "zzzz-wa-alpha-read-key-primary.conf"
NEXT = pathlib.Path("/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT")
ACTIVE = pathlib.Path("/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_WA20261024")
OLD = pathlib.Path("/run/wave-alpha-alpha/credentials/PRODUCTION_READ_API_SECRET_KEY")
RUNTIME = pathlib.Path("/run/credentials") / SERVICE
PLAIN = {
    "R2_READ_ONLY_ACCESS_KEY_ID": "/run/wave-alpha-alpha/credentials/R2_READ_ONLY_ACCESS_KEY_ID",
    "R2_READ_ONLY_SECRET_ACCESS_KEY": "/run/wave-alpha-alpha/credentials/R2_READ_ONLY_SECRET_ACCESS_KEY",
    "SUPABASE_ANON_KEY": "/run/wave-alpha-alpha/credentials/SUPABASE_ANON_KEY",
    "ALPHA_LIVE_PUBLISH_KEY": "/run/wave-alpha-alpha/credentials/ALPHA_LIVE_PUBLISH_KEY",
}
ENCRYPTED = {"PRODUCTION_READ_API_SECRET_KEY": str(ACTIVE)}
PHASE = "PREFLIGHT"
MUTATED = False


def run(*argv, timeout=12):
    p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode != 0 or len(p.stdout) > 150000:
        raise RuntimeError("COMMAND_" + argv[0].replace("/", "_"))
    return p.stdout.decode("utf-8", "strict").strip()


def must(ok, label):
    if not ok:
        raise RuntimeError(label)


def exact_file(path):
    m = path.lstat()
    must(stat.S_ISREG(m.st_mode) and m.st_uid == 0 and (m.st_mode & 0o777) == 0o600
         and m.st_nlink == 1, "UNSAFE_FILE_METADATA")
    return (m.st_dev, m.st_ino, m.st_uid, m.st_mode, m.st_nlink)


def mapping():
    plain, encrypted = {}, {}
    for raw in run("systemctl", "cat", "--no-pager", SERVICE).splitlines():
        line = raw.strip()
        if line.startswith("LoadCredential="):
            value = line.split("=", 1)[1]
            if value == "":
                plain.clear()
                encrypted.clear()
            else:
                n, sep, path = value.partition(":")
                must(bool(sep) and n not in plain and n not in encrypted,
                     "DUPLICATE_PLAIN_MAPPING")
                plain[n] = path
        elif line.startswith("LoadCredentialEncrypted="):
            value = line.split("=", 1)[1]
            if value == "":
                plain.clear()
                encrypted.clear()
            else:
                n, sep, path = value.partition(":")
                must(bool(sep) and n not in plain and n not in encrypted,
                     "DUPLICATE_ENCRYPTED_MAPPING")
                encrypted[n] = path
    must(plain == PLAIN and encrypted == ENCRYPTED, "NOT_EXACT_NEW_ONLY_FIVE")
    return True


def http_status(key=None):
    conn = http.client.HTTPConnection("127.0.0.1", 3100, timeout=8)
    try:
        headers = {"x-api-key": key} if key is not None else {}
        conn.request("GET", "/api/token-list", headers=headers)
        res = conn.getresponse()
        status = res.status
        body = res.read(3000001)
        return status, body
    finally:
        conn.close()


def auth_and_runtime(new, old, pid):
    must(run("systemctl", "is-active", SERVICE) == "active", "ALPHA_INACTIVE")
    must(run("systemctl", "is-active", SHADOW) == "active", "SHADOW_CHANGED")
    must(run("systemctl", "show", "-P", "MainPID", SERVICE) == pid,
         "ALPHA_PID_CHANGED")
    must(run("systemctl", "show", "-P", "NeedDaemonReload", SERVICE) == "no",
         "UNIT_RELOAD_PENDING")
    must(pathlib.Path(run("readlink", "-f", str(ROOT / "current"))) == RELEASE,
         "RELEASE_CHANGED")
    must(http_status(new)[0] == 200, "NEW_KEY_NOT_ACCEPTED")
    must(http_status(old)[0] == 401, "OLD_KEY_NOT_401")
    must(http_status("synthetic-invalid-wa-retired")[0] == 401,
         "INVALID_KEY_NOT_401")
    must(http_status()[0] == 401, "ANONYMOUS_NOT_401")


def shadow_guard():
    # Read configuration in memory, never echo it. Distinguish shared directory
    # references from references to this retired credential's exact basename.
    unit = run("systemctl", "cat", "--no-pager", SHADOW)
    must("PRODUCTION_READ_API_SECRET_KEY" not in unit and
         str(DUAL) not in unit and str(NEXT) not in unit,
         "SHADOW_OLD_API_SOURCE_REFERENCE")


def main():
    global PHASE, MUTATED
    print("WA_ALPHA_EXACT_CLEANUP_BEGIN", flush=True)
    try:
        must(os.geteuid() == 0 and run("hostname", "-s") == HOST, "IDENTITY")
        must(BASE_UNIT.is_file() and not BASE_UNIT.is_symlink(), "BASE_UNIT")
        must(UNIT_DIR.is_dir() and not UNIT_DIR.is_symlink(), "DROPIN_DIRECTORY")
        must(RUNTIME.is_dir() and not RUNTIME.is_symlink(), "RUNTIME_DIRECTORY")
        must(run("systemctl", "show", "-P", "User", SERVICE) == "wavealpha-alpha",
             "SERVICE_USER")
        must(run("systemctl", "show", "-P", "Restart", SERVICE) == "no",
             "RESTART_POLICY")
        must(run("systemctl", "is-active", SHADOW) == "active", "SHADOW_NOT_ACTIVE")
        must(run("systemctl", "show", "-P", "NeedDaemonReload", SERVICE) == "no",
             "PENDING_DAEMON_RELOAD")
        pid = run("systemctl", "show", "-P", "MainPID", SERVICE)
        must(pid.isdigit() and int(pid) > 0, "INVALID_PID")
        must(pathlib.Path(run("readlink", "-f", str(ROOT / "current"))) == RELEASE,
             "RELEASE_DRIFT")

        protected = {str(ACTIVE): exact_file(ACTIVE), str(PRIMARY): exact_file(PRIMARY)}
        for path in PLAIN.values():
            protected[path] = exact_file(pathlib.Path(path))
        retired = {str(path): exact_file(path) for path in (DUAL, NEXT, OLD)}
        mapping()
        shadow_guard()
        must((RUNTIME / "PRODUCTION_READ_API_SECRET_KEY_NEXT").exists() is False,
             "NEXT_STILL_LOADED")
        for name in (*PLAIN, "PRODUCTION_READ_API_SECRET_KEY"):
            must((RUNTIME / name).is_file(), "LOADED_MAPPING_MISSING")
        new = (RUNTIME / "PRODUCTION_READ_API_SECRET_KEY").read_text().rstrip("\n")
        old = OLD.read_text().rstrip("\n")
        must(len(new) == 64 and len(old) >= 16 and new != old, "INVALID_KEY_PAIR")
        auth_and_runtime(new, old, pid)
        print("PREFLIGHT=PASS_EXACT_NEW_ONLY_SHADOW_AND_AUTH", flush=True)

        # Removing this obsolete dual drop-in changes only on-disk unit config.
        # Reload manager metadata, never start/restart/reload the running service.
        PHASE = "REMOVE_DUAL"
        must(exact_file(DUAL) == retired[str(DUAL)], "DUAL_IDENTITY_DRIFT")
        DUAL.unlink()
        MUTATED = True
        PHASE = "RELOAD_METADATA"
        run("systemctl", "daemon-reload", timeout=20)
        mapping()
        auth_and_runtime(new, old, pid)
        print("DUAL_DROPIN_REMOVED=PASS_NO_RESTART", flush=True)

        PHASE = "REMOVE_UNUSED_NEXT"
        must(exact_file(NEXT) == retired[str(NEXT)], "NEXT_IDENTITY_DRIFT")
        NEXT.unlink()
        print("OLD_NEXT_ENCRYPTED_REMOVED=PASS", flush=True)

        PHASE = "REMOVE_RETIRED_PLAINTEXT"
        must(exact_file(OLD) == retired[str(OLD)], "OLD_PLAINTEXT_IDENTITY_DRIFT")
        OLD.unlink()
        print("OLD_PLAINTEXT_REMOVED=PASS", flush=True)

        PHASE = "POSTCHECK"
        must(all(not p.exists() and not p.is_symlink() for p in (DUAL, NEXT, OLD)),
             "RETIRED_PATH_STILL_EXISTS")
        must(all(exact_file(pathlib.Path(p)) == metadata
                 for p, metadata in protected.items()), "PROTECTED_FILE_CHANGED")
        mapping()
        auth_and_runtime(new, old, pid)
        print("EFFECTIVE_MAPPING=FIVE_NEW_ONLY", flush=True)
        print("OLD_KEY=REJECTED_401_NEW_KEY=ACCEPTED", flush=True)
        print("ALPHA_AND_SHADOW=ACTIVE_UNCHANGED_PID", flush=True)
        print("BOOT_RECOVERY=NOT_QUALIFIED_SEPARATE_SCOPE", flush=True)
        print("CLEANUP=PASS_THREE_EXACT_ARTIFACTS", flush=True)
        print("WA_ALPHA_EXACT_CLEANUP_RC=0", flush=True)
        print("WA_ALPHA_EXACT_CLEANUP_END", flush=True)
        return 0
    except Exception as e:
        print("GATE=HOLD_" + PHASE + "_" + str(e if isinstance(e, RuntimeError)
                                                 else type(e).__name__), flush=True)
        print("MUTATION=" + ("PARTIAL_CHECK_PATHS_NO_BLIND_RETRY" if MUTATED
                             else "NONE"), flush=True)
        print("NEVER_REENABLE_OLD_KEY=YES", flush=True)
        print("WA_ALPHA_EXACT_CLEANUP_RC=" + ("21" if MUTATED else "20"), flush=True)
        print("WA_ALPHA_EXACT_CLEANUP_END", flush=True)
        return 21 if MUTATED else 20


if __name__ == "__main__":
    sys.exit(main())
