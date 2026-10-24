#!/usr/bin/env python3
"""WaveAlpha Alpha only: promote qualified encrypted NEXT as sole active API key.
HTTP helper is named http_get to avoid shadowing imported http.client (prior AttributeError gate).
Existing service only; no secret values in terminal; rollback to dual on failure.
Source/runtime preflight pinned to ed0af597f525ce2295593d352530665ab4b38674.
"""
import http.client
import json
import os
import pathlib
import re
import subprocess
import sys
import time

SERVICE="alpha-realtime-production-readonly.service"
BASE=pathlib.Path("/opt/wave-alpha/alpha-realtime")
RELEASE=BASE/"releases/ed0af597f525ce2295593d352530665ab4b38674"
DIR=pathlib.Path("/etc/systemd/system")/(SERVICE+".d")
DROP=DIR/"zzzz-wa-alpha-read-key-primary.conf"
NEXT=pathlib.Path("/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT")
ACTIVE=pathlib.Path("/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_WA20261024")
RUNTIME=pathlib.Path("/run/credentials")/SERVICE
ORIGINAL={
 "R2_READ_ONLY_ACCESS_KEY_ID":"/run/wave-alpha-alpha/credentials/R2_READ_ONLY_ACCESS_KEY_ID",
 "R2_READ_ONLY_SECRET_ACCESS_KEY":"/run/wave-alpha-alpha/credentials/R2_READ_ONLY_SECRET_ACCESS_KEY",
 "SUPABASE_ANON_KEY":"/run/wave-alpha-alpha/credentials/SUPABASE_ANON_KEY",
 "PRODUCTION_READ_API_SECRET_KEY":"/run/wave-alpha-alpha/credentials/PRODUCTION_READ_API_SECRET_KEY",
 "ALPHA_LIVE_PUBLISH_KEY":"/run/wave-alpha-alpha/credentials/ALPHA_LIVE_PUBLISH_KEY",
}
NEW_PLAIN={k:v for k,v in ORIGINAL.items() if k!="PRODUCTION_READ_API_SECRET_KEY"}
NEW_ENCRYPTED={"PRODUCTION_READ_API_SECRET_KEY":str(ACTIVE)}
OLD_ENCRYPTED={"PRODUCTION_READ_API_SECRET_KEY_NEXT":str(NEXT)}
written_drop=False
restart_attempted=False
phase="PREFLIGHT"
old=""
new=""
print("WA_ALPHA_PRIMARY_RETIRE_BEGIN",flush=True)

def cmd(*args, input_bytes=None, timeout=65):
 p=subprocess.run(args, input=input_bytes, capture_output=True,timeout=timeout)
 if p.returncode!=0: raise RuntimeError("command_failed_"+str(args[0]))
 return p.stdout.decode("utf-8","strict").strip()

def require(flag,name):
 if not flag: raise RuntimeError(name)

# systemd config_parse_load_credential stores both LoadCredential and
# LoadCredentialEncrypted in ONE hashmap; either empty reset clears BOTH.
def credentials():
 plain={}; encrypted={}
 output=cmd("systemctl","cat","--no-pager",SERVICE)
 for line in output.splitlines():
  line=line.strip()
  if line.startswith("LoadCredential="):
   value=line.split("=",1)[1]
   if not value: plain.clear(); encrypted.clear(); continue
   name,sep,path=value.partition(":")
   require(bool(sep) and name not in plain and name not in encrypted,"duplicate_or_invalid_plain")
   plain[name]=path
  elif line.startswith("LoadCredentialEncrypted="):
   value=line.split("=",1)[1]
   if not value: plain.clear(); encrypted.clear(); continue
   name,sep,path=value.partition(":")
   require(bool(sep) and name not in plain and name not in encrypted,"duplicate_or_invalid_encrypted")
   encrypted[name]=path
 return plain,encrypted

def http_get(path,key=None):
 c=http.client.HTTPConnection("127.0.0.1",3100,timeout=8)
 try:
  c.request("GET",path,headers={"x-api-key":key} if key is not None else {})
  r=c.getresponse()
  return r.status,r.read(8000001)
 finally:
  c.close()

