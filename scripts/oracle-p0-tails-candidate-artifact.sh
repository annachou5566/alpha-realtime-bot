#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

QUAL_DIR="${QUAL_DIR:-/tmp/wa-tail-qual}"
EXPECTED_RELEASE_SHA="${EXPECTED_RELEASE_SHA:-4a83777645c6de29c69cc3c2351b928bb0236f65}"
EXPECTED_QUAL_SHA="${EXPECTED_QUAL_SHA:-}"
SERVICE="${SERVICE:-alpha-realtime-production-readonly.service}"
NODE_BIN="${NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
CURRENT_APP="${CURRENT_APP:-/opt/wave-alpha/alpha-realtime/current}"
OUTPUT="${TAILS_CANDIDATE_OUTPUT:-/tmp/wa-tails-v2-candidate.json}"
CONCURRENCY="${TAILS_CANDIDATE_CONCURRENCY:-2}"
REQUEST_BUDGET="${TAILS_CANDIDATE_MAX_REQUESTS:-2000}"

printf '=== ORACLE_P0_TAILS_CANDIDATE_BEGIN ===\n'
printf 'MUTATION_SCOPE=TMP_LOCAL_ARTIFACT_ONLY\n'
printf 'SERVICE=%s\n' "$SERVICE"
printf 'OUTPUT=%s\n' "$OUTPUT"

[[ -n "$EXPECTED_QUAL_SHA" ]] || {
  printf 'QUAL_SHA_GATE=FAIL reason=missing_expected_sha\n'
  exit 64
}

for path in   "$QUAL_DIR/lib/tails-cache-contract.js"   "$QUAL_DIR/lib/tails-producer.js"   "$QUAL_DIR/scripts/tails-candidate-artifact.js"   "$QUAL_DIR/MANIFEST.sha256"   "$QUAL_DIR/SOURCE_SHA"
do
  [[ -r "$path" ]] || {
    printf 'STAGED_SOURCE_GATE=FAIL path=%s\n' "$path"
    exit 65
  }
done

actual_sha="$(tr -d '[:space:]' < "$QUAL_DIR/SOURCE_SHA")"
[[ "$actual_sha" == "$EXPECTED_QUAL_SHA" ]] || {
  printf 'QUAL_SHA_GATE=FAIL expected=%s actual=%s\n' "$EXPECTED_QUAL_SHA" "$actual_sha"
  exit 66
}
printf 'QUAL_SHA_GATE=PASS sha=%s\n' "$actual_sha"

(
  cd "$QUAL_DIR"
  sha256sum -c MANIFEST.sha256 >/dev/null
)
printf 'STAGED_CHECKSUM_GATE=PASS\n'

[[ -x "$NODE_BIN" ]] || {
  printf 'NODE_GATE=FAIL path=%s\n' "$NODE_BIN"
  exit 67
}
[[ -d "$CURRENT_APP/node_modules" ]] || {
  printf 'DEPENDENCY_GATE=FAIL current_node_modules_missing\n'
  exit 68
}

current_target="$(readlink -f "$CURRENT_APP" 2>/dev/null || true)"
printf 'CURRENT_TARGET=%s\n' "${current_target:-UNKNOWN}"
[[ "$current_target" == *"/releases/$EXPECTED_RELEASE_SHA" ]] || {
  printf 'CURRENT_RELEASE_GATE=FAIL expected=%s\n' "$EXPECTED_RELEASE_SHA"
  exit 69
}
printf 'CURRENT_RELEASE_GATE=PASS\n'

service_state="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
health_before="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 http://127.0.0.1:3100/health 2>/dev/null || true)"
printf 'SERVICE_STATE_BEFORE=%s\n' "${service_state:-unknown}"
printf 'HEALTH_BEFORE_HTTP=%s\n' "${health_before:-000}"
[[ "$service_state" == active && "$health_before" == 200 ]] || {
  printf 'RUNTIME_GATE_BEFORE=FAIL\n'
  exit 70
}

