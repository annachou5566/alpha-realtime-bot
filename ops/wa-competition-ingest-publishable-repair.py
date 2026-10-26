#!/usr/bin/env python3
"""Owner-only guarded Competition ingest credential repair; never logs secrets."""
import getpass, json, os, pathlib, re, stat, subprocess, sys, tempfile, urllib.request

P=pathlib.Path("/etc/wave-alpha/competition-ingest.env")
UNIT="wave-competition-ingest.service"
TIMER="wave-competition-ingest.timer"
PROJECT="https://akbcpryqjigndzpuoany.supabase.co"
CRED="/etc/credstore.encrypted/wave-competition-ingest-machine-key.cred"
def run(*cmd, input=None, timeout=50):
    return subprocess.run(cmd,input=input,capture_output=True,timeout=timeout)
def fail(code):
    raise RuntimeError(code)
def main():
    print("WA_COMP_INGEST_KEY_REPAIR_BEGIN",flush=True)
    if os.geteuid()!=0 or not sys.stdin.isatty():fail("ROOT_INTERACTIVE_REQUIRED")
    if P.is_symlink() or not P.is_file():fail("ENV_NOT_REGULAR")
    st=P.stat()
    if st.st_uid!=0 or (st.st_mode & 0o007):fail("ENV_PERMISSIONS_UNSAFE")
    old=P.read_bytes()
    parts=[]
    for line in old.decode("utf-8").splitlines():
        if line.strip().startswith("#") or "=" not in line:continue
        k,v=line.split("=",1);parts.append((k.strip(),v.strip().strip("\"'")))
    d=dict(parts)
    if len([1 for k,v in parts if k=="SUPABASE_ANON_KEY"])!=1:fail("KEY_MAPPING_AMBIGUOUS")
    if not d["SUPABASE_ANON_KEY"].startswith("eyJ"):fail("NOT_LEGACY_BASELINE")
    if d.get("SUPABASE_URL","").rstrip("/")!=PROJECT:fail("PROJECT_MISMATCH")
    if d.get("WAVE_COMPETITION_INGEST_MODE")!="publish":fail("NOT_PUBLISH_MODE")
    if run("systemctl","is-active","--quiet",TIMER).returncode:fail("TIMER_INACTIVE")
    if not pathlib.Path(CRED).is_file():fail("MACHINE_CREDENTIAL_MISSING")
    proc=run("systemd-creds","decrypt","--name=competition_ingest_machine_key",CRED,"-",timeout=12)
    if proc.returncode or not (32<=len(proc.stdout.strip())<=256):fail("MACHINE_CREDENTIAL_DECRYPT_FAILED")
    key=getpass.getpass("Paste Supabase PUBLISHABLE key locally (hidden): ").strip()
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{12,}",key):fail("INVALID_KEY_CLASS")
    body=json.dumps({"p_machine_key":proc.stdout.decode().strip(),"p_limit":1}).encode()
    req=urllib.request.Request(PROJECT+"/rest/v1/rpc/wave_competition_ingest_status",
        data=body,method="POST",headers={"apikey":key,"Authorization":"Bearer "+key,
        "Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=15) as response:
            payload=json.loads(response.read(150000))
            if not isinstance(payload,dict) or "articles" not in payload:fail("RPC_STATUS_SHAPE_MISMATCH")
    except Exception:
        fail("PUBLISHABLE_RPC_AUTH_PREFLIGHT_FAILED")
    print("NEW_KEY_RPC_STATUS_READ=PASS",flush=True)
    lines=old.decode().splitlines(keepends=True)
    updated=[]
    count=0
    for line in lines:
        if line.split("=",1)[0].strip()=="SUPABASE_ANON_KEY":
            updated.append("SUPABASE_ANON_KEY="+key+"\n");count+=1
        else:updated.append(line)
    if count!=1:fail("KEY_SUBSTITUTION_FAILED")
    backup=pathlib.Path(tempfile.mkdtemp(prefix=".wa-competition-rollback-",dir=str(P.parent)))
    os.chmod(backup,0o700)
    (backup/"competition-ingest.env.previous").write_bytes(old)
    os.chmod(backup/"competition-ingest.env.previous",0o600)
    fd,tmp=tempfile.mkstemp(prefix=".wa-competition-new-",dir=str(P.parent))
    try:
        with os.fdopen(fd,"wb") as out:out.write("".join(updated).encode())
        os.chown(tmp,st.st_uid,st.st_gid)
        os.chmod(tmp,stat.S_IMODE(st.st_mode))
        os.replace(tmp,P)
        print("ENV_ATOMIC_SWITCH=PASS",flush=True)
        result=run("systemctl","start",UNIT,timeout=55)
        if result.returncode:
            # machine key is not modified; restore original env before next timer tick
            fd2,restore=tempfile.mkstemp(prefix=".wa-competition-restore-",dir=str(P.parent))
            with os.fdopen(fd2,"wb") as o:o.write(old)
            os.chown(restore,st.st_uid,st.st_gid)
            os.chmod(restore,stat.S_IMODE(st.st_mode))
            os.replace(restore,P)
            print("INGEST_RUN=FAIL_OR_UNQUALIFIED",flush=True)
            print("ROLLBACK_ENV=PASS",flush=True)
            fail("ONESHOT_FAILED_ENV_RESTORED")
        print("INGEST_RUN=PASS_EXIT_ZERO",flush=True)
        print("MACHINE_KEY_UNCHANGED=YES",flush=True)
        print("ROLLBACK_ROOT_ONLY=YES",flush=True)
        print("WA_COMP_INGEST_KEY_REPAIR_RC=0",flush=True)
    finally:
        pathlib.Path(tmp).unlink(missing_ok=True)
        print("SECRET_VALUES_PRINTED=NO",flush=True)
        print("WA_COMP_INGEST_KEY_REPAIR_END",flush=True)
if __name__=="__main__":
    try:main()
    except Exception as e:
        print("HOLD="+str(e)[:90],flush=True)
        print("WA_COMP_INGEST_KEY_REPAIR_RC=1",flush=True)
        sys.exit(1)
