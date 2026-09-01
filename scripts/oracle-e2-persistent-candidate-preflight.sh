#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

EXPECTED_INSTANCE_NAME="${EXPECTED_INSTANCE_NAME:-micro-server-auto-2}"
EXPECTED_RELEASE_SHA="${EXPECTED_RELEASE_SHA:-}"
APP_ROOT="${APP_ROOT:-/opt/wave-alpha/alpha-realtime}"
NODE_ROOT="${NODE_ROOT:-/opt/wave-alpha/node}"
SERVICE_NAME="alpha-realtime-qualification.service"

printf 'STEP=ORACLE_E2_PHASE2_PERSISTENT_CANDIDATE_PREFLIGHT\n'

IMDS='http://169.254.169.254/opc/v2/instance/'
JSON="$(curl --noproxy '*' -fsS --max-time 5 -H 'Authorization: Bearer Oracle' "$IMDS")" || {
  printf 'IDENTITY_GATE=FAIL_IMDS\n'
  exit 64
}

FIELDS="$(JSON="$JSON" python3 - <<'PY'
import json, os
j=json.loads(os.environ['JSON'])
for k in ('displayName','shape','region','availabilityDomain','faultDomain'):
    print(f'{k}={j.get(k, "")}' )
PY
)"

NAME="$(printf '%s\n' "$FIELDS" | sed -n 's/^displayName=//p')"
SHAPE="$(printf '%s\n' "$FIELDS" | sed -n 's/^shape=//p')"

[[ "$NAME" == "$EXPECTED_INSTANCE_NAME" ]] || {
  printf 'IDENTITY_GATE=FAIL_NAME expected=%s actual=%s\n' "$EXPECTED_INSTANCE_NAME" "$NAME"
  exit 65
}
[[ "$NAME" != 'micro-server-auto' ]] || {
  printf 'IDENTITY_GATE=FAIL_LIQUIDATION_VM\n'
  exit 66
}
[[ "$SHAPE" == 'VM.Standard.E2.1.Micro' ]] || {
  printf 'IDENTITY_GATE=FAIL_SHAPE actual=%s\n' "$SHAPE"
  exit 67
}

printf 'IDENTITY_GATE=PASS\n'
printf '%s\n' "$FIELDS"
printf 'hostname=%s\n' "$(hostname)"
printf 'architecture=%s\n' "$(uname -m)"
printf 'loadavg=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/ {printf "%s=%s_%s\n", $1,$2,$3}' /proc/meminfo
df -P -B1 / | awk 'NR==2 {printf "root_bytes_total=%s\nroot_bytes_used=%s\nroot_bytes_available=%s\nroot_used_percent=%s\n",$2,$3,$4,$5}'

set +e
systemctl is-active --quiet "$SERVICE_NAME"
ACTIVE_RC=$?
systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null
ENABLED_RC=$?
id wavealpha-alpha >/dev/null 2>&1
USER_RC=$?
set -e

printf 'SERVICE_ACTIVE_RC=%s\n' "$ACTIVE_RC"
printf 'SERVICE_ENABLED_RC=%s\n' "$ENABLED_RC"
printf 'SERVICE_USER_EXISTS_RC=%s\n' "$USER_RC"

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BINDINGS=%s\n' "${LISTEN_3100:-NONE}"

for path in "$APP_ROOT" "$NODE_ROOT" /etc/systemd/system/alpha-realtime-qualification.service /run/wave-alpha-alpha/credentials; do
  if [[ -e "$path" ]]; then
    printf 'COLLISION_PRESENT=%s\n' "$path"
  else
    printf 'COLLISION_ABSENT=%s\n' "$path"
  fi
done

if [[ -n "$EXPECTED_RELEASE_SHA" && -d "$APP_ROOT/releases/$EXPECTED_RELEASE_SHA" ]]; then
  printf 'EXPECTED_RELEASE_PRESENT=YES\n'
  if [[ -f "$APP_ROOT/releases/$EXPECTED_RELEASE_SHA/package-lock.json" ]]; then
    printf 'EXPECTED_RELEASE_LOCK_SHA256=%s\n' "$(sha256sum "$APP_ROOT/releases/$EXPECTED_RELEASE_SHA/package-lock.json" | awk '{print $1}')"
  else
    printf 'EXPECTED_RELEASE_LOCK_SHA256=UNAVAILABLE\n'
  fi
else
  printf 'EXPECTED_RELEASE_PRESENT=NO\n'
fi

printf 'PREFLIGHT_MUTATION=NO\n'
printf 'PREFLIGHT_DONE=YES\n'
