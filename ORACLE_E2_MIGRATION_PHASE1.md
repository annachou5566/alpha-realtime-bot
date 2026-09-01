# Oracle E2 Migration — Phase 1 Qualification Contract

Status: **SOURCE PREP ONLY / NOT DEPLOYED / NOT PRODUCTION**

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

## What qualification may do

- call Binance/exchange upstream APIs from the candidate Oracle server egress;
- read the existing R2 objects required to construct the current response contract;
- read Supabase configuration under anon/RLS policy;
- keep RAM caches and compute normalized/aggregated responses;
- expose only a bounded candidate endpoint after a separately approved VM qualification step.

## What qualification must not do

- write, delete or overwrite R2 objects;
- update/insert/delete Supabase rows;
- become a canonical Competition/Market writer;
- enable tick-cache R2 persistence;
- receive Production Cloudflare traffic;
- replace or stop Render;
- touch the existing Liquidation VM `micro-server-auto`;
- use Cloudflare or GitHub as exchange upstream egress.

## Promotion rule

A qualification PASS is not a Production PASS. Promotion requires separate owner approval for the exact VM deployment/cutover operation, a proven single-writer handoff, current Free/Always-Free headroom, security checks, and post-cutover verification. No writer may be active concurrently on Render and Oracle.
