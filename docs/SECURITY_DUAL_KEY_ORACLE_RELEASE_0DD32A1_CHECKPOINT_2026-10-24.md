# Oracle Alpha reader: actual deployed base 0dd32a1 / opt-in credential overlap

## NEWEST RUNTIME CONTINUITY EVIDENCE — OWNER READ-ONLY SYSTEMD CHECK, 2026-10-24

Owner checked the correct Alpha VM `micro-server-auto-2` and returned exactly:
- `MainPID=481479`, `ActiveState=active`, `TasksCurrent=11`.
- `MemoryCurrent=152666112` bytes (~145.6 MiB); `MemoryMax=402653184` bytes (384 MiB).
- Host `MEM_TOTAL_MB=954`, `MEM_AVAILABLE_MB=389` at observation time.
- `CanReload=no`, `NeedDaemonReload=no`.
- `STANDBY_CREDENTIAL_DECLARED=NO`.
These are point-in-time capacity facts, NOT reserved spare capacity or permission to launch parallel processes. No file, key, PID or service was modified during the observation.

Connected Cloudflare read-only postcheck: Production Pages canonical deployment remains `5856b266-0194-42a5-a777-a5e2b4ecdd91`; `ALPHA_BACKEND` relay `wave-alpha-alpha-backend-relay` has exactly one `ALPHA_ORIGIN` VPC service binding to service ID `01a0604c-6cf5-7c12-8d02-c3b726c99c1c`; registry lists one HTTP service named `wa-alpha-alpha-backend-vpc-4d2a`. A single registry service does not by itself prove how many backend instances exist, but gives NO VERIFIED blue/green failover path.

**HARD HOLD on live Oracle or Pages credential cutover:** no hot-reload; no staged LoadCredential; no proven zero-disruption alternate. Never restart `alpha-realtime-production-readonly.service`, run stopped-service Vault materializer, add another realtime/subscriber/poller/writer, promote this branch to main, swap Production Pages `RENDER_API_KEY`, or revoke the old API verifier from this evidence. The 389 MB currently available might fit additional code in a laboratory but is insufficient PROOF of reliable parallel production cutover, particularly with live listener and single-owner side effects. Neither Alpha security credential nor other four compromised fields are rotated. Security PASS cannot be declared.

Continue with offline native integrated tests for the rebased source only, plus independent review of whether an infrastructure-supported no-restart verifier reconfiguration or a *strictly read-only, subscriber-disabled* blue/green backend is feasible under verified Always Free limits. Any future mutation requires exact resource/release scope and independent no-disruption validation. If one cannot prove continuity, preserve service and surface the blocker; do not create a counterfeit security completion.

2026-10-24. SOURCE CANDIDATE ONLY. Do not deploy, restart service, change secrets or block Chart/Workspace Save.

## Runtime evidence supplied by owner; read-only and independently reconciled against GitHub
- Alpha VM: ubuntu@micro-server-auto-2, the VM with IP 161.118.219.31; do not touch the separate Liquidity VM.
- Existing unit alpha-realtime-production-readonly.service ACTIVE, MainPID present, one listener on 3100.
- /opt/wave-alpha/alpha-realtime/current resolves to /opt/wave-alpha/alpha-realtime/releases/0dd32a1f2faa869eba400736571e0d549205e4c8.
- Owner-calculated exact Git Blob SHA values MATCH GitHub commit annachou5566/alpha-realtime-bot@0dd32a1f2faa869eba400736571e0d549205e4c8 for index.js (eb74b93867da2d067418c2cac889cb9e75e2031c), lib/production-readonly-mode.js (237e41cb852025559ac9f03f999e0e1f6db628af), and scripts/oracle-production-readonly-launch.sh (b83f770a7faa67b641451253e0c27d15d7f19f8b).
- PROCESS_CWD=UNAVAILABLE (cannot read /proc/<pid>/cwd from current operator permission) does NOT imply Production failure; symlink+three blob matches and active service/port are stronger scoped evidence. Does not prove all other running runtime files or systemd drop-ins match pinned source.

