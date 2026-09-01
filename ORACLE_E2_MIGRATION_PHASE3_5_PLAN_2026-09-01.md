# Oracle E2 Migration — Review-First Plan for Phases 3–5

Status: **PROPOSED PLAN ONLY / NO APPROVAL IMPLIED / NO MUTATION AUTHORIZED**

This plan starts from Phase 2B CLOSED/PASS. It is intentionally split into approval gates so that no Production, Cloudflare route, writer, Render, or credential mutation is bundled into a broad approval.

Overall migration progress at this checkpoint: **~88%**.

## Guiding architecture

```text
Exchange API
  -> approved normal server egress (Render current / Oracle candidate)
  -> Alpha engine
  -> protected storage/read models
  -> Cloudflare security/cache/delivery
  -> browser
```

Never allow:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare Tunnel is downstream ingress only. Browser-direct Binance WebSocket remains browser-direct.

---

# Phase 3 — Cloudflare Tunnel / private ingress qualification

Goal: prove a secure Free-tier Cloudflare-to-Oracle ingress path **without Production credentials, writer activation, Render cutover, or Production traffic**.

Phase 3 should itself be executed only after the owner approves the final reviewed Phase 3 plan.

## Phase 3A — source/static design review

Read-only/source-only.

Tasks:

1. Fresh-read `CLOUDFLARE_DEPLOYMENT_RUNBOOK.md`, Wave Alpha security rules, this migration handoff and exact current Alpha source.
2. Fresh-verify Alpha PR heads/public CI.
3. Inspect Oracle service design and confirm the qualification service remains loopback-only/static/manual.
4. Decide the minimal Tunnel origin contract. Preferred qualification target is a dedicated local HTTP endpoint on Oracle, not a wildcard or SSH tunnel.
5. Define which endpoint is public-safe vs admin/internal.
6. Confirm no Tunnel route can trigger exchange upstream work merely by probing health.
7. Define fail-closed auth/caching behavior for any non-public-safe endpoint.
8. Produce exact source/config diff if any source change is necessary; do not deploy it yet.

PASS gate:

- exact origin/route contract documented;
- no Production credential needed;
- no writer required;
- no exchange fetch from Cloudflare;
- no new paid Cloudflare product required;
- source/static tests PASS.

## Phase 3B — Cloudflare Free/auth/resource preflight

Read-only only.

Tasks:

1. Verify current Cloudflare operator auth with official read-only endpoint.
2. Verify exact account identity.
3. Verify current Free-tier/headroom for the resources needed by the exact design.
4. Inspect existing Tunnels, DNS records, Access applications/policies and conflicting routes.
5. Verify token scopes without printing token value.
6. Verify Oracle public/network state and service remains inactive/port 3100 absent before qualification mutation.
7. Record rollback/cleanup commands before creating anything.

FAIL CLOSED if:

- Free-tier status/headroom cannot be proven;
- resource collision exists and ownership is unclear;
- auth is stale/ambiguous;
- design requires paid fallback/overage;
- route would expose an admin/proprietary endpoint without reviewed auth.

## Phase 3C — create qualification-only Tunnel resources

**Requires explicit owner approval for this exact mutation.**

Preferred mutation scope:

1. Create/reuse one Cloudflare Tunnel for Alpha Oracle qualification.
2. Use a qualification-only hostname/route, clearly distinct from Production.
3. Configure tunnel credential/token on Oracle using secure local storage/service mechanism; never print it.
4. Do not point Production DNS/hostname to the candidate.
5. Do not start the Alpha Production service.
6. If a small dedicated qualification origin service is required, it must be separately approved and must not carry Production credentials or writer capability.
7. Confirm Cloudflare -> Tunnel -> Oracle connectivity.
8. Confirm Cloudflare cannot reach unrelated Oracle ports/services.
9. Confirm any private/admin route is protected by the reviewed Access/auth gate.
10. Verify the exchange upstream caller remains Oracle only; Cloudflare only forwards downstream requests.

## Phase 3D — bounded runtime qualification

Evidence to capture:

- Tunnel lifecycle/connector healthy;
- qualification hostname returns expected bounded response;
- TLS/HTTPS works end-to-end;
- origin is not directly exposed beyond intended state;
- protected path rejects unauthenticated request;
- authenticated qualification request succeeds;
- no Production credential present;
- no writer mutation occurs;
- no Render mutation;
- no Production DNS/traffic cutover;
- Oracle memory/CPU remain safely bounded;
- service/listener state after trial matches approved design;
- Cloudflare usage remains Free-compatible.

