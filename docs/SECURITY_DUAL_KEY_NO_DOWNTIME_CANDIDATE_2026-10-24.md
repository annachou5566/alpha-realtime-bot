# Alpha Oracle read API key overlap — REVIEWED SOURCE ONLY
Date: 2026-10-24. Pinned historic Oracle deployment-source base: 6a602b1d435bdcc2d7e9f1698addf732de27cf13.
Owner mandate: Chart/Workspace Save and every Production reader must remain available; no C0/write freeze, no blind restart/revocation.
This is an isolated source branch, NOT a currently running Oracle release, and makes NO claim of Production security completion.

## Auth transition design
- Primary credential: existing Oracle systemd `PRODUCTION_READ_API_SECRET_KEY` -> `API_SECRET_KEY` for the existing x-api-key HTTP verifier.
- Optional next credential: `PRODUCTION_READ_API_SECRET_KEY_NEXT` from a separate systemd credential file, mapped by the readonly mode helper to `API_SECRET_KEY_NEXT`. Missing next credential preserves the original single-key path.
- The verifier accepts primary or standby using fixed-length SHA-256 digest comparison with Node crypto.timingSafeEqual, bounded to 4 KiB each and rejects missing/malformed headers. The startup guard rejects empty, same-as-old and inherited unmanaged standby credentials.
- Existing read-only R2/Supabase restrictions and all existing API paths are unmodified; no additional store, scheduler, worker or auth endpoint.
- Credentials must never enter source code, stdout, Git, SQL editor, chat, or detailed access logs. All checked examples are synthetic.

## Important operational LIMIT — do not confuse source candidate with seamless activation
The retained `scripts/oracle-production-readonly-materialize-vault.sh` explicitly refuses to run with the current service or port 3100 active. It is a **stopped-service bootstrap**, NOT a live rotation path. This change deliberately does not modify or execute it.
A single-instance service restart may drop active connections/reads and therefore violates the owner's zero-interruption condition. A verified parallel deployment, in-place key reload, or other independently qualified continuity mechanism is required BEFORE applying a new verifier on Oracle. Confirm Always Free memory/CPU and existing one-owner runtime before such a rollout; do not add concurrent pollers/writers.

## Required gates, NONE executed in Production
1. Via owner-approved Termux -> Debian -> direct SSH only, verify the exact active systemd unit, binary, immutable release files, listener socket, credential *names* and currently configured verifier semantics without printing any secret. Identify whether a no-restart reload or safe parallel read-only instance is supported.
2. Verify Cloudflare Pages `wave-alpha` -> `ALPHA_BACKEND` -> `wave-alpha-alpha-backend-relay` -> `ALPHA_ORIGIN` VPC mapping and every expected reader. The retained Pages variable `RENDER_API_KEY` is a historical name, NOT Render hosting.
3. Acquire newly generated key in existing Oracle Vault and deliver it to the correct runtime through a protected mechanism. No new service owner. Do not move/change the old key yet.
4. Independently qualify a no-outage compatible verifier rollout plus strict negative/positive tests, without real-user payloads or downtime.
5. Then update the Cloudflare Pages producer to use the new credential through the approved secure configuration mechanism. Validate all Alpha routes, no 5xx spike, rate, latency, no new Cloudflare public endpoint.
6. Finally revoke the old verifier identity on ALL reachable runtimes once every producer and backout path is on the new credential. Prove accept(new) and reject(old) with synthetic/local verification while keeping the production user experience working.
7. Independently verify no Production Chart/Save/D1/gateway changes, exact release SHA, Free/Always Free headroom, and private `wave-alpha` GitHub Actions all-trigger count 0. Only then declare Alpha credential incident closed.

## New fail-closed qualification (2026-10-24)
The startup script candidate now explicitly rejects **any inherited** `PRODUCTION_READ_API_SECRET_KEY_NEXT`, even empty, before loading the optional second key from `CREDENTIALS_DIRECTORY`. This avoids accepting an unaudited standby identity injected by the service environment. Added source-exact isolated middleware tests in `test/readonly-api-auth-middleware.test.js` for both identities, malformed header, existing health/preflight contract and final new-only mode, plus static launch-script negative check. No Oracle runtime or old key changed.

Additional V8 source-exact checks: auth middleware 10/10 synthetic cases PASS; existing immutable Oracle read-only source-hardening pipeline applied all 23/23 unique transforms to the candidate index and JS syntax parsed. Local Node 22 5/5 standalone credential helper fixture PASS. Full repo native test suite and independent Oracle/hosted continuity are still NOT RUN/NOT PASS. Not a Production approval.

## Proof scope
Node 22 isolated helper synthetic test matrix: 5/5 PASS. Exact read-only mode helper executed with synthetic env in connector V8: 6/6 PASS. The full dependency installation/npm suite, runtime Oracle deployment, live credential overlap, actual new-key acceptance, old-key revocation, hosted security and Production availability **HAVE NOT** been tested or performed in this candidate.

STATUS: SOURCE CANDIDATE ONLY; no runtime mutation.
REMAINING RISK: Exposed old key remains active; Oracle runtime identity and no-restart feasibility not qualified.
NEXT BEST ACTION: Owner-approved read-only Oracle systemd/release/verifier identity evidence, then qualified compatible rollout or HOLD rather than interrupt traffic.
