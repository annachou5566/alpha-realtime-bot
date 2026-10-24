#!/usr/bin/env python3
# Alpha Oracle one-service credential-overlap activation; no key values in output.
# Immutable deployed source ed0af597f525ce2295593d352530665ab4b38674.
import http.client, json, os, pathlib, re, subprocess, sys, time

print('WA_ALPHA_DUAL_ACTIVATE_BEGIN', flush=True)
svc='alpha-realtime-production-readonly.service'
root=pathlib.Path('/opt/wave-alpha/alpha-realtime')
release=root/'releases/ed0af597f525ce2295593d352530665ab4b38674'
secret=pathlib.Path('/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT')
drop=pathlib.Path('/etc/systemd/system/alpha-realtime-production-readonly.service.d/60-wavealpha-api-next.conf')
added=False
restart_attempted=False
phase='PREFLIGHT'

def cmd(*args):
    p=subprocess.run(args, capture_output=True, timeout=75)
    if p.returncode: raise RuntimeError('command_failed_'+args[0])
    return p.stdout.decode().strip()

def check(ok, name):
    if not ok: raise RuntimeError(name)

def req(path, key=None):
    c=http.client.HTTPConnection('127.0.0.1',3100,timeout=8)
    try:
        c.request('GET',path,headers={'x-api-key':key} if key is not None else {})
        r=c.getresponse()
        return r.status,r.read(8000001)
    finally: c.close()

def token_count(key):
    status,data=req('/api/token-list',key)
    if status!=200: return 0
    body=json.loads(data)
    return len(body['data']) if body.get('success') is True and isinstance(body.get('data'),list) else 0

def live_state():
    return cmd('systemctl','is-active',svc)=='active' and cmd('systemctl','show','-P','MainPID',svc).isdigit()

try:
    check(cmd('hostname','-s')=='micro-server-auto-2','host_mismatch')
    check(pathlib.Path(cmd('readlink','-f',str(root/'current')))==release,'release_mismatch')
    check(live_state(),'service_inactive')
    check(cmd('systemctl','show','-P','NeedDaemonReload',svc)=='no','daemon_reload_pending')
    unit=cmd('systemctl','cat','--no-pager',svc)
    check('PRODUCTION_READ_API_SECRET_KEY_NEXT' not in unit,'next_already_in_unit')
    check('LoadCredential=PRODUCTION_READ_API_SECRET_KEY:' in unit,'active_credential_missing')
    check(secret.is_file() and not secret.is_symlink() and secret.stat().st_uid==0 and (secret.stat().st_mode & 0o077)==0,'encrypted_next_invalid')
    check(not drop.parent.is_symlink() and not drop.exists() and not drop.is_symlink(),'dropin_collision')
    old=(pathlib.Path('/run/credentials')/svc/'PRODUCTION_READ_API_SECRET_KEY').read_text().rstrip('\n')
    nextkey=cmd('systemd-creds','decrypt',str(secret),'-')
    check(bool(old) and bool(re.fullmatch('[0-9a-f]{64}',nextkey)) and old!=nextkey,'key_material_invalid')
    check(req('/health')[0]==200 and req('/api/token-list')[0]==401 and req('/api/token-list','invalid-synthetic-next-gate')[0]==401,'baseline_auth_failed')
    check(token_count(old)>0 and req('/api/token-list',nextkey)[0]==401,'baseline_key_state_failed')
    oldpid=cmd('systemctl','show','-P','MainPID',svc)
    print('PREFLIGHT=PASS_NEW_REJECTED_OLD_ACCEPTED',flush=True)
    phase='DROPIN'
    drop.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    fd=os.open(drop,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    added=True
    with os.fdopen(fd,'w') as f:
        f.write('[Service]\nLoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT:/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT\n')
    cmd('systemctl','daemon-reload')
    check('LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT:' in cmd('systemctl','cat','--no-pager',svc),'new_mapping_missing')
    phase='RESTART'
    restart_attempted=True
    cmd('systemctl','restart',svc)
    phase='DUAL_POSTCHECK'
    good=False
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        try:
            newpid=cmd('systemctl','show','-P','MainPID',svc)
            if live_state() and newpid!=oldpid and newpid.isdigit() and int(newpid)>0:
                if req('/health')[0]==200 and req('/api/token-list')[0]==401 and req('/api/token-list','invalid-synthetic-next-gate')[0]==401 and token_count(old)>0 and token_count(nextkey)>0:
                    ms,mb=req('/api/market-data',nextkey)
                    ns,nb=req('/api/alpha-node?limit=1',nextkey)
                    if ms==200 and json.loads(mb).get('success') is True and ns==200 and json.loads(nb).get('schemaVersion')==1:
                        good=True;break
        except (OSError,ValueError,KeyError,TimeoutError,RuntimeError,json.JSONDecodeError): pass
        time.sleep(6)
    check(good,'dual_runtime_not_ready')
    check(pathlib.Path(cmd('readlink','-f',str(root/'current')))==release,'release_changed')
    print('DUAL_AUTH=PASS_OLD_AND_NEW_ACCEPTED_BAD_REJECTED',flush=True)
    print('MARKET_ALPHA_NODE=PASS',flush=True)
    print('ORACLE_NEXT=ACTIVE_ON_EXISTING_SERVICE',flush=True)
    print('PAGES_SECRET=UNCHANGED',flush=True)
    print('WA_ALPHA_DUAL_ACTIVATE_RC=0',flush=True)
    print('WA_ALPHA_DUAL_ACTIVATE_END',flush=True)
    sys.exit(0)
except Exception as e:
    print('GATE=HOLD_'+phase+'_'+type(e).__name__,flush=True)
    if not added:
        print('MUTATION=NONE',flush=True);rc=10
    else:
        try:
            drop.unlink(missing_ok=True)
            cmd('systemctl','daemon-reload')
            if restart_attempted: cmd('systemctl','restart',svc)
            check(live_state() and token_count(old)>0 and req('/api/token-list')[0]==401 and req('/api/token-list',nextkey)[0]==401,'recovery_auth_failed')
            print('RECOVERY=PASS_OLD_ONLY'+('_RESTARTED' if restart_attempted else '_UNINTERRUPTED'),flush=True)
            rc=13
        except Exception:
            print('RECOVERY=HOLD_RECONCILE_READ_ONLY',flush=True);rc=14
    print('WA_ALPHA_DUAL_ACTIVATE_RC='+str(rc),flush=True)
    print('WA_ALPHA_DUAL_ACTIVATE_END',flush=True)
    sys.exit(rc)
