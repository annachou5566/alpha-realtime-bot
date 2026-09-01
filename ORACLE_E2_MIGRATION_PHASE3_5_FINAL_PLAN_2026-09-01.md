# Oracle E2 Migration — FINAL Reviewed Plan for Phases 3–5

Status: **FINAL PLAN / NO MUTATION AUTHORIZED BY THIS DOCUMENT**

Checkpoint: **2026-09-01 after Phase 2B CLOSED/PASS**

This plan incorporates the post-handoff review and the headroom reuse rule in `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md`.

Overall migration progress at this checkpoint: **~88%**.

## Non-negotiable architecture

```text
Exchange API
  -> approved normal server egress (Render current / Oracle candidate)
  -> Alpha engine
  -> protected storage/read models
  -> Cloudflare security/cache/delivery
  -> browser
```

Forbidden:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare Tunnel is downstream ingress only. Browser-direct Binance WebSocket stays browser-direct.

## Headroom reuse rule

Do not rerun CLOSED/PASS headroom merely because the chat changed.

- Phase 2B OCI Vault/KMS/secret qualification evidence is closed and reused.
- Phase 3 does not consume OCI Vault/KMS/Secrets and must not re-audit those quotas.
- Prior Pages/R2/Workers evidence is unrelated to Phase 3 Tunnel/Access and must not be re-audited unless the design unexpectedly consumes those products.
- Phase 3B checks only new Zero Trust/Access/Tunnel resource classes once before their first mutation and reuses that same-session evidence unless a concrete invalidator occurs.
- Volatile VM RAM/disk/listeners/service state may be read fresh because those are runtime safety signals, not closed quota evidence.

---

# Phase 3 — Cloudflare Tunnel / private-ingress qualification

Goal: prove a secure Free-compatible Cloudflare -> Access -> Tunnel -> Oracle loopback path with **no Production credentials, no writer, no Render mutation, no Production cutover and no exchange fetch from Cloudflare**.

Expected progress after PASS: **~92%**.

## 3A — source/static contract review — READ ONLY / SOURCE ONLY

No owner mutation approval is required for read-only inspection.

Tasks:

1. Fresh-read current Wave Alpha security/Cloudflare/Termux runbooks and current Alpha migration refs.
2. Verify exact current PR/source/public CI.
3. Preserve the upstream-egress invariant.
4. Use a dedicated secretless loopback qualification responder on `127.0.0.1:3101` as the preferred Tunnel origin.
5. Do not reopen Phase 2A or start Alpha merely to prove transport.
6. Define Access/auth behavior before any route is published.
7. Define exact resource names, collision checks, cleanup and rollback.
8. If source/config material is needed, prepare/review it on the migration stack only; do not deploy it without approval.

PASS:
- no Production credential needed;
- no writer needed;
- no exchange upstream from Cloudflare;
- exact origin/auth/route contract reviewed;
- no paid dependency introduced.

## 3B — one-time Phase-3 preflight — READ ONLY

Do not rerun Phase 2B OCI headroom or unrelated R2/Pages/Workers checks.

Cloudflare checks needed exactly once for the Phase-3 resource classes:

- operator auth/session;
- exact account identity;
- Zero Trust plan/current eligibility;
- Access application count;
- Access service-token count;
- Tunnel count/routes;
- candidate DNS hostname collision;
- relevant Access policy collision;
- exact token/session permissions without printing credential values.

Cloudflare current documented default limits include 500 Access applications and 50 service tokens. Actual account usage must be measured once; product limits alone are not headroom proof.

Oracle volatile-state checks:

- exact `micro-server-auto-2` / `VM.Standard.E2.1.Micro` identity;
- service inactive;
- ports 3100/3101 absent before mutation;
- current RAM/swap/disk/load;
- whether `cloudflared` already exists and exact version/path;
- existing systemd/tunnel collision.

Do not install anything in 3B.

PASS/FAIL:
- FAIL CLOSED on wrong account, stale auth, unresolved collision, paid fallback requirement, unsafe origin/listener state or unavailable required Phase-3 headroom.
- Reuse the 3B headroom evidence through Phase 3 unless a concrete invalidator occurs.

## 3C — approval-gated qualification mutations

Every consequential mutation remains separately approval-gated.

### First proposed mutation

Create exactly one short-lived qualification-only Cloudflare Access service token, only after 3B proves available service-token headroom and no collision.

Security handling:
- Client Secret is captured only into owner-local tmpfs/mode-600 material;
- do not print/chat/log/screenshot the value;
- metadata-only postcheck;
- token grants no useful access until the matching Access policy exists.

Then, as separately approved operations:

