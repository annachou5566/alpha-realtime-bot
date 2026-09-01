# Alpha Realtime Bot

Render collector/API for Wave Alpha and the current Render -> Oracle E2 migration source.

## Current authority / migration status

Overall Wave Alpha authority remains:

```text
repository:              annachou5566/wave-alpha
authoritative branch:    test-wavealpha
Pages Production branch: test-wavealpha
```

This repository owns the Alpha Realtime Bot implementation and its Oracle migration work. For current migration work, read in this order:

1. `README.md` in `wave-alpha/test-klinechart` plus current Wave Alpha operating/security/test/free-tier/runbooks.
2. This `README.md`.
3. `ORACLE_E2_MIGRATION_PHASE1.md`.
4. `ORACLE_E2_MIGRATION_PHASE2.md`.
5. `ORACLE_E2_MIGRATION_PHASE2B.md`.
6. `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md`.
7. `ORACLE_E2_MIGRATION_PHASE3_CLOSEOUT_2026-09-01.md`.
8. `ORACLE_E2_MIGRATION_PHASE4A.md`.
9. `ORACLE_E2_MIGRATION_PHASE3_5_FINAL_PLAN_2026-09-01.md` for the remaining reviewed Phase 4/5 gates, except where newer closeout/runtime evidence above supersedes its pre-execution Phase 3 assumptions.
10. `MASTER_HANDOFF_PROMPT_ORACLE_E2_PHASE4_2026-09-01.md` when opening a new chat.
11. Exact current PR metadata/head/runtime evidence.

Older Phase 3 plans/handoffs remain historical compatibility references. Never trust an old chat SHA, branch label, token, preview URL or runtime assumption over newer GitHub/runtime evidence.

### Current migration checkpoint

```text
Phase 1   CLOSED / PASS
Phase 2A  CLOSED / PASS
Phase 2B  CLOSED / PASS
Phase 3   CLOSED / PASS
Phase 4A  SOURCE / STATIC PASS candidate on Draft PR #20
Phase 4B  NOT STARTED — separate approval gate for non-writer Production read credentials
Phase 4C  NOT STARTED — separate manual-start/runtime approval gate
Phase 4D  NOT STARTED — exact single-writer cutover approval gate
Phase 5   NOT STARTED — post-cutover only
```

Approximate overall migration progress after Phase 3 closeout: **~92%**. This is not Alpha Production PASS and not Wave Alpha Production SECURITY PASS.

Current Oracle candidate closeout state:

```text
VM:                         micro-server-auto-2
Shape:                      VM.Standard.E2.1.Micro
OS:                         Ubuntu 24.04 Minimal
Alpha qualification service: inactive
port 3100:                  absent
port 3101:                  absent
qualification Worker:       deleted
Workers VPC Service:        deleted
Tunnel object:              retained dormant/down
cloudflared binary:         retained pinned 2026.8.3
runtime Tunnel token:       removed
```

## Architecture invariants

Upstream exchange traffic must originate from approved normal server egress:

```text
exchange API -> Render current / reviewed Oracle candidate -> normalize/store/API -> Cloudflare delivery -> browser
```

Forbidden:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare is downstream ingress/security/cache/delivery only. Browser-direct public realtime streams such as Binance WebSocket remain separate from Oracle server-side collection.

Without a custom domain, Phase 3 qualified this domain-agnostic private backend transport:

```text
qualification Worker
  -> Workers VPC Service Binding
  -> Workers VPC Service
  -> Cloudflare Tunnel
  -> Oracle loopback responder
```

The temporary Worker/VPC/responder/connector runtime was removed after PASS. The Tunnel object and pinned cloudflared binary were retained for later reviewed reuse.

Preferred architecture direction remains:

```text
COMPUTE ONCE -> STORE ONCE -> AUTHORIZE EARLY -> CACHE SAFELY -> DISTRIBUTE AT EDGE
```

R2 is a derivative projection/distribution layer, not the canonical database/archive owner. Existing Supabase canonical ownership remains where already established.

## Phase 4A Production-readonly safety contract

Current shared `index.js` contains canonical mutation paths and does **not** natively honor `WAVE_CANONICAL_PUBLISH` as a writer safety boundary. Starting raw `node index.js` with Production writer credentials is therefore forbidden for Phase 4C.

