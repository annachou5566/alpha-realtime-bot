# Oracle E2 Migration — Phase 1 Qualification Contract

Status: **SOURCE HARDENING / BOUNDED TEMP RUNTIME QUALIFICATION PASS / NOT DEPLOYED / NOT PRODUCTION**

This branch prepares `alpha-realtime-bot` for bounded qualification on a new Oracle `VM.Standard.E2.1.Micro`. It does not authorize or perform a deploy, service restart, Cloudflare route change, Render change, canonical R2 write, Supabase mutation, DNS change, or Production cutover.

## Hard upstream rule

Server-side exchange calls must originate from an approved normal server egress such as the current Render service or the future qualified Oracle Alpha VM. Do not route Binance or other exchange upstream API calls through Cloudflare Workers/Pages Functions or GitHub-hosted execution. Cloudflare may protect/cache/deliver data after the server has fetched and normalized it.

## Qualification runtime

Use only:

```bash
npm run start:qualification
```

The qualification entrypoint is fail-closed. It requires separate least-privilege credentials:

- `R2_READ_ONLY_ACCESS_KEY_ID`
- `R2_READ_ONLY_SECRET_ACCESS_KEY`
- `R2_ENDPOINT_URL`
- `R2_BUCKET_NAME`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `QUALIFICATION_API_SECRET_KEY`

It deliberately overwrites the legacy environment names expected by `index.js` so copied Production writer credentials cannot silently become active in qualification mode.

Qualification also forces:

```text
WAVE_RUNTIME_MODE=qualification
WAVE_CANONICAL_PUBLISH=off
ENABLE_TICK_CACHE=false
```

Defense in depth:

1. R2 credentials supplied to the legacy runtime are read-only.
2. S3 mutation commands are blocked before network send.
3. Supabase uses the anon key instead of the service-role key.
4. Non-read HTTP methods to the configured Supabase origin are blocked before network send.
5. The API key is qualification-only; do not copy the Production origin key to the candidate VM.
6. Raw tick-cache ingestion/persistence is forced off.
7. Qualification loads `index.js` through an in-memory hardening transform. The repository `index.js` Production path is not rewritten.
8. The transform must find every expected safety anchor exactly once or startup fails closed.
9. Qualification binds the HTTP server to `127.0.0.1` only.
10. Qualification disables historical Binance 14-day scraping, start-offset upstream scans, actual competition price backfill, finalization, competition-live writes, and the inline auto-finalize mutation branch. Existing R2 market history may be used only as a stale/read-only fixture and must not be described as fresh.

## What qualification may do

- call bounded Binance/exchange upstream APIs from the candidate Oracle server egress;
- read the existing R2 objects required to construct the current response contract;
- read Supabase configuration under anon/RLS policy;
- keep RAM caches and compute normalized/aggregated responses;
- expose only a bounded loopback candidate endpoint after a separately approved VM qualification step.

## What qualification must not do

- write, delete or overwrite R2 objects;
- update/insert/delete Supabase rows;
- become a canonical Competition/Market writer;
- enable tick-cache R2 persistence;
- perform broad historical Binance scraping/backfill;
- perform start-offset scans or price backfill writes;
- finalize tournaments or mutate canonical history;
- receive Production Cloudflare traffic;
- replace or stop Render;
- touch the existing Liquidation VM `micro-server-auto`;
- use Cloudflare or GitHub as exchange upstream egress.

## Runtime evidence checkpoint — 2026-09-01

A bounded temporary patch equivalent to the source hardening above was qualified on Oracle candidate `micro-server-auto-2` with canonical writers off. Observed evidence included loopback-only bind on `127.0.0.1:3100`, unauthorized market API HTTP 401, authorized market API HTTP 200 with 666 records, R2 read success, Supabase anon read success, `R2_WRITE_BYTES=0`, zero blocked R2/Supabase mutation attempts, Node VM high-water mark about 140 MB, and clean teardown with the temporary environment removed and port 3100 no longer listening.

The temporary R2 Object Read-only credential used for that qualification was removed locally, removed from the Oracle runtime, and owner-confirmed revoked/deleted in Cloudflare after the test.

This runtime evidence does **not** make a later source commit, deployment, Production state, or Security posture automatically PASS. Source PASS, runtime PASS, Production PASS, and Security PASS remain separate gates.

## Promotion rule

A qualification PASS is not a Production PASS. Promotion requires separate owner approval for the exact VM deployment/cutover operation, a proven single-writer handoff, current Free/Always-Free headroom, security checks, and post-cutover verification. No writer may be active concurrently on Render and Oracle.
