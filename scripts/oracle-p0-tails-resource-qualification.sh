#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

QUAL_DIR="${QUAL_DIR:-/tmp/wa-tail-qual}"
EXPECTED_RELEASE_SHA="${EXPECTED_RELEASE_SHA:-4a83777645c6de29c69cc3c2351b928bb0236f65}"
EXPECTED_QUAL_SHA="${EXPECTED_QUAL_SHA:-}"
SERVICE="${SERVICE:-alpha-realtime-production-readonly.service}"
NODE_BIN="${NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
CURRENT_APP="${CURRENT_APP:-/opt/wave-alpha/alpha-realtime/current}"
CRED_DIR="${CRED_DIR:-/run/wave-alpha-alpha/credentials}"
R2_ENDPOINT_URL="${R2_ENDPOINT_URL:-https://0f534c1b6f9bc097235b37c07d1dc32e.r2.cloudflarestorage.com}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-wave-alpha-data}"
MAX_TOKENS="${TAILS_QUAL_MAX_TOKENS:-24}"
CONCURRENCY="${TAILS_QUAL_CONCURRENCY:-2}"
REQUEST_BUDGET="${TAILS_QUAL_MAX_REQUESTS:-320}"

printf '=== ORACLE_P0_TAILS_RESOURCE_QUAL_BEGIN ===\n'
printf 'MUTATION_SCOPE=TMP_ONLY_NO_SERVICE_CHANGE_NO_R2_WRITE\n'
printf 'SERVICE=%s\n' "$SERVICE"

[[ -n "$EXPECTED_QUAL_SHA" ]] || {
  printf 'QUAL_SHA_GATE=FAIL reason=missing_expected_sha\n'
  exit 64
}

for path in   "$QUAL_DIR/lib/tails-cache-contract.js"   "$QUAL_DIR/lib/tails-producer.js"   "$QUAL_DIR/scripts/tails-resource-qualification.js"   "$QUAL_DIR/MANIFEST.sha256"   "$QUAL_DIR/SOURCE_SHA"
do
  [[ -r "$path" ]] || {
    printf 'STAGED_SOURCE_GATE=FAIL path=%s\n' "$path"
    exit 65
  }
done

actual_qual_sha="$(tr -d '[:space:]' < "$QUAL_DIR/SOURCE_SHA")"
if [[ "$actual_qual_sha" != "$EXPECTED_QUAL_SHA" ]]; then
  printf 'QUAL_SHA_GATE=FAIL expected=%s actual=%s\n' "$EXPECTED_QUAL_SHA" "$actual_qual_sha"
  exit 66
fi
printf 'QUAL_SHA_GATE=PASS sha=%s\n' "$actual_qual_sha"

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
if [[ "$current_target" != *"/releases/$EXPECTED_RELEASE_SHA" ]]; then
  printf 'CURRENT_RELEASE_GATE=FAIL expected=%s\n' "$EXPECTED_RELEASE_SHA"
  exit 69
fi
printf 'CURRENT_RELEASE_GATE=PASS\n'

service_state="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
printf 'SERVICE_STATE_BEFORE=%s\n' "${service_state:-unknown}"
[[ "$service_state" == active ]] || {
  printf 'SERVICE_GATE=FAIL\n'
  exit 70
}

health_before="$(curl -sS -o /dev/null -w '%{http_code}'   --connect-timeout 2 --max-time 4   http://127.0.0.1:3100/health 2>/dev/null || true)"
printf 'HEALTH_BEFORE_HTTP=%s\n' "${health_before:-000}"
[[ "$health_before" == 200 ]] || {
  printf 'HEALTH_GATE_BEFORE=FAIL\n'
  exit 71
}

IMDS_FILE="$(mktemp /tmp/wa-tail-imds.XXXXXX)"
RESULT_FILE="$(mktemp /tmp/wa-tail-qual-result.XXXXXX)"
cleanup() {
  rm -f "$IMDS_FILE" "$RESULT_FILE" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

imds_rc=0
set +e
curl -fsS   --connect-timeout 2   --max-time 4   -H 'Authorization: Bearer Oracle'   http://169.254.169.254/opc/v2/instance/   >"$IMDS_FILE" 2>/dev/null
imds_rc=$?
set -e
printf 'IMDS_RC=%s\n' "$imds_rc"
[[ "$imds_rc" -eq 0 && -s "$IMDS_FILE" ]] || {
  printf 'SHAPE_GATE=FAIL reason=imds_unavailable\n'
  exit 72
}

shape="$(python3 - "$IMDS_FILE" <<'PY'
import json, pathlib, sys
obj=json.loads(pathlib.Path(sys.argv[1]).read_text())
print(obj.get("shape",""))
PY
)"
instance_name="$(python3 - "$IMDS_FILE" <<'PY'
import json, pathlib, sys
obj=json.loads(pathlib.Path(sys.argv[1]).read_text())
print(obj.get("displayName",""))
PY
)"
printf 'INSTANCE_NAME=%s\n' "${instance_name:-UNKNOWN}"
printf 'INSTANCE_SHAPE=%s\n' "${shape:-UNKNOWN}"
[[ "$shape" == 'VM.Standard.E2.1.Micro' ]] || {
  printf 'SHAPE_GATE=FAIL expected=VM.Standard.E2.1.Micro\n'
  exit 73
}
printf 'SHAPE_GATE=PASS\n'