Draft PR #20 adds a dedicated first-class Oracle Production-readonly entrypoint:

```text
oracle-production-readonly.js
  -> exact production-readonly env validation
  -> writer credentials unreachable
  -> R2/Supabase pre-network mutation guards
  -> exact-anchor source hardening of shared index.js
  -> loopback-only API runtime
```

Current reviewed mutation inventory is pinned by tests:

```text
R2 PutObject constructors:       7
R2 DeleteObject constructors:    1
Supabase tournaments.update:     1
```

The Production-readonly runtime requires exactly:

```text
WAVE_RUNTIME_MODE=production-readonly
WAVE_CANONICAL_PUBLISH=off
ENABLE_TICK_CACHE=false
R2_READ_ONLY_ACCESS_KEY_ID
R2_READ_ONLY_SECRET_ACCESS_KEY
SUPABASE_ANON_KEY
PRODUCTION_READ_API_SECRET_KEY
```

It fails closed if inherited legacy credential variables are already present before read-only mapping. Writer credentials remain deferred to Phase 4D exact cutover.

The source hardening suppresses historical refresh persistence, start-offset scan, non-dry competition price persistence, finalize/auto-finalize, competition-live writes, tick-cache flush and admin backfill. It also binds the candidate to `127.0.0.1` and exposes sanitized write-safety counters through the protected bandwidth diagnostics.

Source/static PASS does not authorize Phase 4B secrets or Phase 4C service start.

## Headroom reuse rule

Do not rerun completed headroom checks merely because a new chat starts. Use `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md` as the evidence ledger.

- CLOSED/PASS OCI Vault/KMS qualification remains reused unless a concrete invalidator exists.
- Phase 4B refreshes only the exact Secrets resource class if new non-writer Production secret creation consumes it.
- Do not rerun unrelated R2/Pages/Workers quota evidence without a new resource-class reason.
- Volatile Oracle RAM/disk/load/listeners may be read fresh before a runtime mutation.

## Free-tier / security rules

- Free / Always Free only; no paid fallback or silent overage.
- Oracle candidate remains `VM.Standard.E2.1.Micro` unless separately approved.
- Production deploy/cutover, service stop/start/restart/enable, Production credentials, Cloudflare Tunnel/VPC/route activation, writer activation, Render mutation and `main` mutation require explicit owner approval for the exact operation.
- Do not print/paste tokens, secret plaintext, API private keys, full OCI config, `.env` or Production credentials.
- Missing/unavailable is not zero.
- Source PASS != runtime PASS != Production PASS != Security PASS.
- Use one consequential mutation per block: precheck -> mutation -> independent postcheck.
- Do not blindly retry failed create/delete/start operations; verify actual state first.

## Free-tier bandwidth controls

Defaults remain conservative. Notable controls include:

| Variable | Default/current intent | Purpose |
|---|---:|---|
| `REALTIME_POLL_MS` | 5 min in current source | Aggregate-volume refresh cadence. |
| `LIMIT_REFRESH_MS` | 5 min | Limit/CEX aggregate refresh cadence. |
| `CONFIG_SYNC_MS` | 30 min | Supabase tournament-config refresh cadence. |
| `COMPETITION_LIVE_WRITE_MS` | 5 min | Current Render writer cadence; suppressed in Production-readonly mode. |
| `PRICE_SYNC_MS` | 15 min | Boundary-price scan cadence; persistence suppressed/bounded in Production-readonly mode. |
| `ENABLE_TICK_CACHE` | `false` | Raw tick cache must remain disabled in Production-readonly mode. |

`GET /api/bandwidth-stats` is protected by the normal `x-api-key` middleware. In the Production-readonly candidate it also reports sanitized `writeSafety` state/counters.

## Competition price series

Boundary prices are stored in R2 as `competition-price-series.json`. The current Render implementation supports bounded/idempotent boundary backfill, but Production-readonly Oracle mode denies persistence/admin backfill and may run only a bounded dry-run scan for qualification evidence.

## Tests

```bash
npm test
```

Public `Backend checks` are source/static evidence only. They do not authorize or prove Oracle runtime, Production writes, cutover or Security PASS.