## Phase 3E — cleanup/closeout

If qualification resources are not needed immediately for Phase 4, remove qualification-only DNS/Access/Tunnel artifacts as appropriate. If the Tunnel is intentionally retained for Phase 4, record exact retained resources and ensure no Production route is active.

Phase 3 PASS means **Tunnel/private-ingress qualification PASS only**. It does not authorize Production credentials or cutover.

Expected migration progress after Phase 3 PASS: roughly **~92–93%**, subject to actual scope/results.

---

# Phase 4 — Production credential provisioning and single-writer cutover

Phase 4 is the highest-risk phase and must be split into separate owner approvals. Never interpret approval of one subphase as approval of the next.

## Phase 4A — Production cutover design freeze

Read-only/source-only.

Tasks:

1. Fresh-verify Render service state/source/deploy head/runtime configuration.
2. Fresh-verify Oracle candidate release/source/service state.
3. Fresh-verify Cloudflare Phase 3 retained resources and Free-tier state.
4. Inventory current canonical owners:
   - Binance/exchange fetch owner;
   - R2 projection writer owner;
   - Supabase canonical data ownership;
   - Competition historian ownership;
   - browser realtime websocket ownership.
5. Enumerate every Production credential needed by Oracle and classify:
   - read-only;
   - writer;
   - admin;
   - forbidden/not needed.
6. Define exact writer handoff so Render and Oracle can never be active writers concurrently.
7. Define rollback order before provisioning anything.
8. Confirm expected R2 object/read-model ownership and write-on-hash-change behavior.
9. Confirm no new D1/KV/DO/Queue/database owner is being introduced without explicit architecture need.
10. Review source flags so Production writer paths can remain OFF until the exact activation gate.

Deliverable: final cutover runbook with timestamps/checkpoints, no mutation.

## Phase 4B — Production secret provisioning

**Requires explicit owner approval specifically for Production secrets.**

Tasks:

1. Fresh Free-tier Vault/headroom check.
2. Fresh review of retained DEFAULT Vault/SOFTWARE key/Dynamic Group.
3. Define one least-privilege secret per necessary credential or a reviewed grouped structure; do not over-bundle unrelated privileges.
4. Provision Production credentials into OCI Vault without printing plaintext.
5. Create/update IAM policy only to the exact secrets required by the exact Oracle service identity.
6. Verify secret retrieval by instance principal using metadata/hash-safe or provider-safe probes; do not start writer service yet.
7. Keep Render unchanged.
8. Keep Oracle writer flags OFF.
9. Record rotation/revocation path for every credential.

PASS gate: Oracle can retrieve only the intended Production secrets; no writer activated; no secret leakage; Free-tier remains proven.

## Phase 4C — Oracle Production service candidate with writers OFF

**Requires separate approval for service start/restart/config activation.**

Tasks:

1. Stage exact reviewed release.
2. Configure Production service unit with strict limits, loopback/Tunnel origin, Vault credential retrieval, and writer flags OFF.
3. Start manually/bounded.
4. Verify health/auth/read APIs and live exchange upstream.
5. Verify no R2/Supabase writer calls/bytes and no finalize/backfill path.
6. Verify Cloudflare Tunnel path and cache behavior.
7. Verify resource usage on E2 Micro.
8. Stop/rollback if any forbidden mutation path appears.

PASS means Production-configured **read-only candidate runtime** only.

## Phase 4D — single-writer cutover

**Requires explicit owner approval for the exact cutover window.**

Preconditions:

- Phase 4A/B/C PASS;
- exact Render and Oracle heads verified;
- rollback command path ready;
- current data freshness checked;
- no pending unrelated migration/incident;
- owner explicitly approves the cutover operation.

Suggested cutover sequence:

1. Record pre-cutover canonical timestamps/cursors/materialized-object hashes.
2. Stop/disable the current Render writer path in the approved minimal way; verify it is no longer writing.
3. Only after Render writer absence is proven, enable Oracle writer credentials/flags.
4. Start/activate Oracle Production writer.
5. Verify Oracle is the **single** active writer.
6. Verify exchange upstream is healthy and not blocked.
7. Verify R2/Supabase writes occur only where expected.
8. Verify public read model freshness and schema compatibility.
9. Verify Cloudflare path delivers the intended read API.
10. Verify no duplicate writes, no sequence regression, no silent data loss.
11. Keep rollback window open until all gates pass.