1. create the qualification self-hosted Access application;
2. attach a `Service Auth` policy restricted to the qualification token;
3. create one named remotely-managed Tunnel;
4. if `cloudflared` is missing, stage an exact pinned binary under `/opt/wave-alpha/cloudflared/releases/<version>` with immutable `current`; no apt/global PATH;
5. stage a manual/static connector unit, not enabled on boot;
6. stage/start the secretless loopback responder on `127.0.0.1:3101`;
7. materialize Tunnel token under `/run/...` or reviewed token-file mechanism without printing it;
8. start connector manually;
9. only after Access protection exists, create the qualification hostname/DNS published route -> `http://127.0.0.1:3101`.

Do not publish Production hostname/DNS.

## 3D — bounded runtime proof

PASS must prove:

- unauthenticated request denied by Access;
- correct Service Auth succeeds and returns the fixed marker;
- TLS path healthy;
- Tunnel connector healthy;
- Oracle public app port not exposed;
- only intended loopback origin targeted;
- unrelated ports/services not proxied;
- no Production credential;
- no R2/Supabase write;
- no exchange fetch caused by Cloudflare;
- no Render mutation;
- CPU/RAM/network bounded;
- Phase-3-specific Cloudflare usage remains within proven Free posture.

Optional Alpha-through-Tunnel trial is **not required for base Phase 3 PASS**. If later desired, it is a separate bounded approval using qualification-only credentials and `oracle-qualification.js`.

## 3E — closeout

Default cleanup:

- revoke/delete temporary Access service token;
- stop secretless responder;
- remove runtime token material;
- stop connector if not needed for Phase 4;
- remove temporary qualification hostname/app/policy/route if not retained.

The Tunnel object may be retained dormant for Phase 4 only if explicitly recorded as carrying no Production traffic.

Phase 3 PASS = private-ingress qualification only, not Production PASS.

---

# Phase 4 — Production configuration + single-writer cutover

Expected progress after Production acceptance: **~97–98%**.

## 4A — design/source freeze before Production secrets

This phase must solve the source gap discovered during plan review:

`index.js` currently has no independently proven native Production-configured writer-OFF mode. `WAVE_CANONICAL_PUBLISH=off` alone is not accepted as a safety boundary.

Required source contract:

`Production-shaped runtime + real Oracle exchange egress + real read API + write capability fail-closed`.

The reviewed safety mode must independently block or make unreachable:

- R2 Put/Delete/Copy/multipart mutations;
- Supabase INSERT/UPDATE/DELETE or mutation RPC paths;
- competition-live writes;
- price/history backfill writes;
- finalize/auto-finalize;
- historical mutation jobs;
- tick-cache persistence;
- every other canonical writer path found by inventory.

Preferred design: Phase 4C does not have writer credentials reachable at all. Credential reachability/least privilege is stronger than a boolean flag.

Also fresh-read once at this checkpoint:

- Render current state/deployed SHA;
- Oracle release/state;
- retained Phase-3 Cloudflare resources;
- exact writer ownership and rollback assets.

No Production credential mutation until 4A source/static gates PASS.

## 4B — read-side/API Production secrets only

Separate explicit owner approval required.

Reuse the retained DEFAULT Vault, SOFTWARE key and exact-instance Dynamic Group; do not create another Vault merely for Phase 4.

Headroom rule:
- do not rerun Vault-slot/key qualification if reusing retained resources and no invalidator exists;
- refresh only the exact Secrets resource class if new Production secret creation requires it.

Provision only credentials needed for the Production-shaped read candidate, for example:
- read-side storage credential if required;
- API/origin authentication secret;
- other non-writer credential explicitly justified.

**Writer credential reachability is deferred to 4D.** Do not grant the Oracle instance access to writer secrets in 4B/4C.

IAM must be exact-secret least privilege, not tenancy-wide secret access.

PASS:
- instance can retrieve only intended non-writer Production secrets;
- no plaintext output;
- no service start from this gate;
- no writer capability;
- Render unchanged.

## 4C — Production-shaped Oracle candidate, writers unreachable

Separate explicit approval for manual service start.

Start exact reviewed 4A release with:

- loopback/Tunnel origin;
- Production-shaped read configuration;
- writer credentials unreachable;
- mutation guards/fail-closed write boundary active;
- bounded systemd resource limits;
- manual start first, no boot-enable.

Runtime proof:

- health/read/auth success;
- Oracle -> Binance egress healthy;
- no 403/418/429 in bounded evidence;
- expected reads only;
- zero writer operations proven from instrumentation/logged counters, not inferred from an env flag;
- Tunnel path healthy;
- E2 resource usage bounded;
- Render unchanged.

PASS = Production-shaped read-only candidate, not Production writer.

## 4D — exact single-writer cutover

Separate explicit **CUTOVER approval** required.

Render branch logic:

### If Render is still suspended

1. do not resume Render;
2. fresh-prove it remains suspended at the cutover checkpoint;
3. prove writer absence/quiescence from the old path;
4. only then provision/grant exact Oracle writer credential reachability;
5. activate the reviewed Oracle writer path;
6. prove Oracle is sole writer.

