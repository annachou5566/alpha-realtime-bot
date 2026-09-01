# Oracle E2 Migration — Headroom Evidence Ledger

Checkpoint: **2026-09-01 after Phase 2B closeout**

Purpose: prevent repeated quota/headroom audits that were already completed and accepted. This ledger distinguishes **closed evidence that must be reused** from **new resource classes that have not yet been qualified**.

## Reuse rule

- A completed headroom PASS is **not rerun merely because a new chat starts**.
- Recheck only when a **new quota-consuming mutation depends on that exact resource class**, or when there is a **concrete invalidator** such as another actor/resource change, elapsed billing period that changes the relevant quota basis, account/plan change, or conflicting runtime evidence.
- Do not recheck unrelated resource classes. Example: Phase 3 Tunnel/Access work must not rerun OCI Vault, R2, Pages or Workers headroom just because those products exist in the architecture.
- Volatile runtime safety signals such as VM RAM/disk/load/listeners/service state are not quota headroom. They may need fresh read-only checks before a runtime mutation.
- Missing/unavailable remains **not zero**.

## OCI Vault / KMS — CLOSED Phase 2B evidence

Runtime limit discovery on 2026-09-01 proved:

```text
kms
  virtual-vault-count = 1
  virtual-vault-softwarekeyversion-count = 20
  virtual-private-vault-count = 0

secrets
  max-secrets-per-tenancy-count = 150
```

Fresh resource-availability before the Phase 2B Vault/secret mutations proved:

```text
virtual-vault-count used=0 available=1
max-secrets-per-tenancy-count used=0 available=150
```

Phase 2B then created and retained exactly one Free-compatible `DEFAULT` Vault, so the known Vault-slot state after creation is:

```text
virtual-vault-count used=1 available=0
```

Implication: **do not create another Vault**. Reuse the retained DEFAULT Vault for later reviewed Production-secret work unless the architecture is explicitly changed.

`virtual-private-vault-count=0` remains a hard signal that the migration must not use a virtual private Vault.

For the SOFTWARE-key limit, `resource-availability` returned `None`/unavailable rather than numeric usage. That was not converted to zero. Capacity was qualified instead by the configured limit plus exact key enumeration in the retained Vault:

```text
key count before qualification key create = 0
key count after create = 1
retained key protection mode = SOFTWARE
retained key state = ENABLED
```

Do **not** claim an exact numeric remaining software-key-version headroom from that evidence. Prefer reusing the retained SOFTWARE key when the security design allows it.

Secrets baseline:

```text
pre-create secrets used=0 available=150
one qualification secret was created
qualification secret final state=PENDING_DELETION
```

Exact post-create available count was not measured and must not be fabricated. This is irrelevant to Phase 3 because Phase 3 must not create OCI Vault secrets. Before a future Phase 4 Production-secret creation, refresh **only the exact Secrets resource class if needed for that mutation**; do not rerun Vault/key gates when reusing the retained Vault/key and no invalidator exists.

## OCI compute / Oracle VM

Candidate shape qualification is CLOSED/PASS:

```text
micro-server-auto-2
VM.Standard.E2.1.Micro
ap-singapore-1
```

Do not re-qualify the compute shape without a concrete invalidator. However memory, disk, load, service state and listeners are volatile runtime safety signals and may be read fresh before starting/installing a runtime component.

## Cloudflare evidence already available but not Phase-3 Zero Trust headroom

Previously recorded Wave Alpha Cloudflare evidence includes:

```text
Pages Free remaining: 496 at the prior accepted check
R2 bucket wave-alpha-data: prior accepted size about 1.14 GB / 148,285 objects
R2 August Class A / Class B usage: within Free at the prior accepted check
```

These values are **historical accepted evidence for those resource classes**. Do not rerun Pages/R2/Workers quota checks during Phase 3 unless the exact Phase 3 design unexpectedly consumes those products. Phase 3 should not do so.

These values do **not** prove Zero Trust / Access / Tunnel headroom. The following Phase-3-specific classes were not qualified in Phase 2B and therefore require one read-only Phase 3B baseline before their first mutation:

```text
Zero Trust plan/account identity
Access application count
Access service-token count
Tunnel count / conflicting routes
candidate DNS hostname collision
relevant Access policy collision
```

Current Cloudflare default account limits documented in 2026 include 500 Access applications and 50 service tokens, but product limits do not replace actual account usage. Phase 3B should measure these once and reuse the same fresh-session evidence across the approved Phase 3 mutations unless a concrete invalidator occurs.

## Render

Render plan/state is not treated as a quota headroom gate for Phase 3. The latest read-only plan review reported the Alpha service on the Free plan and suspended by the user. Do not repeatedly query Render during Phase 3 unless the operation depends on Render. Fresh-read it at the Phase 4 cutover design/cutover checkpoint because service state is mutable.

## Phase-specific rule summary

### Phase 3

Do not recheck:
- OCI Vault count / secret baseline / software-key qualification;
- Oracle E2 shape qualification;
- unrelated Cloudflare R2/Pages/Workers headroom.

Check once before the first Phase 3 mutation:
- Cloudflare Zero Trust/Access/Tunnel exact account usage and collisions;
- Cloudflare operator auth/account identity;
- Oracle volatile runtime health/listeners/cloudflared collision.

Reuse that evidence through Phase 3 unless invalidated.

### Phase 4

Reuse:
- retained DEFAULT Vault;
- retained SOFTWARE key where approved;
- retained exact-instance Dynamic Group;
- closed Phase 1/2A/2B qualification facts.

Refresh only what the exact Phase 4 mutation consumes or can have materially changed, for example:
- Secrets headroom before creating new Production secrets;
- Render current writer/service state at cutover;
- Oracle volatile runtime health;
- Cloudflare retained route/Access state if Phase 4 depends on it.

### Phase 5

Observation is not a reason to rerun closed quota gates. Recheck only resource classes where ongoing usage itself is part of the acceptance gate or where a destructive retirement depends on current state.
