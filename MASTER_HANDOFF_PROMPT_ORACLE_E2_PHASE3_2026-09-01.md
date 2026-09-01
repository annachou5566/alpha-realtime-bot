# MASTER PROMPT — Continue Alpha Realtime Render -> Oracle E2 Migration

Copy the prompt below into a fresh ChatGPT conversation.

---

Repository task: `annachou5566/alpha-realtime-bot`
Overall Wave Alpha authority: `annachou5566/wave-alpha@test-wavealpha`

Mục tiêu của chat mới: tiếp tục migration Alpha Realtime từ Render sang Oracle E2 Micro từ **checkpoint Phase 2B CLOSED/PASS**, nhưng **trước tiên chỉ audit/read-only + lập kế hoạch final chi tiết cho Phase 3–5 rồi DỪNG**. KHÔNG mutation cho tới khi owner đọc kế hoạch và phê duyệt operation cụ thể.

Trả lời chủ yếu bằng tiếng Việt, ngắn, cụ thể, ưu tiên NEXT BEST ACTION. Không yêu cầu tôi kể lại chat cũ. Không dựa vào trí nhớ chat cũ nếu GitHub/runtime có thể verify.

## BẮT BUỘC — CURRENT TRUTH FIRST

Trước mọi engineering/ops:

1. Đọc `README.md` trên `wave-alpha/test-klinechart`.
2. Fresh-verify heads: `test-wavealpha`, `test-klinechart`, `chatgpt/final-liquidation-stack-2026-08-11`, `main`, `staging-wavealpha`, current Alpha task branch/PR stack và public execution refs.
3. Đọc current Wave Alpha docs/runbooks liên quan:
   - `PROJECT_OPERATING_RULES.md`
   - `PROPRIETARY_DATA_SECURITY_POLICY.md`
   - `SECURITY_ARCHITECTURE_HANDBOOK.md`
   - `CHATGPT_HANDOFF.md`
   - `TEST_EXECUTION_POLICY.md`
   - `FREE_TIER_EXECUTION_POLICY.md`
   - `docs/operations/TERMUX_DIRECT_ORACLE_VM_RUNBOOK.md`
   - `CLOUDFLARE_DEPLOYMENT_RUNBOOK.md` trước bất kỳ Cloudflare planning/execution nào.
4. Đọc trên `annachou5566/alpha-realtime-bot` current task branch/PR:
   - `README.md`
   - `ORACLE_E2_MIGRATION_PHASE1.md`
   - `ORACLE_E2_MIGRATION_PHASE2.md`
   - `ORACLE_E2_MIGRATION_PHASE2B.md`
   - `ORACLE_E2_MIGRATION_HANDOFF_2026-09-01.md`
   - `ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md`
   - `scripts/oracle-vault-secret-read-probe.sh`
   - exact current PR metadata/head/public CI.
5. Fresh-read current Render, Oracle và Cloudflare state nếu connector/runtime cho phép. GitHub/runtime mới hơn luôn thắng SHA/state trong prompt này.
6. Không hỏi owner điều có thể tự verify read-only.

## HARD RULES

- `wave-alpha/test-wavealpha` = overall system authority.
- Không mutation `main` nếu chưa có explicit owner approval.
- Free / Always Free invariant; không paid fallback/overage.
- Oracle target chỉ `VM.Standard.E2.1.Micro` trừ khi owner explicit approve khác.
- Current operator path: Android Termux -> Debian via `proot-distro` -> direct SSH -> Oracle.
- Không route qua Oracle/Google Cloud Shell trừ khi owner explicit re-enable.
- Trên Termux/proot tránh Bash process substitution `<(...)`; dùng temp files.
- Remote Oracle interactive block bắt đầu:
  `export USER="${USER:-$(id -un)}"`
  `set -Eeuo pipefail`
- Command chỉ DONE khi fresh prompt trở lại.
- Một mutation quan trọng mỗi block: precheck -> mutation -> independent postcheck.
- Không blind retry create/delete khi RC != 0; verify actual state trước.
- Missing/unavailable != 0.
- Source PASS != Runtime PASS != Production PASS != Security PASS.
- Production deploy/cutover, service start/restart/enable, Production secrets, writer activation, Render mutation, Cloudflare Tunnel/DNS/route, DB/R2/Supabase mutation, credential rotation/revocation, retirement/destructive cleanup đều cần explicit owner approval đúng operation.
- Không in/paste token, secret plaintext, API private key, full OCI config, `.env`, Production credential. Hạn chế in resource OCID nếu có thể resolve bằng exact name + temp file.
- Khi đưa command cho owner, ghi rõ: **copy từ dòng nào đến dòng nào**.

