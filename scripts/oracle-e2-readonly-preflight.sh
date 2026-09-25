#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

EXPECTED_INSTANCE_NAME="${EXPECTED_INSTANCE_NAME:-}"
if [[ -z "$EXPECTED_INSTANCE_NAME" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=EXPECTED_INSTANCE_NAME_REQUIRED\n' >&2
  exit 64
fi
if [[ "$EXPECTED_INSTANCE_NAME" == "micro-server-auto" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=LIQUIDATION_VM_IS_OUT_OF_SCOPE\n' >&2
  exit 65
fi

IMDS_URL='http://169.254.169.254/opc/v2/instance/'
IMDS_JSON="$(curl --noproxy '*' -fsS --max-time 5 -H 'Authorization: Bearer Oracle' "$IMDS_URL")" || {
  printf 'PREFLIGHT=REFUSED\nREASON=OCI_IMDS_UNAVAILABLE\n' >&2
  exit 66
}

INSTANCE_FIELDS="$(IMDS_JSON="$IMDS_JSON" python3 - <<'PY'
import json, os
j=json.loads(os.environ['IMDS_JSON'])
for key in ('displayName','shape','region','availabilityDomain','faultDomain'):
    value=j.get(key)
    if value is not None:
        print(f'{key}={value}')
PY
)"

DISPLAY_NAME="$(printf '%s\n' "$INSTANCE_FIELDS" | sed -n 's/^displayName=//p' | head -n 1)"
SHAPE="$(printf '%s\n' "$INSTANCE_FIELDS" | sed -n 's/^shape=//p' | head -n 1)"

if [[ -z "$DISPLAY_NAME" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=OCI_DISPLAY_NAME_MISSING\n' >&2
  exit 67
fi
if [[ "$DISPLAY_NAME" == "micro-server-auto" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=LIQUIDATION_VM_DETECTED\n' >&2
  exit 68
fi
if [[ "$DISPLAY_NAME" != "$EXPECTED_INSTANCE_NAME" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=INSTANCE_NAME_MISMATCH\nEXPECTED=%s\nACTUAL=%s\n' "$EXPECTED_INSTANCE_NAME" "$DISPLAY_NAME" >&2
  exit 69
fi
if [[ "$SHAPE" != "VM.Standard.E2.1.Micro" ]]; then
  printf 'PREFLIGHT=REFUSED\nREASON=UNEXPECTED_SHAPE\nEXPECTED_SHAPE=VM.Standard.E2.1.Micro\nACTUAL_SHAPE=%s\n' "$SHAPE" >&2
  exit 70
fi

printf 'PREFLIGHT_IDENTITY=PASS\n'
printf '%s\n' "$INSTANCE_FIELDS"
printf 'hostname=%s\n' "$(hostname)"
printf 'architecture=%s\n' "$(uname -m)"
printf 'kernel=%s\n' "$(uname -r)"
printf 'cpu_online=%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc)"
printf 'loadavg=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"

awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/ {printf "%s=%s_%s\n", $1, $2, $3}' /proc/meminfo

df -P -B1 / | awk 'NR==2 {printf "root_bytes_total=%s\nroot_bytes_used=%s\nroot_bytes_available=%s\nroot_used_percent=%s\n", $2,$3,$4,$5}'

printf 'listen_tcp_count=%s\n' "$(ss -ltnH 2>/dev/null | wc -l | tr -d ' ')"

probe() {
  local name="$1"
  local url="$2"
  local result
  set +e
  result="$(curl -sS --max-time 15 -o /dev/null \
    -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' \
    -H 'client-type: web' \
    -w 'http=%{http_code} bytes=%{size_download} time=%{time_total}' \
    "$url" 2>&1)"
  local rc=$?
  set -e
  printf 'exchange_probe_%s_rc=%s %s\n' "$name" "$rc" "$result"
}

# These probes intentionally originate from the candidate Oracle server. Do not
# move them to Cloudflare Workers/Pages Functions or GitHub-hosted execution.
probe 'alpha_bulk' 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/aggTicker24?dataType=aggregate'
probe 'token_list' 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list'

printf 'PREFLIGHT_DONE=YES\n'