### If Render has been resumed by a later event

1. stop/disable Render writer by the approved minimal operation;
2. prove Render writer quiescence;
3. only then grant Oracle writer capability;
4. activate Oracle;
5. prove single-writer ownership.

Never use an overlap window.

Cutover sequence:

1. freeze exact heads/releases;
2. capture pre-cutover data timestamp/hash/cursor evidence;
3. prove old writer OFF;
4. provision/grant writer secret/IAM only now;
5. activate reviewed Oracle writer;
6. verify intended R2/Supabase mutations only;
7. verify no duplicate writer/sequence regression;
8. verify read-model freshness and Cloudflare delivery;
9. verify E2 resource headroom;
10. keep rollback ready until acceptance.

Rollback order:

1. stop Oracle writer;
2. prove Oracle write quiescence;
3. revoke/withhold Oracle writer capability if needed;
4. only then reactivate Render under separate rollback approval;
5. prove Render is sole writer;
6. verify continuity.

Never reactivate Render before Oracle writer is proven off.

## 4E — Production acceptance

Required evidence:

- exact Oracle release;
- intended Production secret access only;
- Oracle sole writer;
- Render not writer;
- Binance healthy;
- expected storage mutations only;
- fresh/correct read models;
- Cloudflare path healthy;
- bounded E2 resource usage;
- no credential leakage;
- rollback path valid;
- owner acceptance.

Only then call **Alpha Oracle Production PASS**.

This still does not imply Wave Alpha Production SECURITY PASS.

---

# Phase 5 — observation, rollback preservation, retirement

## 5A — observation

Recommended checkpoints:

- first 0–2 hours: intensive observation;
- 24 hours: durability checkpoint;
- 48 hours: minimum migration-stability closeout checkpoint.

A mandatory seven-day wait is **not** part of the migration PASS criteria. A suspended Render rollback asset may be retained longer if it is Free/no-overage and useful, but retention duration is an owner/rollback decision rather than an arbitrary countdown.

Observe:

- uptime/restarts;
- CPU/load/RSS/swap/disk;
- Binance 2xx/403/418/429/timeouts/latency;
- R2/Supabase expected reads/writes;
- data freshness;
- duplicate-writer indicators;
- Tunnel/HTTP errors;
- Vault retrieval errors;
- bandwidth and relevant Free usage.

Unavailable metric != zero.

## 5B — rollback proof

Read-only/control-plane proof that:

- Oracle writer stop path is current;
- writer IAM revoke path is current;
- Render recovery source/config remains available if retained;
- Tunnel route rollback is known;
- rollback never makes Cloudflare the exchange upstream caller.

An actual live rollback drill is separate approval.

## 5C — retirement — separate destructive approvals

After stable observation and owner decision:

- revoke obsolete Render writer credentials;
- remove stale Render secrets;
- decide suspended vs delete Render service;
- remove obsolete qualification runtime/release artifacts;
- delete temporary Access/Tunnel artifacts not reused;
- retire obsolete Vault policies/secrets;
- rotate Production credentials only if the final security design calls for it.

Do not delete rollback assets before owner closes the rollback window.

## 5D — source-of-truth closeout

Update current docs with:

- Oracle exact Production release/runtime owner;
- service ownership;
- Cloudflare Tunnel/Access ownership;
- Vault/Dynamic Group/secret contract;
- R2/Supabase ownership;
- Render final state;
- Free assumptions/monitoring;
- rollback runbook;
- remaining Security caveats.

`main` mutation remains separately approval-gated.

## 100% migration criteria

Migration can be CLOSED/100% only when:

- Oracle Production stable through approved observation window;
- single-writer invariant proven;
- no unexplained data/freshness errors;
- relevant Free posture valid;
- rollback path current;
- obsolete Render credentials/runtime retired or deliberately retained with reason/end condition;
- stale qualification artifacts resolved;
- docs current;
- no unresolved high-severity blocker;
- owner explicitly accepts closeout.

## Final ownership

```text
Exchange upstream caller
  = Oracle Alpha service after cutover
  = Render only if rollback explicitly activated

Cloudflare Access
  = ingress authentication policy owner

Cloudflare Tunnel / cloudflared
  = transport only

Alpha application
  = normalize/API/business-logic owner

R2
  = derivative projection/distribution storage

Supabase
  = existing canonical ownership preserved

Browser Binance WebSocket
  = browser-direct
```

## Next execution boundary

The first execution work after this final plan is **Phase 3A + 3B read-only inspection**. Read-only inspection does not authorize any mutation.

After 3B PASS, STOP and request explicit approval for the first mutation: creation of the short-lived qualification-only Cloudflare Access service token.

End every technical checkpoint with:

```text
STATUS:
REMAINING RISK:
NEXT BEST ACTION:
```