def valid_api(key):
 s,body=http_get("/api/token-list",key)
 if s!=200 or len(body)>3000000: return False
 doc=json.loads(body)
 return doc.get("success") is True and isinstance(doc.get("data"),list) and len(doc["data"])>0

def health_ready():
 return cmd("systemctl","is-active",SERVICE)=="active" and http_get("/health")[0]==200

def runtime_valid(expect_old,previous_pid=None):
 if not health_ready():return False
 if pathlib.Path(cmd("readlink","-f",str(BASE/"current")))!=RELEASE:return False
 pid=cmd("systemctl","show","-P","MainPID",SERVICE)
 if not pid.isdigit() or int(pid)<1 or (previous_pid is not None and pid==previous_pid):return False
 if not valid_api(new):return False
 if http_get("/api/token-list",old)[0]!=(200 if expect_old else 401):return False
 if http_get("/api/token-list","invalid-synthetic-retirement")[0]!=401:return False
 if http_get("/api/token-list")[0]!=401:return False
 if not expect_old:
  if (RUNTIME/"PRODUCTION_READ_API_SECRET_KEY_NEXT").exists():return False
  if (RUNTIME/"PRODUCTION_READ_API_SECRET_KEY").read_text().rstrip("\n")!=new:return False
  status,body=http_get("/api/market-data",new)
  if status!=200 or json.loads(body).get("success") is not True:return False
  status,body=http_get("/api/alpha-node?limit=1",new)
  if status!=200 or json.loads(body).get("schemaVersion")!=1:return False
 return True

def await_ready(expect_old,previous_pid=None):
 for _ in range(31):
  try:
   if runtime_valid(expect_old,previous_pid): return True
  except Exception:pass
  time.sleep(6)
 return False

