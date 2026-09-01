# Oracle E2 Migration — Phase 2B Vault / Instance Principal Qualification

Status: **CLOSED / PASS 2026-09-01 / NOT PRODUCTION / NOT SECURITY PASS**

Phase 2A proved the persistent Oracle candidate on `micro-server-auto-2`. Phase 2B proved the OCI-native persistent secret path without provisioning or using any Production credential.

## Proven path

```text
micro-server-auto-2
  -> OCI instance principal
  -> exact-instance dynamic group
  -> exact-secret `read secret-bundles` IAM policy
  -> OCI Vault CURRENT secret bundle
  -> SHA-256 match against random qualification marker
```

## Final runtime evidence

- candidate: `micro-server-auto-2`, `VM.Standard.E2.1.Micro`, Singapore;
- Alpha qualification service remained `inactive` throughout the Vault probe;
- port `3100` remained absent throughout the Vault probe;
- operator auth was a local OCI CLI `SECURITY_TOKEN` profile; no operator API private key was copied to the VM;
- VM instance-principal signer PASS;
- Free-tier headroom was checked before mutation;
- Vault type: `DEFAULT`, not virtual private;
- Vault became `ACTIVE`;
- one AES master key was created with `protection-mode=SOFTWARE` and became `ENABLED`;
- one random 32-byte qualification marker secret was created and became `ACTIVE`;
- marker plaintext stayed in tmpfs/bounded memory and was never printed;
- exact-instance Dynamic Group became `ACTIVE` and semantic verification proved the rule matched only the candidate instance OCID;
- exact-secret policy became `ACTIVE`, contained exactly one statement and granted only `read secret-bundles` for the qualification secret;
- source-reviewed `scripts/oracle-vault-secret-read-probe.sh` executed on the VM via `--auth instance_principal`;
- CURRENT secret read returned RC 0;
- decoded secret SHA-256 matched the locally generated expected SHA-256;
- remote probe script and local temporary material were cleaned;
- qualification secret was scheduled for deletion and reached `PENDING_DELETION`;
- exact-secret qualification policy was deleted and postchecked absent;
- retained for later reviewed use: Free-compatible Vault, SOFTWARE key, exact-instance Dynamic Group;
- no Alpha service start/restart/enable;
- no Render mutation;
- no Cloudflare Tunnel/DNS/route;
- no Production traffic/cutover;
- no Production credential provisioning/rotation/use;
- no `main` mutation.

Phase 2B PASS is qualification evidence only. It does **not** imply Production PASS or Security PASS.

## Safe command patterns that worked

Use placeholders or resolve OCIDs internally; do not echo secret values or session credentials.

### Operator session validation

```bash
oci session validate \
  --config-file /root/.oci/config \
  --profile WAVE_TERMUX \
  --auth security_token
```

If expired, re-authenticate interactively. Never paste the security token, private key or config contents into chat/logs.

### Instance-principal read-only signer proof

```bash
/opt/wave-alpha/oci-cli/current/bin/oci iam region list \
  --auth instance_principal \
  --region ap-singapore-1
```

### Use REST-body proof when normal CLI list output is empty

`oci kms management key list` and some IAM list commands were observed returning RC 0 with zero-byte stdout. The reliable fallback was signed raw OCI REST:

```bash
oci raw-request \
  --http-method GET \
  --target-uri "$OCI_SERVICE_URI" \
  --config-file /root/.oci/config \
  --profile WAVE_TERMUX \
  --auth security_token \
  --output json
```

Parse `status`, `data`, and pagination headers explicitly. Never infer empty output means zero resources.

### SOFTWARE key requirement

Always specify protection mode explicitly:

```bash
oci kms management key create \
  ... \
  --key-shape '{"algorithm":"AES","length":32}' \
  --protection-mode SOFTWARE
```

Do not rely on default protection mode.

### VM secret proof

The reviewed script is:

```text
scripts/oracle-vault-secret-read-probe.sh
```