## UPSTREAM EGRESS INVARIANT

BẮT BUỘC giữ:

`exchange API -> approved normal server egress (Render current / qualified Oracle) -> normalize/store/API -> Cloudflare delivery -> browser`

CẤM:

`Cloudflare Worker/Pages Function -> exchange API`
`GitHub-hosted execution -> exchange API`

Cloudflare Tunnel chỉ là downstream Cloudflare -> Oracle ingress. Không được biến Cloudflare thành Binance/exchange upstream caller.

Browser-direct Binance WebSocket realtime giữ browser-direct; không bắt E2 Micro fanout realtime.

## CLOSED STATE — KHÔNG RERUN KHÔNG CÓ INVALIDATOR

### Phase 1 = CLOSED/PASS

Đã prove:
- Oracle E2 Micro exact candidate;
- Binance direct server egress PASS, không 403/418/429 trong bounded trial;
- R2 read PASS;
- Supabase anon read PASS;
- loopback-only;
- protected unauth 401;
- qualified market 200/non-empty;
- no observed writer bytes;
- bounded memory;
- cleanup PASS.

### Phase 2A = CLOSED/PASS

Đã có persistent qualification candidate:
- Node 22 dưới `/opt/wave-alpha/node`;
- immutable release layout;
- `wavealpha-alpha` nologin user;
- `alpha-realtime-qualification.service` static/manual;
- `127.0.0.1:3100` only khi chạy qualification;
- MemoryMax 384M;
- runtime qualification PASS;
- service stop + runtime credential cleanup PASS.

### Phase 2B = CLOSED/PASS — 100%

Đã prove:
- local operator OCI `SECURITY_TOKEN` auth;
- VM OCI instance principal signer PASS;
- fresh Free-tier limits/headroom trước mutation;
- `DEFAULT` Vault ACTIVE, không virtual private;
- AES SOFTWARE key ENABLED;
- random 32-byte qualification secret ACTIVE;
- exact-instance Dynamic Group ACTIVE + semantic exact OCID PASS;
- exact-secret `read secret-bundles` policy ACTIVE và đúng 1 statement;
- source-reviewed `scripts/oracle-vault-secret-read-probe.sh` chạy trên VM bằng `--auth instance_principal`;
- CURRENT secret read RC=0;
- SHA-256 match YES;
- plaintext không print;
- service trước/sau = inactive;
- port 3100 trước/sau = NONE;
- remote/local probe cleanup PASS;
- Production credential used = NO;
- qualification secret đã schedule deletion và current final state = `PENDING_DELETION`;
- exact-secret qualification policy đã DELETE và postcheck absent;
- giữ lại cho gate sau: Free-compatible DEFAULT Vault + SOFTWARE key + exact-instance Dynamic Group;
- không Render mutation, không Cloudflare route, không Production traffic, không `main` mutation.

Phase 2B PASS KHÔNG phải Production PASS/Security PASS.

## IMPORTANT LESSONS — PHẢI KẾ THỪA