try:
 require(os.geteuid()==0,"not_root")
 require(cmd("hostname","-s")=="micro-server-auto-2","wrong_vm")
 require(pathlib.Path(cmd("readlink","-f",str(BASE/"current")))==RELEASE,"source_drift")
 require(cmd("systemctl","is-active",SERVICE)=="active","service_not_active")
 require(cmd("systemctl","show","-P","User",SERVICE)=="wavealpha-alpha","service_user_drift")
 require(cmd("systemctl","show","-P","NeedDaemonReload",SERVICE)=="no","daemon_reload_pending")
 require(cmd("systemctl","show","-P","Restart",SERVICE)=="no","restart_policy_drift")
 require(not DROP.exists() and not DROP.is_symlink(),"dropin_exists")
 require(not ACTIVE.exists() and not ACTIVE.is_symlink(),"active_cipher_exists")
 require(DIR.is_dir() and not DIR.is_symlink(),"dropin_directory_invalid")
 require(NEXT.is_file() and not NEXT.is_symlink() and NEXT.stat().st_uid==0 and NEXT.stat().st_mode&0o077==0,"next_cipher_invalid")
 for name,path in ORIGINAL.items():
  f=pathlib.Path(path)
  require(f.is_file() and f.stat().st_uid==0,"source_credential_"+name+"_invalid")
 plain,encrypted=credentials()
 require(plain==ORIGINAL and encrypted==OLD_ENCRYPTED,"effective_mapping_drift")
 require(all((RUNTIME/name).is_file() for name in ORIGINAL),"loaded_credentials_missing")
 require((RUNTIME/"PRODUCTION_READ_API_SECRET_KEY_NEXT").is_file(),"loaded_next_missing")
 old=(RUNTIME/"PRODUCTION_READ_API_SECRET_KEY").read_text().rstrip("\n")
 new=cmd("systemd-creds","decrypt","--name=PRODUCTION_READ_API_SECRET_KEY_NEXT",str(NEXT),"-",timeout=20)
 require(bool(old) and bool(re.fullmatch("[0-9a-f]{64}",new)) and old!=new,"key_material_invalid")
 require((RUNTIME/"PRODUCTION_READ_API_SECRET_KEY_NEXT").read_text().rstrip("\n")==new,"loaded_next_mismatch")
 require(valid_api(old) and valid_api(new),"dual_baseline_bad")
 require(http_get("/api/token-list","invalid-synthetic-retirement")[0]==401 and http_get("/api/token-list")[0]==401,"baseline_failclosed_bad")
 oldpid=cmd("systemctl","show","-P","MainPID",SERVICE)
 require(oldpid.isdigit() and int(oldpid)>0,"pid_invalid")
 print("PREFLIGHT=PASS_DUAL_AND_EXACT_SIX_MAPPINGS",flush=True)
 phase="RE_ENCRYPT_ACTIVE"
 os.umask(0o077)
 enc=subprocess.run(["systemd-creds","encrypt","--name=PRODUCTION_READ_API_SECRET_KEY","-",str(ACTIVE)],input=new.encode(),capture_output=True,timeout=30)
 require(enc.returncode==0,"active_encrypt_failed")
 os.chown(ACTIVE,0,0)
 os.chmod(ACTIVE,0o600)
 check=cmd("systemd-creds","decrypt","--name=PRODUCTION_READ_API_SECRET_KEY",str(ACTIVE),"-",timeout=20)
 require(check==new,"active_cipher_validation_failed")
 phase="DROPIN"
 settings=["[Service]","LoadCredential="]
 settings += ["LoadCredential="+n+":"+p for n,p in NEW_PLAIN.items()]
 settings += ["LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY:"+str(ACTIVE)]
 fd=os.open(str(DROP),os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 written_drop=True
 with os.fdopen(fd,"w") as f:
  f.write("\n".join(settings)+"\n")
 cmd("systemctl","daemon-reload")
 require(cmd("systemctl","show","-P","NeedDaemonReload",SERVICE)=="no","new_unit_reload_pending")
 plain,encrypted=credentials()
 require(plain==NEW_PLAIN and encrypted==NEW_ENCRYPTED,"effective_new_mapping_invalid")
 phase="RESTART"
 restart_attempted=True
 cmd("systemctl","restart",SERVICE,timeout=80)
 phase="POSTCHECK"
 require(await_ready(False,oldpid),"new_only_semantic_failed")
 print("NEW_KEY=ACCEPTED",flush=True)
 print("OLD_KEY=REJECTED_401",flush=True)
 print("ANONYMOUS_INVALID=REJECTED_401",flush=True)
 print("TOKEN_MARKET_ALPHA_NODE=PASS",flush=True)
 print("EFFECTIVE_CREDENTIALS=FIVE_NO_NEXT",flush=True)
 print("OLD_SOURCE_FILE=RETAINED_FOR_ROLLBACK_PENDING_FINAL_CLEANUP",flush=True)
 print("ORACLE_PRIMARY_RETIRE=PASS_LOCAL_RUNTIME",flush=True)
 print("WA_ALPHA_PRIMARY_RETIRE_RC=0",flush=True)
 print("WA_ALPHA_PRIMARY_RETIRE_END",flush=True)
 sys.exit(0)
except Exception as ex:
 print("GATE=HOLD_"+phase+"_"+type(ex).__name__,flush=True)
 if not written_drop:
  if ACTIVE.is_file() and not ACTIVE.is_symlink():
   try: ACTIVE.unlink()
   except Exception:pass
  print("SERVICE_MUTATION=NONE",flush=True)
  rc=10
 else:
  try:
   DROP.unlink()
   cmd("systemctl","daemon-reload")
   plain,encrypted=credentials()
   require(plain==ORIGINAL and encrypted==OLD_ENCRYPTED,"rollback_mapping_invalid")
   if restart_attempted:
    cmd("systemctl","restart",SERVICE,timeout=80)
    require(await_ready(True),"rollback_runtime_failed")
   else:
    require(runtime_valid(True),"unchanged_runtime_bad")
   if ACTIVE.is_file() and not ACTIVE.is_symlink(): ACTIVE.unlink()
   print("ROLLBACK=PASS_DUAL_RESTORED",flush=True)
   rc=13
  except Exception:
   print("ROLLBACK=HOLD_RECONCILE_READ_ONLY",flush=True)
   rc=14
 print("WA_ALPHA_PRIMARY_RETIRE_RC="+str(rc),flush=True)
 print("WA_ALPHA_PRIMARY_RETIRE_END",flush=True)
 sys.exit(rc)
