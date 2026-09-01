# Oracle E2 Migration — Phase 2B Vault / Instance Principal Qualification

Status: **SOURCE PREP / OWNER APPROVED 2026-09-01 / NOT PRODUCTION**

Phase 2A proved the persistent Oracle candidate on `micro-server-auto-2` at source head `95912355bb447db4484f879945f27e5502b7b623`: loopback-only runtime, live Binance egress, R2/Supabase read-only access, zero observed writer bytes, bounded memory, clean stop, and credential cleanup. Phase 2B qualifies a persistent secret source without provisioning Production credentials.

## Goal

Prove the least-privilege OCI-native path:

```text
micro-server-auto-2
  -> OCI instance principal
  -> exact dynamic-group membership for this instance
  -> IAM read secret-bundles for one exact qualification secret OCID
  -> OCI Vault CURRENT secret bundle
```

The qualification secret contains only a random marker. Its plaintext must never be printed, committed, logged, or persisted outside bounded memory/tmpfs handling.

## Free-tier contract

Before any OCI mutation, verify current tenancy limits and usage. Phase 2B may use only Always Free-compatible Vault resources. Do not create a virtual private vault, paid key protection, paid compute shape, or hidden paid fallback.

Current Oracle documentation states that software-protected master encryption keys are free and that tenancies receive 150 Always Free Vault secrets. Runtime evidence must still verify current tenancy headroom before creation.

## Phase 2B qualification scope

Owner approval covers this qualification-only scope:

1. read-only verify `micro-server-auto-2` identity, shape `VM.Standard.E2.1.Micro`, region/compartment/instance OCID and current service/listener state;
2. read-only verify OCI CLI/operator auth and current Vault/key/secret limits and usage;
3. create or reuse one non-private Vault and one software-protected master encryption key only if Free-tier headroom is proven;
4. create one random qualification marker secret;
5. create a dynamic group whose matching rule identifies only `micro-server-auto-2` by exact instance OCID;
6. create an IAM policy granting that dynamic group only `read secret-bundles` for the exact qualification secret OCID;
7. from `micro-server-auto-2`, retrieve the CURRENT secret through `--auth instance_principal` and compare only SHA-256 evidence;
8. keep Alpha service stopped/inactive during this Vault qualification;
9. delete/schedule deletion of the qualification marker secret after PASS and remove any local marker/hash material;
10. retain only reviewed Free-tier Vault/key/IAM infrastructure if useful for the later Production-secret gate.

## Explicitly excluded

- no R2/Supabase/Render Production credential provisioning;
- no Production secret migration or rotation;
- no Alpha service start/restart/enable;
- no Cloudflare Tunnel/DNS/route;
- no Production traffic or cutover;
- no Render change;
- no `main` mutation;
- no database/R2/Supabase writer activation;
- no Cloudflare exchange upstream fetch;
- no GitHub-hosted exchange upstream fetch.

## Least-privilege IAM shape

Dynamic-group membership must identify only the exact candidate instance, not all instances in a compartment.

The secret-read policy must be narrowed to the qualification secret OCID, conceptually:

```text
Allow dynamic-group <phase2b-group> to read secret-bundles in compartment <compartment>
  where target.secret.id='<qualification-secret-ocid>'
```

Do not grant `manage secret-family`, tenancy-wide secret access, key-management permissions, or access to unrelated secrets merely for convenience.

## Acceptance gates

Phase 2B PASS requires fresh evidence of all of the following:

- exact candidate identity and E2 Micro shape PASS;
- Alpha qualification service inactive and port 3100 absent throughout the Vault-only probe;
- current Free-tier headroom proven before resource creation;
- non-private Vault / software-protected key only;
- dynamic group exact-instance rule confirmed;
- policy exact-secret read scope confirmed;
- `oci secrets secret-bundle get --auth instance_principal` succeeds from the candidate;
- retrieved plaintext is never printed and its SHA-256 matches the locally generated qualification marker hash;
- no Production credential was used;
- qualification secret is scheduled for deletion/removed at closeout;
- no Production traffic, Render, Cloudflare route, service activation, or `main` change.

Phase 2B PASS remains **not Production PASS and not Security PASS**.

## Later gates

- Phase 3: Cloudflare Tunnel/private ingress qualification.
- Phase 4: separately approved Production credential provisioning, single-writer handoff and Render -> Oracle cutover.
- Phase 5: post-cutover observation, rollback proof and retirement decisions.