1. Root compartment: IMDS `compartmentId` có thể là tenancy OCID. Accept `ocid1.compartment.*` hoặc `ocid1.tenancy.*` sau identity verification.
2. OCI security-token profile có thể có `security_token_file`, key file, fingerprint nhưng không `user`. Phải classify auth; dùng `--auth security_token` explicit.
3. Session expiry chỉ là auth expiry; re-auth trước, không suy diễn Vault/IAM failure.
4. Không dùng lại OCI official installer design đầu tiên: nó tự chạy apt và fail `SameFileError` vì exec-dir collision.
5. OCI CLI remote corrected path: isolated pinned venv dưới `/opt/wave-alpha/oci-cli`, no apt on corrected path, no system PATH change.
6. Một số `oci ... list` đã trả RC=0 nhưng stdout/stderr = 0 bytes. Không coi đó là count=0. Dùng `oci raw-request`, parse HTTP `status`, JSON `data`, pagination header.
7. JMESPath/`--raw-output` có thể trả empty; acceptance gate nên parse raw JSON bằng Python.
8. `resource-availability` software-key limit từng trả `None`; unavailable không được biến thành zero. Dùng configured limit + exact key count proof.
9. Dynamic Group matching rule có thể bị OCI normalize. Verify semantic `instance.id` + exact instance OCID, không byte-string equality.
10. Secret deletion `+1 day` bị runtime reject `ScheduledTimeOfDeletion is in invalid range`; `+8 days` accepted. Runtime mới hơn thắng conflicting docs summary.
11. Deletion state chuyển `SCHEDULING_DELETION -> PENDING_DELETION`; không schedule lại khi đang transition.
12. Secret/token hygiene: chỉ print RC/hash/count/lifecycle; không print plaintext/token/private key/full config.
13. Khi chạy remote reviewed probe: fetch exact PR source -> verify Git blob/SHA256 -> scp -> verify remote SHA256 -> execute -> delete remote copy.
14. User muốn command block nhỏ, robust, và luôn nói rõ copy từ đâu đến đâu.

## CURRENT PROGRESS

Approx overall migration after Phase 2B: ~88%.

Remaining:
- Phase 3: Cloudflare Tunnel/private ingress qualification.
- Phase 4: Production credential provisioning + Production-configured candidate + single-writer Render -> Oracle cutover. Đây là nhiều approval gate riêng biệt.
- Phase 5: observation, rollback proof, credential/runtime retirement, final docs/acceptance.

## NHIỆM VỤ CỦA CHAT MỚI — BÂY GIỜ CHỈ PLAN, KHÔNG EXECUTE

Sau khi đọc/verify current truth, hãy review kỹ `ORACLE_E2_MIGRATION_PHASE3_5_PLAN_2026-09-01.md` và tự kiểm tra nó với current GitHub/runtime/official current Cloudflare/OCI behavior.

Sau đó đưa cho owner **FINAL DETAILED PLAN** bao gồm ít nhất:

### Phase 3
- Phase 3A source/static review;
- Phase 3B Cloudflare Free/auth/headroom + collision preflight;
- Phase 3C exact qualification-only Tunnel/Access/DNS mutation proposal;
- Phase 3D bounded runtime evidence;
- Phase 3E cleanup/retain decision;
- exact resource ownership;
- no exchange fetch from Cloudflare;
- no Production credential/writer/Render mutation;
- explicit PASS/FAIL gates;
- rollback/cleanup;
- exact first proposed mutation that would require owner approval.

### Phase 4
Tách ít nhất:
- 4A Production cutover design freeze/read-only;
- 4B Production Vault secret provisioning — separate approval;
- 4C Production-configured Oracle service with writer flags OFF — separate start/restart approval;
- 4D single-writer Render -> Oracle cutover — separate explicit cutover approval;
- 4E Production acceptance;
- exact single-writer proof and rollback order;
- credential lifecycle/rotation/revocation;
- R2/Supabase ownership preservation;
- no double writer window.

### Phase 5
- observation metrics + duration recommendation;
- rollback proof;
- old Render credential/service retirement gates;
- cleanup retained qualification/runtime artifacts;
- final source-of-truth documentation;
- criteria for 100% migration closeout;
- separate destructive approvals.

### PLAN OUTPUT REQUIREMENTS

- Nêu current verified heads/runtime facts.
- Nêu assumptions nào vẫn chưa verify.
- Nêu Free-tier/cost proof cần lấy trước mutation.
- Nêu security boundaries.
- Nêu exact approval gates.
- Nêu rollback path.
- Nêu estimated progress after each phase nhưng không inflate.
- Nêu `STATUS / REMAINING RISK / NEXT BEST ACTION`.

**BẮT BUỘC DỪNG SAU KẾ HOẠCH.**

Không sửa code, không commit, không tạo/update PR, không deploy, không start/restart service, không tạo Tunnel/DNS/Access, không provision Production secret, không mutate Render, không writer activation, không `main` mutation trong lượt lập kế hoạch này.

Owner sẽ copy kế hoạch đó để review/finalize. Chỉ sau khi owner trả lời phê duyệt rõ ràng operation cụ thể thì chat mới mới được bắt tay execution.
