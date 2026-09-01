# MASTER HANDOFF — Alpha Realtime Render -> Oracle E2 Migration

Checkpoint: **2026-09-01 after Phase 2B closeout**

Repository: `annachou5566/alpha-realtime-bot`

Overall Wave Alpha system authority remains `annachou5566/wave-alpha@test-wavealpha`. This document is the current handoff for the Alpha Realtime Bot migration task only. Fresh GitHub/runtime evidence always overrides this file if newer.

## 1. Mandatory bootstrap for the next chat

Before proposing or executing engineering/ops work:

1. Read `wave-alpha/README.md` on `test-klinechart`.
2. Fresh-verify Wave Alpha heads: `test-wavealpha`, `test-klinechart`, `chatgpt/final-liquidation-stack-2026-08-11`, `main`, `staging-wavealpha`, plus current Alpha task/runtime refs.
3. Read current Wave Alpha rules/runbooks relevant to the task: `PROJECT_OPERATING_RULES.md`, `PROPRIETARY_DATA_SECURITY_POLICY.md`, `SECURITY_ARCHITECTURE_HANDBOOK.md`, `CHATGPT_HANDOFF.md`, `TEST_EXECUTION_POLICY.md`, `FREE_TIER_EXECUTION_POLICY.md`, `docs/operations/TERMUX_DIRECT_ORACLE_VM_RUNBOOK.md`, and `CLOUDFLARE_DEPLOYMENT_RUNBOOK.md` before Cloudflare work.
4. Read this repository's `README.md`, `ORACLE_E2_MIGRATION_PHASE1.md`, `ORACLE_E2_MIGRATION_PHASE2.md`, `ORACLE_E2_MIGRATION_PHASE2B.md`, this handoff, and `ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md`.
5. Read metadata for the current Alpha PR stack and public CI. Do not infer a current SHA from this handoff without fresh verification.
6. Reconstruct current Render/Oracle/Cloudflare state read-only before any mutation.
7. Never ask the owner to repeat something that GitHub/runtime can verify safely.

## 2. Hard operating boundaries

- Reply mainly in Vietnamese, short/concrete, prioritize next best action.
- `wave-alpha/test-wavealpha` is overall system authority.
- Never mutate `main` without explicit owner approval.
- Free / Always Free only; no paid fallback, overage or paid key/vault option.
- Oracle capacity target is `VM.Standard.E2.1.Micro`.
- Current operator path: Android Termux -> Debian via `proot-distro` -> direct SSH -> Oracle.
- Do not route current work through Oracle/Google Cloud Shell unless owner explicitly re-enables it.
- Remote Oracle interactive blocks start with:

```bash
export USER="${USER:-$(id -un)}"
set -Eeuo pipefail
```

- Avoid Bash process substitution in Termux/proot; prefer temp files.
- Avoid giant fragile heredocs, multiline quoted SSH, unbounded logs/scans, and blind retries.
- A command is complete only after a fresh prompt returns.
- Production deploy/cutover, restart/enable, Production credentials, writer activation, Render mutation, Tunnel/DNS/route, database/R2/Supabase mutation, and `main` mutation each require explicit owner approval for that exact operation.
- Source PASS != runtime PASS != Production PASS != Security PASS.
- Missing/unavailable is not zero.
- One consequential mutation at a time: precheck -> mutation -> independent postcheck.
- On nonzero create/delete result: do not blindly retry; first inspect actual state because the mutation may have succeeded while waiter/output failed.
- Never print or paste token values, secret plaintext, API private keys, full OCI config, `.env`, or Production credentials. Minimize printing resource OCIDs when a name lookup/temp file is sufficient.

## 3. Architecture invariant

Hard upstream egress rule:

```text
exchange API
  -> approved normal server egress (Render current / qualified Oracle)
  -> normalize/aggregate/protected storage/API
  -> Cloudflare security/cache/delivery
  -> browser
```

Forbidden:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare Tunnel is downstream ingress from Cloudflare to Oracle. It must never become the Binance/exchange upstream caller.

