# MASTER PROMPT — FINAL Phase 3 Execution Handoff

Repository task: `annachou5566/alpha-realtime-bot`
Overall Wave Alpha authority: `annachou5566/wave-alpha@test-wavealpha`

Tiếp tục Alpha Realtime Render -> Oracle E2 migration từ checkpoint **Phase 2B CLOSED/PASS**.

Trả lời chủ yếu bằng tiếng Việt, ngắn, cụ thể, ưu tiên NEXT BEST ACTION. Không yêu cầu owner kể lại chat cũ. GitHub/runtime mới hơn thắng prompt/handoff cũ.

## Mandatory read order

1. `wave-alpha/README.md` trên `test-klinechart`.
2. Fresh-verify Wave Alpha authority heads + current Alpha PR stack/public CI.
3. Current Wave Alpha operating/security/test/free-tier/Termux/Cloudflare runbooks.
4. Trong `alpha-realtime-bot`, đọc:
   - `README.md`
   - `ORACLE_E2_MIGRATION_PHASE1.md`
   - `ORACLE_E2_MIGRATION_PHASE2.md`
   - `ORACLE_E2_MIGRATION_PHASE2B.md`
   - `ORACLE_E2_MIGRATION_HANDOFF_2026-09-01.md`
   - `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md`
   - `ORACLE_E2_MIGRATION_PHASE3_5_FINAL_PLAN_2026-09-01.md`
5. Treat the earlier `ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md` as superseded for execution by the FINAL plan.

## Closed phases

```text
Phase 1   CLOSED/PASS
Phase 2A  CLOSED/PASS
Phase 2B  CLOSED/PASS — 100%
Overall migration checkpoint ~88%
```

Do not rerun closed PASS/FAIL gates without a concrete invalidator.

## Headroom rule — mandatory

Read and obey `ORACLE_E2_MIGRATION_HEADROOM_LEDGER_2026-09-01.md`.

Do **not** redo quota/headroom checks simply because this is a new chat.

Phase 3 must NOT rerun:
- OCI Vault/KMS/secret headroom from Phase 2B;
- E2 shape qualification;
- unrelated Cloudflare R2/Pages/Workers headroom.

Phase 3B checks only new resource classes needed by Phase 3:
- Zero Trust plan/account identity;
- Access app count;
- Access service-token count;
- Tunnel count/routes;
- DNS hostname collision;
- Access policy collision;
- operator permissions.

Check those once before first Phase-3 mutation and reuse that evidence through Phase 3 unless a concrete invalidator occurs.

Volatile Oracle RAM/disk/load/listeners/service/cloudflared state may be read fresh because those are runtime safety signals, not closed quota gates.

## Hard rules

- Free/Always Free only; no paid fallback/overage.
- Oracle target only `VM.Standard.E2.1.Micro` unless explicit owner approval.
- Current operator path: Android Termux -> Debian via `proot-distro` -> direct SSH -> Oracle.
- Avoid Bash process substitution `<(...)` on Termux/proot; use temp files.
- One consequential mutation per block: precheck -> mutation -> independent postcheck.
- Never blind retry create/delete after nonzero RC; inspect actual state first.
- Missing/unavailable != zero.
- Do not print/paste tokens, secret plaintext, API private keys, full OCI config, `.env`, Production credentials.
- Minimize printing resource OCIDs; prefer exact-name resolution into mode-600 temp files.
- When giving owner commands, explicitly say **copy from first line X to last line Y**.
- `main` mutation requires separate owner approval.
- Production secret, service start/restart/enable, Cloudflare Tunnel/DNS/route, writer activation, Render mutation, cutover, credential revoke/rotation and destructive retirement each require exact operation approval.

## Upstream egress invariant

Allowed:

```text
exchange API -> Render current / Oracle server egress -> Alpha -> storage/API -> Cloudflare delivery -> browser
```

Forbidden:

```text
Cloudflare Worker/Pages Function -> exchange API
GitHub-hosted execution -> exchange API
```

Cloudflare Tunnel is downstream ingress only. Browser Binance WebSocket remains browser-direct.

## Phase 2B retained state

Retained for later reviewed use:
- one Free-compatible DEFAULT Vault;
- one AES SOFTWARE key;
- exact-instance Dynamic Group for `micro-server-auto-2`.

Qualification secret is `PENDING_DELETION`; temporary exact-secret policy was deleted and verified absent. Do not cancel/recreate them without a new reason.

## Execution task now

Use `ORACLE_E2_MIGRATION_PHASE3_5_FINAL_PLAN_2026-09-01.md` as the execution plan.

### Execute Phase 3A + Phase 3B READ-ONLY now

Do not stop merely to ask approval for read-only inspection.

Phase 3A:
- source/static contract review;
- preserve Cloudflare-as-ingress-only invariant;
- preferred qualification origin is secretless `127.0.0.1:3101` responder;
- no Alpha Production service, Production secret or writer.

Phase 3B:
- read current Cloudflare auth/account;
- read only the new Phase-3 Zero Trust/Access/Tunnel counts/collisions defined in the headroom ledger;
- read Oracle volatile runtime health/listeners/cloudflared collision through Termux/direct SSH path;
- no install, create, route, start or mutation.

After Phase 3A/3B complete:

1. report exact findings;
2. update approximate progress only if justified;
3. provide the exact proposed first mutation and its independent postcheck;
4. **STOP before mutation** and request explicit owner approval for that operation.

The reviewed first proposed mutation, if 3B PASSes, is creation of one short-lived qualification-only Cloudflare Access service token. Its Client Secret must never be printed/chat/logged/screenshot and must be captured only into secure local temporary material.

## Phase 4 correction that must not be lost

Current `index.js` does not yet have an independently proven native Production-configured writer-OFF mode. Do not start Production-shaped `index.js` with writer credentials merely because an env flag says publishing is off.

Phase 4A must first implement/source-test a fail-closed Production-shaped read candidate with writer credentials unreachable and all canonical mutation paths independently blocked.

Writer credential reachability is deferred to the exact Phase 4D cutover gate.

## Phase 5 timing

Recommended stability checkpoints: 0–2h intensive, 24h durability, 48h minimum migration-stability closeout. A mandatory arbitrary seven-day wait is not a migration PASS requirement. Suspended Render rollback may be retained longer only as a deliberate Free/no-overage rollback decision.

End every technical checkpoint with:

```text
STATUS:
REMAINING RISK:
NEXT BEST ACTION:
```
