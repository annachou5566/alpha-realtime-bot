# Oracle E2 Migration — Phase 4A Production-Readonly Source Contract

Status: **SOURCE CANDIDATE — RUNTIME / PRODUCTION NOT AUTHORIZED**

Checkpoint: **2026-09-01 after Phase 3 CLOSED/PASS**

## Goal

Prepare a Production-shaped Oracle read candidate that can perform real read/API and approved Oracle -> exchange egress while canonical writer capability remains unreachable and independently blocked.

Phase 4A is source/design only. It does not authorize Production credentials, service start, Tunnel connector start, VPC Service creation, Render mutation or cutover.

## Current writer inventory at Phase 4A entry

The reviewed `index.js` at parent head `43e576467a51b017c5fc37a8f8313bd23f197b41` contains the following canonical mutation surfaces:

### R2 PutObject — 7 call sites

1. `market_vol_history.json` after historical Binance refresh;
2. immutable backup for `competition-price-series.json`;
3. `competition-price-series.json` persistence;
4. `finalized_history.json` in `finalizeTournament()`;
5. `finalized_history.json` in inline auto-finalize;
6. `competition-live.json`;
7. compressed tick-cache hour objects.

### R2 DeleteObject — 1 call site

- old tick-cache object cleanup.

### Supabase mutation — 1 call site

- `tournaments.update(...)` in `finalizeTournament()`.

### Triggering surfaces that matter

- startup calls `fetch14DaysHistoryBapi()` and can refresh/persist market history when R2 is stale/missing;
- startup competition price dry-run can lead to a non-dry persistence pass;
- recurring competition-live publishing can write R2;
- time-based auto-finalize can write finalized history;
- admin price backfill can persist price-series data;
- tick cache can Put/Delete R2 objects when enabled.

There is no native `WAVE_CANONICAL_PUBLISH` check in current `index.js`; therefore setting that variable alone is not a safety boundary.

## Phase 4A safety design

The candidate introduces a dedicated checked-in entrypoint:

```text
oracle-production-readonly.js
  -> prepareProductionReadonlyEnv()
  -> prove no legacy writer credential env is inherited
  -> map only R2 read-only + Supabase anon + Production read API credentials
  -> install pre-network S3 mutation guard
  -> install pre-network Supabase mutation guard
  -> load exact shared index.js through fail-closed production-readonly source hardening
```

The shared Render `index.js` file is intentionally not rewritten in place. Render's current behavior remains unchanged. The Oracle read candidate is a separate first-class runtime entrypoint with exact-anchor hardening tests; an anchor drift fails startup/tests rather than silently weakening safety.

### Primary boundary — writer credentials unreachable

The Production-readonly launcher accepts only:

```text
R2_READ_ONLY_ACCESS_KEY_ID
R2_READ_ONLY_SECRET_ACCESS_KEY
SUPABASE_ANON_KEY
PRODUCTION_READ_API_SECRET_KEY
```

It fails closed if inherited legacy variables are already present:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
SUPABASE_SERVICE_ROLE_KEY
API_SECRET_KEY
```

Only after that absence proof does the wrapper map least-privilege read credentials into the legacy names expected by `index.js`.

This means Phase 4C must not place any Production writer credential in the unit, credential directory, inherited environment or instance-readable secret policy.

### Secondary boundary — pre-network mutation guards

Before `index.js` constructs clients:

- R2 Put/Delete/Copy/multipart mutation commands are rejected before client network send;
- Supabase non-GET/HEAD/OPTIONS requests to the exact Supabase origin are rejected before network send;
- blocked attempts are counted in a sanitized write-safety snapshot.

### Source suppression boundary

The Production-readonly source hardening suppresses or bounds the current known triggering paths:

- historical BAPI refresh -> existing R2 read only;
- start-offset upstream scan -> disabled for bounded trial;
- competition price non-dry persistence -> disabled;
- competition price dry-run -> at most 2 fetches, no history;
- `finalizeTournament()` -> disabled;
- inline auto-finalize -> disabled;
- competition-live R2 writer -> disabled;
- tick-cache flush -> disabled;
- admin price-backfill POST -> explicit 503 unavailable;
- listener -> `127.0.0.1` only.

`ENABLE_TICK_CACHE=false`, `WAVE_RUNTIME_MODE=production-readonly` and `WAVE_CANONICAL_PUBLISH=off` are exact required unit values, not optional defaults.

### Instrumentation

Protected `/api/bandwidth-stats` gains a Production-readonly `writeSafety` snapshot in the transformed runtime containing only sanitized state/counters:

```text
mode
canonicalPublish=false
writerCredentialsReachable=false
tickCacheEnabled=false
credential modes
blocked.r2
blocked.supabase
sourceSuppressed counters
```

No secret value is emitted.

## Static invalidators

Phase 4A must reopen if any of these change before Phase 4C:

- count or type of `PutObjectCommand` / `DeleteObjectCommand` mutation sites;
- Supabase mutation surface;
- any hardening anchor;
- launcher credential names or service credential reachability;
- writer credential policy/IAM;
- runtime mode contract;
- new persistence/archive owner or new mutation API.

The regression test pins the current inventory at exactly:

```text
PutObjectCommand constructors: 7
DeleteObjectCommand constructors: 1
Supabase tournaments.update: 1
```

A new mutation site must fail the source gate until reviewed and covered.

## Phase 4A validation gate

Required on the exact candidate head:

1. syntax/tests for the new mode, hardening, launcher and existing suite;
2. source hardening applies every expected anchor exactly once;
3. R2 and Supabase guards prove mutation rejection before network;
4. inherited writer credential env causes fail-closed startup preparation;
5. read-only credential mapping is exact;
6. writer inventory counts remain pinned;
7. no Production secret, runtime start, Render mutation or cutover occurs.

Public repository CI is source/static evidence only. It does not imply Oracle Runtime PASS or Production PASS.

## Phase 4B boundary after Source PASS

Phase 4B remains a separate explicit approval gate. It may provision only non-writer read-side credentials needed by the Production-shaped candidate. Writer credential reachability remains deferred to Phase 4D exact cutover.