Browser-direct realtime price streams such as Binance WebSocket stay browser-direct; do not turn the E2 Micro into a realtime fanout service.

Architecture direction:

```text
COMPUTE ONCE -> STORE ONCE -> AUTHORIZE EARLY -> CACHE SAFELY -> DISTRIBUTE AT EDGE
```

R2 is derivative projection/distribution, not the canonical database/archive owner. Existing Supabase canonical ownership remains where established.

## 4. Migration progress

```text
Phase 1   CLOSED / PASS
Phase 2A  CLOSED / PASS
Phase 2B  CLOSED / PASS
Phase 3   NOT STARTED — owner approval required before mutation
Phase 4   NOT STARTED — multiple Production approval gates
Phase 5   NOT STARTED — only after successful cutover
```

Approximate overall migration progress after Phase 2B: **~88%**.

Do not inflate progress and do not label Production/Security PASS prematurely.

## 5. Current Oracle candidate

Resolve exact runtime identity fresh, but expected candidate is:

```text
name: micro-server-auto-2
shape: VM.Standard.E2.1.Micro
region: ap-singapore-1
OS: Ubuntu 24.04 Minimal
Alpha qualification service: alpha-realtime-qualification.service
expected current state: inactive
expected port 3100: NONE
```

Existing `micro-server-auto` is the Liquidation VM and is out of scope for this Alpha migration.

Persistent Phase 2A layout:

```text
/opt/wave-alpha/node/
/opt/wave-alpha/alpha-realtime/releases/<approved-sha>/
/opt/wave-alpha/alpha-realtime/current
/opt/wave-alpha/oci-cli/current
system user: wavealpha-alpha
systemd: alpha-realtime-qualification.service
```

The service is qualification-only and must not be started/enabled without a separately approved operation.

## 6. Phase 1 closeout

Phase 1 source branch/PR established bounded qualification mode and proved:

- exact Node/lockfile path;
- live Binance server egress from Oracle without 403/418/429 in the bounded trial;
- R2 read PASS;
- Supabase anon read PASS;
- loopback-only bind `127.0.0.1`;
- unauth protected endpoint = 401;
- qualified market endpoint = 200 with non-empty data;
- no observed R2 writer bytes;
- memory safely bounded;
- cleanup PASS.

Phase 1 did not imply Production/Security PASS.

## 7. Phase 2A closeout

Persistent qualification candidate was installed and runtime-qualified:

- Node 22 under `/opt/wave-alpha/node`;
- immutable release under `/opt/wave-alpha/alpha-realtime/releases/...`;
- dedicated non-login `wavealpha-alpha` user;
- `alpha-realtime-qualification.service` static/manual only;
- loopback `127.0.0.1:3100` only during approved qualification window;
- MemoryMax 384M;
- health 200, unauth 401, auth market 200;
- live Binance upstream PASS;
- R2/Supabase read-only PASS;
- no observed writer/finalize mutation path;
- service stopped and runtime credentials cleaned after trial.

Do not rerun Phase 2A without a concrete invalidator.

## 8. Phase 2B closeout — 100% PASS

Phase 2B proved the OCI-native persistent secret path with a random qualification marker only.

### 8.1 Operator and VM auth

- local operator profile classified as OCI CLI `SECURITY_TOKEN` auth;
- local session expired once and was reauthenticated interactively;
- no operator API private key/config was copied to the VM;
- OCI CLI local version observed during final work: 3.90.3;
- isolated remote OCI CLI path uses version 3.90.0 under `/opt/wave-alpha/oci-cli/current`;
- VM `--auth instance_principal` signer proof PASS.

### 8.2 Free-tier evidence

Runtime limit discovery identified:

```text
service kms
  virtual-vault-count = 1
  virtual-vault-softwarekeyversion-count = 20
  virtual-private-vault-count = 0

service secrets
  max-secrets-per-tenancy-count = 150
```

Before creation:

```text
virtual-vault-count used=0 available=1
secrets used=0 available=150
```