It requires only the qualification secret OCID and expected SHA-256 as environment inputs, keeps the Alpha service stopped, writes returned base64 content only to tmpfs, decodes in-process, compares SHA-256, prints no plaintext, and cleans up.

## Important lessons / known traps

1. **Root compartment identity:** OCI IMDS may legitimately return the tenancy OCID as `compartmentId` when the instance is in the root compartment. Accept `ocid1.compartment.*` or `ocid1.tenancy.*`; do not assume root must have a compartment OCID.
2. **Security-token profile:** a valid OCI profile may have `security_token_file`, `key_file`, fingerprint, and no `user`. Classify auth before assuming API-key auth. Use `--auth security_token` explicitly.
3. **Expired session:** `oci session validate` can prompt for re-authentication. Re-auth first; do not treat expiry as IAM/Vault failure.
4. **Official OCI installer side effect:** the first installer path automatically ran `apt-get install python3-venv` and then failed with `SameFileError` because source/destination exec paths collided. Do not reuse that design.
5. **Preferred OCI CLI bootstrap:** isolated `/opt/wave-alpha/oci-cli/releases/<version>` Python venv, pinned binary wheels, `pip check`, import/version gate, symlink `current`; no system PATH change and no apt on the corrected path.
6. **CLI RC 0 + empty stdout:** observed for KMS/IAM list flows. Capture RC, stdout bytes and stderr bytes before parsing; use `oci raw-request` when needed.
7. **Missing/unavailable is not zero:** `resource-availability` returned `None` for software-key-version availability. We proved capacity through configured Free limit plus exact Vault key count instead of fabricating zero/available.
8. **Matching-rule normalization:** OCI may normalize formatting of Dynamic Group rules. Do semantic verification (`instance.id` + exact OCID), not byte-for-byte string equality.
9. **Secret deletion timing:** `+1 day` was rejected at runtime with `ScheduledTimeOfDeletion is in invalid range`. `+8 days` was accepted. Runtime evidence wins over conflicting documentation summaries.
10. **Deletion lifecycle:** after accepted scheduling the state first appeared as `SCHEDULING_DELETION`, then `PENDING_DELETION`. Do not assert only the final state immediately and do not reschedule while transition is in progress.
11. **One consequential mutation at a time:** precheck -> one mutation -> independent postcheck. If create/delete returns nonzero, do not blindly retry; resource creation may have succeeded while waiter/output failed.
12. **Termux/proot ergonomics:** avoid Bash process substitution (`<(...)`) and fragile giant heredocs. Prefer files under `/tmp` or `/dev/shm`, bounded output, and clearly labeled blocks.
13. **Secret hygiene:** do not print tokens, secret plaintext, private keys, full OCI config, `.env`, or Production credentials. Secret/resource OCIDs are not plaintext secrets, but minimize displaying them when a name lookup or temp file can resolve them.
14. **Source-reviewed runtime probes:** fetch exact script from exact PR head, verify Git blob/SHA-256 locally, transfer, verify remote SHA-256, execute, then delete remote copy.
15. **Keep upstream egress ownership correct:** Cloudflare and GitHub-hosted execution must never become Binance/exchange upstream callers. Oracle/approved server egress owns exchange calls.

## Phase 2B retained infrastructure

Retained deliberately for later gates:

- one Free-compatible `DEFAULT` Vault;
- one SOFTWARE-protected AES master key;
- one exact-instance Dynamic Group for `micro-server-auto-2`.

Removed / retiring:

- qualification exact-secret policy: deleted and verified absent;
- qualification marker secret: `PENDING_DELETION`;
- local/remote qualification marker material: cleaned.

Do not repurpose retained infrastructure for Production credentials without a new explicit owner approval and fresh Free/security checks.

## Next gates

- Phase 3: Cloudflare Tunnel/private ingress qualification only.
- Phase 4: separately approved Production credential provisioning and single-writer Render -> Oracle cutover.
- Phase 5: post-cutover observation, rollback proof and retirement/cleanup decisions.

See `ORACLE_E2_MIGRATION_HANDOFF_2026-09-01.md` and `ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md` for the current handoff and review-first roadmap.