Rollback trigger examples:

- Oracle exchange egress 403/418/429 or persistent upstream failure;
- writer errors/data corruption;
- duplicate writer evidence;
- R2/Supabase ownership violation;
- memory/resource pressure beyond safe E2 budget;
- Tunnel/auth failure affecting required read path;
- unexplained data freshness regression.

Rollback must preserve single-writer invariant. Do not reactivate Render writer before Oracle writer is first proven stopped.

## Phase 4E — Production cutover acceptance

Production PASS requires fresh evidence of:

- exact Oracle release running;
- correct Production secret retrieval;
- exact intended writers enabled and only one writer owner;
- Render no longer writing;
- Binance/exchange upstream healthy from Oracle;
- R2/Supabase/current read model fresh and correct;
- Cloudflare delivery/Tunnel healthy;
- bounded CPU/memory/network;
- no secret leakage;
- rollback path still valid;
- owner acceptance.

Production PASS still does not automatically mean Security PASS unless the security-specific gates are also completed.

Expected migration progress after Phase 4 acceptance: roughly **~98%**.

---

# Phase 5 — post-cutover observation, hardening and retirement

Only begin after Phase 4 Production acceptance.

## Phase 5A — observation window

Read-only/normal runtime observation unless a remediation is separately approved.

Observe:

- service health/restarts;
- E2 CPU/memory/swap/disk;
- Binance upstream status and rate-limit behavior;
- R2/Supabase write/read volumes;
- data freshness/latency;
- Cloudflare Tunnel/HTTP errors;
- duplicate-writer indicators;
- bandwidth/Free-tier usage;
- secret/Vault access errors;
- application error rate.

Do not fabricate zeros when metrics are unavailable.

## Phase 5B — rollback proof

Without causing a Production incident, prove the rollback instructions are current and executable at the control-plane level. Any actual live rollback drill requires explicit approval.

Confirm:

- Oracle writer can be stopped cleanly;
- Render recovery source/config still exists if retained for rollback window;
- credentials can be revoked/rotated in correct order;
- Cloudflare route can be reverted without changing exchange upstream ownership.

## Phase 5C — old runtime/credential retirement

**Requires explicit owner approval for each destructive/irreversible retirement.**

Candidate actions only after observation success:

- revoke old Render writer credentials;
- remove stale Render secrets;
- retire/suspend/delete Render service if owner chooses;
- remove qualification-only artifacts no longer needed;
- remove obsolete Oracle qualification unit/release if replaced by reviewed Production unit;
- retain only current Vault policies/secrets needed by Production;
- document final canonical runtime owner.

Do not delete rollback assets before owner accepts the end of the rollback window.

## Phase 5D — final documentation/source-of-truth update

Update:

- Alpha repo README/current migration docs;
- Wave Alpha current handoff/source-of-truth pointers where appropriate under documentation hygiene rules;
- exact Production owner/runtime branch/release;
- retained Cloudflare/Vault architecture;
- Free-tier assumptions and monitoring;
- decommissioned Render state;
- remaining security risks.

Close obsolete phase docs into Git history if the Wave Alpha authority docs require current-truth-only hygiene.

## Phase 5 final acceptance

A fully completed migration can be called CLOSED only when:

- Production Oracle owner is stable;
- single-writer invariant is proven over the observation period;
- old writer credentials/runtime are retired or intentionally retained with a documented reason;
- rollback/incident runbook is current;
- Free-tier posture remains valid;
- docs/source-of-truth are updated;
- no unresolved high-severity security/runtime blocker remains;
- owner explicitly accepts the migration closeout.

Expected migration progress after Phase 5 accepted closeout: **100%**.

---

# Review checklist for the next chat

Before executing Phase 3, the next chat must inspect current GitHub/runtime and return a reviewed plan that answers:

1. What exact Cloudflare resources already exist and which can be safely reused?
2. Is the required Tunnel/Access/DNS design fully Free at current usage/headroom?
3. What exact Oracle local origin will Tunnel target, and does it avoid Production credentials/writers?
4. What exact authentication protects proprietary/admin endpoints?
5. What exact source/config changes are needed, if any?
6. What one mutation is proposed first?
7. What is the independent postcheck?
8. What is the rollback/cleanup path?
9. What is explicitly excluded from Phase 3?
10. Which later Phase 4 operations require separate owner approvals?

The next chat must **STOP after presenting the final reviewed plan** unless the owner explicitly approves an execution step.