`resource-availability` did not return numeric used/available for the software-key-version limit; this was **not** interpreted as zero. Capacity was instead proven from the configured Free limit plus exact current key count in the new Vault.

### 8.3 Vault/key

Created/reviewed qualification infrastructure:

```text
Vault display name: wa-alpha-phase2b-qualification-2026-09-01
Vault type: DEFAULT
Vault lifecycle: ACTIVE

Key display name: wa-alpha-phase2b-qualification-key-2026-09-01
Key shape: AES 32 bytes
Protection mode: SOFTWARE
Key lifecycle: ENABLED
```

Do not create a `VIRTUAL_PRIVATE` vault or HSM/paid key path for this migration.

### 8.4 Dynamic Group

Retained Dynamic Group:

```text
name: wa-alpha-phase2b-micro-server-auto-2
state: ACTIVE
semantic rule: instance.id equals the exact micro-server-auto-2 instance OCID
```

OCI normalized the matching-rule representation, so final verification was semantic rather than byte-for-byte.

### 8.5 Qualification secret and policy

Qualification secret name:

```text
wa-alpha-phase2b-qualification-secret-2026-09-01
```

It contained only 32 random bytes. Plaintext existed only in tmpfs/bounded process memory and was never printed.

The temporary IAM policy was:

```text
Allow dynamic-group wa-alpha-phase2b-micro-server-auto-2
  to read secret-bundles in tenancy
  where target.secret.id='<qualification-secret-ocid>'
```

The exact-secret policy was deleted at closeout and independently verified absent.

The qualification secret is now `PENDING_DELETION` with a deletion timestamp present. Do not cancel deletion unless the owner explicitly requests it.

### 8.6 Runtime secret proof

Source-reviewed script:

```text
scripts/oracle-vault-secret-read-probe.sh
```

The exact source blob was verified locally, copied to the VM, remote SHA-256 matched, then executed with:

```text
--auth instance_principal
--stage CURRENT
```

Final proof:

```text
SERVICE_STATE_BEFORE=inactive
PORT_BEFORE=NONE
OCI_SECRET_READ_RC=0
SECRET_SHA256_MATCH=YES
SERVICE_STATE_AFTER=inactive
PORT_AFTER=NONE
INSTANCE_PRINCIPAL_AUTH=PASS
VAULT_SECRET_READ=PASS
SECRET_PLAINTEXT_PRINTED=NO
PRODUCTION_CREDENTIAL_USED=NO
PROBE_MUTATION=NO
VM_PROBE_SSH_RC=0
REMOTE_PROBE_SCRIPT_CLEANUP=PASS
LOCAL_PROBE_MATERIAL_CLEANUP=PASS
```

This is runtime qualification PASS only.

### 8.7 Retained after Phase 2B

Retain until later reviewed decision:

- Free-compatible DEFAULT Vault;
- SOFTWARE-protected key;
- exact-instance Dynamic Group.

Removed/retiring:

- exact-secret qualification policy: deleted/verified absent;
- qualification marker secret: `PENDING_DELETION`;
- local/remote marker/probe material: cleaned.

## 9. OCI CLI bootstrap incident and permanent lesson

The first OCI CLI bootstrap design used Oracle's official installer. It unexpectedly:

1. ran `apt-get update` / `apt-get install python3-venv -y`, violating the intended no-apt/no-global-package design;
2. failed with `shutil.SameFileError` because the configured exec directory collided with the installer's own source path.

System packages changed during that failed attempt. They were not rolled back/downgraded because rollback would be another risky mutation and the resulting packages were normal Ubuntu updates.

Corrected design that PASSed:

- no official installer;
- direct isolated `python3 -m venv` under `/opt/wave-alpha/oci-cli/releases/3.90.0`;
- pinned Python packages installed as binary wheels with `--no-deps`;
- `pip check` PASS;
- import gate PASS;
- exact OCI CLI version gate PASS;
- `current` symlink;
- no system PATH change;
- no apt on corrected retry;
- service remained inactive/port absent.

