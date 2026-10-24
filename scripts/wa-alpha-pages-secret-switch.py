#!/usr/bin/env python3
"""One-target Pages Production secret switch. Never prints or persists a key."""
import json
import os
import re
import shlex
import subprocess
import sys

ACCOUNT = "0f534c1b6f9bc097235b37c07d1dc32e"
PROJECT = "wave-alpha"
HOST = "ubuntu@161.118.219.31"
NEXT = "/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT"
UNIT = "alpha-realtime-production-readonly.service"
SOURCE_SHA = "ed0af597f525ce2295593d352530665ab4b38674"
SSH = ["ssh", "-T", "-i", "/root/.ssh/wave_alpha_oracle.key", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12", HOST]
WRANGLER = ["npx", "--yes", "--package=wrangler@4.149.0", "--", "wrangler"]

REMOTE = r'''
import http.client, json, pathlib, re, subprocess, sys
svc="alpha-realtime-production-readonly.service"
base=pathlib.Path("/opt/wave-alpha/alpha-realtime")
expected=base/"releases/ed0af597f525ce2295593d352530665ab4b38674"
src=pathlib.Path("/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT")
def run(*args):
 p=subprocess.run(args,capture_output=True,timeout=30)
 if p.returncode: raise RuntimeError("remote_preflight_command_failed")
 return p.stdout.decode("utf-8").strip()
def req(key):
 c=http.client.HTTPConnection("127.0.0.1",3100,timeout=8)
 try:
  c.request("GET","/api/token-list",headers={"x-api-key":key})
  r=c.getresponse(); data=r.read(3000000); return r.status,data
 finally: c.close()
try:
 assert run("hostname","-s")=="micro-server-auto-2"
 assert pathlib.Path(run("readlink","-f",str(base/"current")))==expected
 assert run("systemctl","is-active",svc)=="active"
 assert run("systemctl","show","-P","NeedDaemonReload",svc)=="no"
 unit=run("systemctl","cat","--no-pager",svc)
 assert "LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT:" in unit
 assert src.is_file() and not src.is_symlink() and src.stat().st_uid==0
 assert not src.stat().st_mode & 0o077
 nxt=subprocess.run(["systemd-creds","decrypt",str(src),"-"],capture_output=True,timeout=20)
 assert nxt.returncode==0 and re.fullmatch(rb"[0-9a-f]{64}",nxt.stdout)
 active=(pathlib.Path("/run/credentials")/svc/"PRODUCTION_READ_API_SECRET_KEY").read_bytes().rstrip(b"\n")
 assert active and active!=nxt.stdout
 for key in [active,nxt.stdout]:
  status,data=req(key.decode("ascii"))
  assert status==200 and isinstance(json.loads(data).get("data"),list) and len(json.loads(data)["data"])>0
 assert req("invalid-synthetic-pages-stage")[0]==401
 sys.stdout.buffer.write(nxt.stdout)
except Exception:
 sys.exit(40)
'''

def call(args, **kwargs):
    return subprocess.run(args, capture_output=True, **kwargs)

def emit(s):
    print(s, flush=True)

def main():
    os.umask(0o077)
    cf_env = dict(os.environ, CLOUDFLARE_ACCOUNT_ID=ACCOUNT)
    emit("WA_ALPHA_PAGES_SECRET_SWITCH_BEGIN")
    try:
        who=call(WRANGLER+["whoami"], timeout=150, cwd="/tmp", env=cf_env)
        if who.returncode!=0 or ACCOUNT.encode() not in (who.stdout+who.stderr):
            emit("GATE=HOLD_CF_ACCOUNT_NO_MUTATION")
            return 20
        emit("CF_ACCOUNT=PASS")

        remote=call(SSH+["sudo -n python3 -c "+shlex.quote(REMOTE)], timeout=65)
        if remote.returncode!=0 or not re.fullmatch(rb"[0-9a-f]{64}",remote.stdout):
            emit("GATE=HOLD_ORACLE_DUAL_NO_MUTATION")
            return 21
        emit("ORACLE_DUAL=PASS")

        # Only the next credential is passed by an in-memory stdin pipe to Wrangler.
        # No command argument, process environment, shell log or local file contains it.
        run=call(WRANGLER+["pages","secret","put","RENDER_API_KEY","--project-name",PROJECT,"--env","production"],
                 input=remote.stdout+b"\n", timeout=180, cwd="/tmp", env=cf_env)
        if run.returncode!=0:
            emit("PAGES_PATCH=INDETERMINATE_VERIFY_CONNECTED_API_NO_RETRY")
            return 22
        emit("PAGES_SECRET_PUT=RC_0")
        emit("PAGES_RUNTIME_EFFECT=NOT_YET_QUALIFIED")
        emit("ORACLE_RESTART=NO")
        emit("FRONTEND_DEPLOY=NO")
        emit("GATE=PROJECT_SECRET_PATCH_SENT")
        return 0
    except subprocess.TimeoutExpired:
        emit("GATE=HOLD_TIMEOUT_STATE_MAY_BE_INDETERMINATE_NO_RETRY")
        return 23
    except Exception:
        emit("GATE=HOLD_OPERATOR_ERROR_NO_SECRET_OUTPUT")
        return 24
    finally:
        emit("WA_ALPHA_PAGES_SECRET_SWITCH_END")

if __name__=="__main__":
    sys.exit(main())