IMDS_FILE="$(mktemp /tmp/wa-tail-candidate-imds.XXXXXX)"
RESULT_FILE="$(mktemp /tmp/wa-tail-candidate-result.XXXXXX)"
cleanup() {
  rm -f "$IMDS_FILE" "$RESULT_FILE" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

set +e
curl -fsS --connect-timeout 2 --max-time 4   -H 'Authorization: Bearer Oracle'   http://169.254.169.254/opc/v2/instance/ >"$IMDS_FILE" 2>/dev/null
imds_rc=$?
set -e
printf 'IMDS_RC=%s\n' "$imds_rc"
[[ "$imds_rc" -eq 0 && -s "$IMDS_FILE" ]] || {
  printf 'SHAPE_GATE=FAIL reason=imds_unavailable\n'
  exit 71
}

shape="$(python3 - "$IMDS_FILE" <<'PY'
import json, pathlib, sys
print(json.loads(pathlib.Path(sys.argv[1]).read_text()).get("shape",""))
PY
)"
printf 'INSTANCE_SHAPE=%s\n' "${shape:-UNKNOWN}"
[[ "$shape" == 'VM.Standard.E2.1.Micro' ]] || {
  printf 'SHAPE_GATE=FAIL expected=VM.Standard.E2.1.Micro\n'
  exit 72
}
printf 'SHAPE_GATE=PASS\n'

mem_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
load1="$(awk '{print $1}' /proc/loadavg)"
printf 'MEM_AVAILABLE_BEFORE_MB=%s\n' "$((mem_kb / 1024))"
printf 'LOAD1_BEFORE=%s\n' "$load1"

python3 - "$mem_kb" "$load1" <<'PY'
import sys
mem=int(sys.argv[1])
load=float(sys.argv[2])
if mem < 300*1024:
    print("RESOURCE_PREFLIGHT=FAIL reason=mem_available_lt_300mb")
    raise SystemExit(1)
if load > 1.00:
    print("RESOURCE_PREFLIGHT=FAIL reason=load1_gt_1")
    raise SystemExit(1)
print("RESOURCE_PREFLIGHT=PASS")
PY

[[ "$OUTPUT" == /tmp/wa-tails-v2-*.json ]] || {
  printf 'OUTPUT_GATE=FAIL reason=unbounded_path\n'
  exit 73
}
[[ ! -e "$OUTPUT" && ! -e "$OUTPUT.sha256" ]] || {
  printf 'OUTPUT_GATE=FAIL reason=already_exists\n'
  exit 74
}

printf 'CREDENTIAL_GATE=NOT_REQUIRED source=binance_first_party_only\n'

set +e
sudo -n -u wavealpha-alpha env   NODE_PATH="$CURRENT_APP/node_modules"   TAILS_CANDIDATE_ARTIFACT_ONLY=true   TAILS_CANDIDATE_OUTPUT="$OUTPUT"   TAILS_CANDIDATE_CONCURRENCY="$CONCURRENCY"   TAILS_CANDIDATE_MAX_REQUESTS="$REQUEST_BUDGET"   "$NODE_BIN" "$QUAL_DIR/scripts/tails-candidate-artifact.js"   >"$RESULT_FILE" 2>&1
candidate_rc=$?
set -e

printf 'CANDIDATE_RC=%s\n' "$candidate_rc"
tail -n 24 "$RESULT_FILE"

service_after="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
health_after="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 http://127.0.0.1:3100/health 2>/dev/null || true)"
printf 'SERVICE_STATE_AFTER=%s\n' "${service_after:-unknown}"
printf 'HEALTH_AFTER_HTTP=%s\n' "${health_after:-000}"

[[ "$candidate_rc" -eq 0 ]] || {
  printf 'CANDIDATE_GATE=FAIL reason=producer\n'
  exit 75
}
[[ -s "$OUTPUT" && -s "$OUTPUT.sha256" ]] || {
  printf 'CANDIDATE_GATE=FAIL reason=artifact_missing\n'
  exit 76
}
sudo -n -u wavealpha-alpha bash -lc '
  set -Eeuo pipefail
  cd "$1"
  sha256sum -c "$2" >/dev/null
' _ "$(dirname "$OUTPUT")" "$(basename "$OUTPUT.sha256")"
printf 'LOCAL_ARTIFACT_HASH_GATE=PASS\n'

[[ "$service_after" == active && "$health_after" == 200 ]] || {
  printf 'CANDIDATE_GATE=FAIL reason=realtime_health\n'
  exit 77
}

printf 'R2_WRITE_PERFORMED=NO\n'
printf 'SERVICE_RESTARTED=NO\n'
printf 'SCHEDULER_CHANGED=NO\n'
printf 'CANDIDATE_GATE=PASS\n'
printf '=== ORACLE_P0_TAILS_CANDIDATE_END ===\n'