Do not reuse the failed official-installer design.

## 10. Known diagnostic traps and fixes

### Root compartment

If IMDS returns an `ocid1.tenancy...` for `compartmentId`, that can be valid: tenancy is the root compartment. Accept either `ocid1.compartment.*` or `ocid1.tenancy.*` after confirming identity.

### OCI CLI lists returning nothing

Observed behavior:

```text
RC=0
stdout bytes=0
stderr bytes=0
```

for some KMS/IAM list commands. Never conclude resource count = 0 from empty output.

Fix: use signed `oci raw-request` to the official OCI REST endpoint, then parse:

- `status` must be 200;
- `data` must have the expected JSON type;
- inspect `opc-next-page` before claiming exhaustive count.

### JMESPath/raw-output emptiness

`--query ... --raw-output` can produce an empty string for some list responses. Capture raw JSON first and parse with Python for acceptance gates.

### Dynamic Group rule formatting

OCI may normalize quotes/whitespace. Verify one-instance semantics rather than literal source-string equality.

### Secret deletion timing

A `+1 day` schedule request returned runtime `400 InvalidParameter` / `ScheduledTimeOfDeletion is in invalid range`.

A `+8 days` request was accepted. Runtime then showed:

```text
SCHEDULING_DELETION
-> PENDING_DELETION
```

Do not retry while `SCHEDULING_DELETION`; poll metadata read-only.

### Termux/proot shell behavior

Avoid process substitution `<(...)`. Prefer named temp files. The user also prefers each command block to state explicitly: **copy from first line X to last line Y**.

### Output/security hygiene

- print status, RC, hashes, counts, lifecycle states;
- do not print secret plaintext/token/private key/full config;
- minimize resource OCID display;
- prefer resolving resource IDs by exact name into a mode-600 temp file;
- cleanup tmpfs/temp files and unset sensitive environment values.

## 11. Current Render baseline — must fresh verify before use

Historically/current-at-last-check:

```text
service: alpha-realtime
plan: Free
region: Singapore
source branch: main
state: suspended by user
```

Do not assume this state remains true. Fresh-read Render before Phase 4. No Render mutation occurred during Phases 1/2A/2B.

## 12. Cloudflare baseline — must fresh verify before Phase 3

Do not reuse old quota/auth evidence for a new mutation. Before any Phase 3 Cloudflare mutation:

1. read current `CLOUDFLARE_DEPLOYMENT_RUNBOOK.md`;
2. verify Free headroom fresh;
3. verify operator auth using an official read-only endpoint;
4. verify exact account identity;
5. inspect existing Tunnel/DNS/Access resources for collisions;
6. only then perform the exact approved mutation;
7. postcheck resource state and cost/free-tier class.

Never expose Cloudflare token values. A token ever pasted/exposed must be treated as compromised and rotated/revoked.

## 13. Remaining phases

The detailed review-first proposal lives in:

```text
ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md
```

Summary:

- Phase 3: Cloudflare Tunnel/private ingress qualification only, no Production credential/cutover.
- Phase 4: Production credential gate + single-writer Render -> Oracle cutover, split into separately approved operations.
- Phase 5: observation, rollback proof, old credential/service retirement decisions and final documentation.

## 14. Approval model for next chat

The next chat must **first inspect current truth and produce a detailed final execution plan**, then stop. No mutation before the owner reviews that plan and explicitly approves the exact Phase 3 operation.

The plan must list:

- exact read-only prechecks;
- exact resources to create/reuse;
- Free-tier proof;
- secrets policy;
- rollback/cleanup;
- PASS/FAIL gates;
- what requires separate approval;
- what is explicitly excluded;
- estimated progress change;
- next best action.

## 15. End-of-task reporting format

Every technical closeout should end with:

```text
STATUS:
REMAINING RISK:
NEXT BEST ACTION:
```

Do not claim Production PASS or Security PASS unless those exact gates are separately completed and evidenced.