## New, exact-base candidate branch
- Base: 0dd32a1f2faa869eba400736571e0d549205e4c8, NOT retired 6a602b1d. New isolated branch chatgpt/alpha-read-key-overlap-0dd32a1-20261024.
- Keep all 0dd Alpha Node RPC read-only/other fixes and the 23 source runtime hardening transforms; index.js only updates one authentication conditional and imports new helper.
- New lib/readonly-api-auth.js: bounded SHA-256 digest timingSafeEqual, preserves old identity when standby absent; accepts both old/new only when an explicitly provided distinct standby is present; bad/missing/malformed keys 401.
- Readonly-mode maps PRODUCTION_READ_API_SECRET_KEY_NEXT to API_SECRET_KEY_NEXT only if explicitly defined, nonempty, distinct, and no inherited API_SECRET_KEY_NEXT existed; preserves canonical writer denylist.
- Startup script optionally sources a second protected file from systemd CREDENTIALS_DIRECTORY and rejects inherited standby values, including empty; default absent key maintains legacy auth.
- No Production secrets, no real tests using exposed secret, no changes to Cron, DB, Supabase, Liquidation or Alpha publisher.
- New test/readonly-api-auth.test.js (reused old exact blob), test/readonly-api-auth-middleware.test.js, additive tests on original release-0dd test/production-readonly-mode.test.js.

## Validation — source only
- GitHub Blob identities for three Oracle files 3/3 match live operator log, before patch.
- Rebased actual index middleware V8 isolated requests 12/12 PASS with synthetic values, checking current/new/unknown/malformed/OPTIONS/health/after-cutover.
- Exact 0dd readonly environment source V8 checks 7/7 PASS: absent/dual/empty/duplicate/inherited standby, preserves ALPHA_NODE_READ_RPC_PATH and S3 guards.
- Rebased 0dd Oracle read-only startup source transformation pipeline: 23/23 unique transforms applied, transformed full JavaScript syntax PASS. Retained helper old blob is previously qualified separately at Node22 5/5; do not call this new candidate's complete native npm suite PASS because it has not run.

## Critical HARD HOLD: source-only dual acceptance is NOT zero-downtime deployment
The tracked release 0dd systemd unit deploy/oracle/alpha-realtime-production-readonly.service uses Type=simple, Restart=no and has no ExecReload, no socket-activation, and LoadCredential lists only FOUR credentials, excluding PRODUCTION_READ_API_SECRET_KEY_NEXT. This is source metadata only, not a claim that actual loaded unit/drop-ins are identical. A plain release switch/restart would risk interrupting current Alpha reads; existing stopped-service vault materializer explicitly refuses live service/port.
Before mutation, read-only qualify actual systemd CanReload, loaded credential-name metadata without secret values, listener route, CPU/RAM/free-tier headroom and whether safe parallel read-only instance or zero-loss hot-reload exists. If not proven, do not enable standby or change Pages's historical RENDER_API_KEY key. Do NOT install a second collector/writer/poller, use paid resources or revocate old verifier trust early. A new systemd LoadCredential entry for the standby would itself require an approved safe unit rollout and existing protected file. Never paste secrets into chat/shell/history/log/SQL/Git.

## Other incident tasks and Chart return
SUPABASE_JWT_SECRET needs signing key authority + legacy HS256 consumer migration; LIQ_INGEST_TOKEN, CMC_API_KEY and WAVE_API_SECRET need their own provider/consumer inventory and independently verified safe overlap. NONE rotated yet. Production Chart/Save MUST remain active. Return to Chart Q2/H0–H12 only after security trust closure, preserving A0/Q0/S0/Q1 PASS and QA freeze evidence; no C0.
STATUS: Three live Alpha blobs IDENTIFIED; exact-release security source staged, NOT deployed.
REMAINING RISK: Five exposed keys remain valid; actual no-outage Alpha rollout/credential stage unqualified.
NEXT BEST ACTION: One bounded read-only actual systemd/host headroom check, then choose provably safe cutover or HOLD.
