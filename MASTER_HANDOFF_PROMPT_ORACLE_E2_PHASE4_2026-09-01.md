# MASTER HANDOFF — Oracle E2 Phase 4

Checkpoint: **2026-09-01 after Phase 3 CLOSED/PASS and Phase 4A source/static candidate**

Repository: `annachou5566/alpha-realtime-bot`

## Current exact source stack

```text
Phase 2B / PR #19 branch:
chatgpt/oracle-e2-vault-phase2b-2026-09-01
parent head: 43e576467a51b017c5fc37a8f8313bd23f197b41

Phase 4A / PR #20 branch:
chatgpt/oracle-e2-phase4a-production-readonly-2026-09-01
```

Fresh GitHub/runtime evidence always wins over SHA values in this handoff.

## Completed migration phases

```text
Phase 1   CLOSED / PASS
Phase 2A  CLOSED / PASS
Phase 2B  CLOSED / PASS
Phase 3   CLOSED / PASS
```

Do not rerun these merely because the chat changes. Reopen only with a concrete invalidator.

## Phase 3 actual architecture and retained state

Wave Alpha still has no custom domain. Phase 3 qualified:

```text
workers.dev qualification Worker
  -> Workers VPC Service
  -> retained Cloudflare Tunnel
  -> Oracle 127.0.0.1:3101 secretless responder
```

The initial VPC target `localhost:3101` produced concrete intermittent `[::1]:3101 connection refused` evidence. It was corrected to exact IPv4 `127.0.0.1:3101`, followed by 5/5 successful bounded trials.

Actual Worker metrics captured from Cloudflare Dashboard included 14 invocations, 0 errors and median CPU 1.06 ms for qualification version `6ff6f5a0-d07f-4351-9fd7-13d9626bdee6`.

Phase 3 cleanup removed the qualification Worker, VPC Service, responder, connector unit and runtime Tunnel token. Retain:

```text
Tunnel ID:      85317397-bd10-4a04-b980-ca344418ab74
Tunnel state:   dormant/down after connector stop
cloudflared:    pinned 2026.8.3 binary retained
Alpha service:  inactive
ports 3100/3101 absent
```

Read `ORACLE_E2_MIGRATION_PHASE3_CLOSEOUT_2026-09-01.md` for exact evidence.

## Phase 4A source truth

Raw `index.js` is **not safe to start with Production writer credentials**. It has no native `WAVE_CANONICAL_PUBLISH` enforcement and contains current writer surfaces:

```text
R2 PutObject constructors:    7
R2 DeleteObject constructors: 1
Supabase update:              1
```

Known trigger paths include startup historical refresh, competition price persistence, finalized-history writes, competition-live writes, tick-cache Put/Delete and admin backfill.

PR #20 adds a dedicated first-class `oracle-production-readonly.js` runtime with:

1. writer credentials unreachable;
2. only R2 read-only + Supabase anon + Production read API credentials accepted;
3. fail closed if inherited legacy writer-capable env names exist;
4. pre-network R2 and Supabase mutation guards with counters;
5. exact-anchor hardening of all reviewed writer/backfill/finalize/tick triggers;
6. `127.0.0.1` listener only;
7. protected write-safety telemetry.

Read `ORACLE_E2_MIGRATION_PHASE4A.md` before any Phase 4B/4C work.

## Absolute Phase 4 boundaries

### Phase 4B — non-writer Production read credentials

Separate explicit owner approval required.

May provision only credentials needed for the Production-shaped read candidate. Writer credential reachability is forbidden. Reuse retained Vault/key/Dynamic Group; do not recreate closed Phase 2B resources merely for reassurance.

### Phase 4C — Production-shaped read-only Oracle candidate

Separate explicit owner approval for manual service start and any Cloudflare connector/VPC/private relay activation required for the runtime proof.

Required properties:

```text
Production-shaped read config
real Oracle -> Binance/exchange egress
real read API
writer credentials unreachable
mutation guards active
loopback/private ingress
manual start only
Render unchanged
```

Runtime PASS must prove actual reads/health, bounded Oracle resource use, no 403/418/429 in bounded exchange evidence, no writer network operations, sanitized write-safety counters and Cloudflare delivery path if activated.

### Phase 4D — exact single-writer cutover

Separate explicit CUTOVER approval required. Never overlap Render writer and Oracle writer. Writer credential reachability is introduced only after old writer quiescence is freshly proven.

## Hard exclusions until separately approved

- no Production writer secret;
- no Oracle writer activation;
- no Render resume/stop/delete/cutover mutation;
- no `main` mutation;
- no Pages Production mutation;
- no Production Security PASS claim;
- no paid fallback;
- no blind restart/retry.

## Operator path

```text
Android Termux -> Debian via proot-distro -> direct SSH -> Oracle VM micro-server-auto-2
```

For interactive Oracle blocks:

```bash
export USER="${USER:-$(id -un)}"
set -Eeuo pipefail
```

Use short blocks. Avoid giant heredocs, fragile multiline quoted SSH and producer-to-parser evidence pipelines.

## Next best action

1. verify exact PR #20 head and public Backend checks;
2. if source/static PASS on exact head, close Phase 4A as SOURCE/STATIC PASS only;
3. STOP before Phase 4B mutation and obtain explicit approval for the exact non-writer Production read credential plan;
4. do not start Oracle Production-readonly service before Phase 4B credentials and Phase 4C manual-start approval are separately satisfied.

End technical checkpoints with:

```text
STATUS:
REMAINING RISK:
NEXT BEST ACTION:
```
