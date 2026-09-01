# Alpha Realtime Bot

Render collector/API for Wave Alpha. The service reads Binance Alpha/market data, keeps a bounded RAM cache, and publishes compact snapshots to Cloudflare R2.

## Current authority / migration status

Overall Wave Alpha system authority remains:

```text
repository: annachou5566/wave-alpha
authoritative branch: test-wavealpha
Pages Production branch: test-wavealpha
```

This repository owns the Alpha Realtime Bot implementation and the current Render -> Oracle E2 migration work. For migration work, read in this order:

1. `README.md` in `wave-alpha/test-klinechart` and the current Wave Alpha operating/security/runbooks.
2. This `README.md`.
3. `ORACLE_E2_MIGRATION_PHASE1.md`.
4. `ORACLE_E2_MIGRATION_PHASE2.md`.
5. `ORACLE_E2_MIGRATION_PHASE2B.md`.
6. `ORACLE_E2_MIGRATION_HANDOFF_2026-09-01.md`.
7. `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md`.
8. `ORACLE_E2_MIGRATION_PHASE3_5_FINAL_PLAN_2026-09-01.md`.
9. `MASTER_HANDOFF_PROMPT_ORACLE_E2_PHASE3_FINAL_2026-09-01.md` when opening a new chat.
10. Exact current PR metadata/head/runtime evidence.

`ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md` is the earlier proposed plan and is superseded for execution by the reviewed FINAL plan above. `MASTER_HANDOFF_PROMPT_ORACLE_E2_PHASE3_2026-09-01.md` is likewise superseded by the FINAL handoff prompt above.

Never trust an old chat SHA, branch label, token, preview URL or runtime assumption over newer GitHub/runtime evidence.

### Current migration checkpoint

```text
Phase 1   CLOSED / PASS
Phase 2A  CLOSED / PASS
Phase 2B  CLOSED / PASS
Phase 3   NOT STARTED — approval-gated mutations
Phase 4   NOT STARTED — multiple Production approval gates
Phase 5   NOT STARTED — post-cutover only
```

Approximate overall migration progress after Phase 2B: **~88%**. This is not Production PASS and not Security PASS.

Current Oracle candidate:

```text
micro-server-auto-2
VM.Standard.E2.1.Micro
Ubuntu 24.04 Minimal
Singapore
Alpha qualification service: inactive at Phase 2B closeout
port 3100: absent at Phase 2B closeout
```

Phase 2B proved OCI Vault + instance principal with a random qualification marker only. The qualification secret is `PENDING_DELETION`; its exact-secret qualification policy was removed. A Free-compatible DEFAULT Vault, SOFTWARE key and exact-instance Dynamic Group are retained for later reviewed use. No Production credential was provisioned or used.

## Headroom reuse rule

Do not rerun completed headroom checks merely because a new chat starts. Use `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md` as the current evidence ledger.

- CLOSED/PASS OCI Vault/KMS/secret qualification is reused and is not part of Phase 3 preflight.
- Phase 3 must not recheck unrelated R2/Pages/Workers headroom.
- Phase 3B checks only the Zero Trust/Access/Tunnel resource classes not previously qualified, once before their first mutation, and reuses that evidence unless a concrete invalidator occurs.
- A future quota-consuming mutation may require a fresh check of that **exact** resource class; do not rerun unrelated closed gates.
- Volatile runtime health such as RAM/disk/load/listeners may still be read fresh before a runtime mutation.

## Architecture invariants

Upstream exchange traffic must originate from approved normal server egress:

```text
exchange API -> Render current / qualified Oracle -> normalize/store/API -> Cloudflare delivery -> browser
```

Forbidden:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare Tunnel is a downstream Cloudflare -> Oracle ingress path; it must never become the exchange upstream caller. Browser-direct public realtime streams such as Binance WebSocket remain separate from Oracle server-side collection.

Preferred architecture direction:

```text
COMPUTE ONCE -> STORE ONCE -> AUTHORIZE EARLY -> CACHE SAFELY -> DISTRIBUTE AT EDGE
```

R2 is a derivative projection/distribution layer, not the canonical database/archive owner. Existing Supabase canonical ownership remains where already established.

## Free-tier / security rules

- Free / Always Free only; no paid fallback or silent overage.
- Oracle candidate must remain `VM.Standard.E2.1.Micro` unless separately approved.
- Production deploy/cutover, service restart/enable, Production credentials, Cloudflare Tunnel/DNS route, writer activation, Render mutation and `main` mutation require explicit owner approval for the exact operation.
- Do not print or paste tokens, secret plaintext, API private keys, full OCI config, `.env` or Production credentials.
- Missing/unavailable is not zero.
- Source PASS != runtime PASS != Production PASS != Security PASS.
- Use one consequential mutation per block: precheck -> mutation -> independent postcheck.
- Do not blindly retry a failed create/delete operation; first verify actual resource state.
- Prefer exact source-reviewed scripts and verify Git blob/SHA-256 before remote execution.

## Free-tier bandwidth controls

The defaults are deliberately conservative for Render's 5 GB monthly included bandwidth:

| Variable | Default | Purpose |
|---|---:|---|
| `REALTIME_POLL_MS` | `60000` | Aggregate-volume refresh cadence. |
| `LIMIT_REFRESH_MS` | `300000` | Limit/CEX aggregate refresh cadence. Reuses the last good snapshot between refreshes. |
| `CONFIG_SYNC_MS` | `900000` | Supabase tournament-config refresh cadence. |
| `COMPETITION_LIVE_WRITE_MS` | `300000` | Minimum R2 write interval for `competition-live.json`; unchanged payloads are skipped. |
| `PRICE_SYNC_MS` | `900000` | Missing competition boundary-price scan cadence. |
| `ENABLE_TICK_CACHE` | `false` | Opt-in five-symbol aggTrade collector. Keep disabled unless a live consumer requires raw ticks. |

`GET /api/bandwidth-stats` is protected by the normal `x-api-key` middleware and reports HTTP output, upstream responses, WebSocket ingress, R2 traffic, Supabase estimates, and a 750-hour projection.

## Competition price series

Boundary prices are stored in R2 as `competition-price-series.json`. A seven-period competition has eight price points: the exact start boundary plus seven period-end boundaries. The collector requests narrow Binance Alpha kline windows, rejects responses whose timestamps are too far from the requested boundary, and never fabricates missing prices.

- `GET /api/competition-price-series?ids=<db_id,...>` returns a compact batch.
- `POST /api/admin/backfill-competition-prices` accepts `{ "includeHistory": true, "maxFetches": 25, "dryRun": false }`.
- Backfill is bounded and idempotent by tournament/slot.

## Tests

```bash
npm test
```
