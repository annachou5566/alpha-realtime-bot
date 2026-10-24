# Alpha new-only credential cleanup — bounded readiness checkpoint (2026-10-24)

## Scope / authority

This checkpoint records **read-only ownership and startup investigation**, not an Oracle/Cloudflare change. Production service: `alpha-realtime-production-readonly.service` on `micro-server-auto-2` (161.118.219.31). Serving source: `ed0af597f525ce2295593d352530665ab4b38674`. Historical code rollback release: `0dd32a1f2faa869eba400736571e0d549205e4c8`. Current WaveAlpha authority remains `test-wavealpha`; authoritative incident handoff: `wave-alpha/docs/security/WAVEALPHA_MASTER_HANDOFF_2026-10-24_ALPHA_NEWONLY_AND_CLEANUP_AUDIT_PASS.md` at WaveAlpha task SHA `9ca891334c32b74a0f698f104ce3c52192cd7e8f`.

The latest owner approval permits completing the safe readiness/rollback plan. **It is not proof that deleting stale sources is safe. Do not interpret this document as authorization for deletion, reboot, restart or Production deployment.**

## Reused PASS (do not rerun without invalidator)

- Alpha Node22 Native 146/146; exact source stage/cutover.
- New API key accepted; old HTTP 401; anonymous/invalid HTTP 401; token/market/Alpha Node semantic PASS.
- Five effective systemd credential mappings, NO NEXT; current ACTIVE encrypted source and primary drop-in root-owned 0600.
- Cloudflare canonical Pages `2c9a5b88-5349-44db-81e9-6fb0755e7650`, unchanged UI v1.0.67 source, fresh Edge APIs PASS.
- Old plaintext, old NEXT ciphertext, old dual drop-in all PRESENT, root 0600; no mutation.

## New owner-provided evidence (all scoped read-only / RC 0)

1. Reference audit: 447 candidate files; exact old plaintext path referenced once (Alpha base service), old NEXT ciphertext path once (dual drop-in), generic API credential name in three Alpha unit/drop-in files. This is a **file-reference inventory**, not exhaustive consumer proof.
2. Boot audit: `/run=tmpfs`, service static; no WantedBy/RequiredBy/TriggeredBy or systemd boot symlinks in examined metadata; 21 additional boot files with zero matching old plaintext, NEXT and service exact-name references. Not real reboot qualification.
3. Final provisioning audit: four non-API credential source files in `/run/wave-alpha-alpha/credentials` root 0600, one hardlink each; the three retired artifacts each one hardlink; no configured ExecStartPre, ExecStartPost, EnvironmentFiles. `BOOT_PROVISION_OWNER=UNPROVEN`, `CLEANUP_GO=NO`, rollback runtime test not run.
4. Follow-up source-directory reference audit: 447 scoped files; **17** references to the shared credential directory, **3** references to `R2_READ_ONLY_ACCESS_KEY_ID`, **2** to `ALPHA_LIVE_PUBLISH_KEY`. 12 of the 17 directory-reference paths were omitted in the bounded prior output. References include external-advisory and bounded-recovery-qualification services. References are NOT proof of active consumers or provisioning writers.

## Safety implications

- ACTIVE encrypted `/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_WA20261024` and primary drop-in `zzzz-wa-alpha-read-key-primary.conf` **must be retained**.
- Potential cleanup targets are ONLY: `/run/wave-alpha-alpha/credentials/PRODUCTION_READ_API_SECRET_KEY`, `/etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT`, and `/etc/systemd/system/alpha-realtime-production-readonly.service.d/60-wavealpha-api-next.conf`. The NEXT ciphertext is an older encrypted envelope of the **new** key, not the compromised old plaintext. Neither source is currently an effective systemd mapping according to the accepted audit.
- The four other live credential source files under `/run` must be left untouched, including `ALPHA_LIVE_PUBLISH_KEY`. Do not move/copy their contents into logs, tests or another persistence owner.
- Production service is static and four required inputs are transient; startup after reboot is not qualified. Do not reboot as a cleanup test.
- Primary promotion operator's historical rollback code restores DUAL (including the compromised old key), so **never rerun that operator as a cleanup rollback**.
- Source inspection: old application release reads active `PRODUCTION_READ_API_SECRET_KEY` into `API_SECRET_KEY`. New-only **code** rollback appears compatible with the NEW credential name, but a code rollback/start is NOT runtime-qualified. Any rollback plan must retain the NEW encrypted mapping and reject old key.
- `/var/lib/systemd/credential.secret` not on encrypted media is an independently OPEN at-rest limitation; do not claim full-disk protection.

## Safe bounded next step

`scripts/wa-alpha-owner-attribution-readonly.sh` is an SHA-pinnable, filename/state-only audit that obtains **all** of the previous 17 path references and the ActiveState of directly referenced unit files. It has bounded filename depth/size/count and never prints source content; wrong host/root, empty/oversized scope fail closed. Local Bash syntax PASS and two synthetic mock tests PASS (expected host; wrong host); this is **operator test only, NOT a Production or reboot qualification**. Existing metadata PASS remains accepted.

**Decision tree:**
1. Obtain the missing file paths only once, classify each reference as consumer, provisioner, inactive/historical, or unknown; when source content is needed inspect it privately on the VM without outputting command args, env values or secrets. Any unknown is a HOLD.
2. Identify the trusted owner and persistence source for provisioning the four non-API transient credentials, startup activation mechanism and reboot recovery. Do not introduce duplicate secret stores or a second service owner. If no valid provision owner exists, treat reboot auto-recovery as OPEN and require separately reviewed redesign.
3. Prepare a source-only rollback procedure that keeps ACTIVE ciphertext, primary NEW_ONLY mapping, and all four existing other credentials. Qualify offline/synthetic first; actual rollback/restart is approval-gated and **not required just to feel certain**.
4. Propose removal of exactly three stale artifacts with path/inode/owner/mode/non-symlink/consumer guards and explicit owner authorization. Do not silently quarantine compromised plaintext into a new durable backup or restore old key trust.
5. After an authorized cleanup, independently verify the target paths and unchanged five effective mappings, active service and canonical Edge; preserve prior pass receipts and never claim comprehensive Security PASS.

## Gate truth

`SOURCE_REVIEW=PASS_SCOPED`; `STATIC_REFERENCE_INVENTORY=PASS_SCOPED`; `BOOT_AUTORECOVERY=OPEN`; `CLEANUP_GO=NO`; `CLEANUP_EXECUTED=NO`; `CHART_PRODUCTION_GO=NO`; `SECURITY_GLOBAL=OPEN`.

STATUS: Alpha live new-only/Edge PASS reused; bounded reference and provisioning audits PASS as read-only; cleanup not executed.

REMAINING RISK: 17 shared-directory references not fully attributed, missing boot provisioning owner and rollback runtime qualification, three stale artifacts still present; four other compromised identities remain OPEN.

NEXT BEST ACTION: Read-only classify 17 exact references with the new bounded script; then one decision: exact guarded cleanup proposal if provenance and new-only rollback proof are conclusive, otherwise HOLD without further broad scans.