mem_before_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
load_before="$(awk '{print $1}' /proc/loadavg)"
main_pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
service_rss_before_kb=0
if [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" -gt 0 && -r "/proc/$main_pid/status" ]]; then
  service_rss_before_kb="$(awk '/VmRSS:/ {print $2}' "/proc/$main_pid/status")"
fi
printf 'MEM_AVAILABLE_BEFORE_MB=%s\n' "$((mem_before_kb / 1024))"
printf 'LOAD1_BEFORE=%s\n' "$load_before"
printf 'SERVICE_RSS_BEFORE_MB=%s\n' "$((service_rss_before_kb / 1024))"

python3 - "$mem_before_kb" "$load_before" <<'PY'
import sys
mem_kb=int(sys.argv[1])
load=float(sys.argv[2])
if mem_kb < 300*1024:
    print("RESOURCE_PREFLIGHT=FAIL reason=mem_available_lt_300mb")
    raise SystemExit(1)
if load > 1.00:
    print("RESOURCE_PREFLIGHT=FAIL reason=load1_gt_1")
    raise SystemExit(1)
print("RESOURCE_PREFLIGHT=PASS")
PY

for name in R2_READ_ONLY_ACCESS_KEY_ID R2_READ_ONLY_SECRET_ACCESS_KEY; do
  sudo -n test -s "$CRED_DIR/$name" || {
    printf 'CREDENTIAL_GATE=FAIL name=%s\n' "$name"
    exit 74
  }
done
printf 'CREDENTIAL_GATE=PASS values_printed=NO\n'

r2_id="$(sudo -n cat "$CRED_DIR/R2_READ_ONLY_ACCESS_KEY_ID")"
r2_secret="$(sudo -n cat "$CRED_DIR/R2_READ_ONLY_SECRET_ACCESS_KEY")"
[[ -n "$r2_id" && -n "$r2_secret" ]] || {
  printf 'CREDENTIAL_GATE=FAIL reason=empty\n'
  exit 75
}

qual_rc=0
set +e
sudo -n -u wavealpha-alpha env   NODE_PATH="$CURRENT_APP/node_modules"   R2_ENDPOINT_URL="$R2_ENDPOINT_URL"   R2_BUCKET_NAME="$R2_BUCKET_NAME"   R2_READ_ONLY_ACCESS_KEY_ID="$r2_id"   R2_READ_ONLY_SECRET_ACCESS_KEY="$r2_secret"   TAILS_QUALIFICATION_ONLY=true   TAILS_QUAL_MAX_TOKENS="$MAX_TOKENS"   TAILS_QUAL_CONCURRENCY="$CONCURRENCY"   TAILS_QUAL_MAX_REQUESTS="$REQUEST_BUDGET"   "$NODE_BIN" "$QUAL_DIR/scripts/tails-resource-qualification.js"   >"$RESULT_FILE" 2>&1
qual_rc=$?
set -e
unset r2_id r2_secret

printf 'QUALIFICATION_RC=%s\n' "$qual_rc"
tail -n 20 "$RESULT_FILE"

service_state_after="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
health_after="$(curl -sS -o /dev/null -w '%{http_code}'   --connect-timeout 2 --max-time 4   http://127.0.0.1:3100/health 2>/dev/null || true)"
mem_after_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
load_after="$(awk '{print $1}' /proc/loadavg)"
service_rss_after_kb=0
if [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" -gt 0 && -r "/proc/$main_pid/status" ]]; then
  service_rss_after_kb="$(awk '/VmRSS:/ {print $2}' "/proc/$main_pid/status")"
fi

printf 'SERVICE_STATE_AFTER=%s\n' "${service_state_after:-unknown}"
printf 'HEALTH_AFTER_HTTP=%s\n' "${health_after:-000}"
printf 'MEM_AVAILABLE_AFTER_MB=%s\n' "$((mem_after_kb / 1024))"
printf 'LOAD1_AFTER=%s\n' "$load_after"
printf 'SERVICE_RSS_AFTER_MB=%s\n' "$((service_rss_after_kb / 1024))"

[[ "$qual_rc" -eq 0 ]] || {
  printf 'SMOKE_QUALIFICATION=FAIL reason=workload\n'
  exit 76
}
[[ "$service_state_after" == active && "$health_after" == 200 ]] || {
  printf 'SMOKE_QUALIFICATION=FAIL reason=realtime_health\n'
  exit 77
}

printf 'R2_WRITE_PERFORMED=NO\n'
printf 'SERVICE_RESTARTED=NO\n'
printf 'SCHEDULER_CHANGED=NO\n'
printf 'SMOKE_QUALIFICATION=PASS\n'
printf 'RESOURCE_DECISION=PENDING_REVIEW\n'
printf '=== ORACLE_P0_TAILS_RESOURCE_QUAL_END ===\n'
