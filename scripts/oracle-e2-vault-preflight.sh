#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

EXPECTED_INSTANCE_NAME="${EXPECTED_INSTANCE_NAME:-micro-server-auto-2}"
SERVICE_NAME="${SERVICE_NAME:-alpha-realtime-qualification.service}"
IMDS='http://169.254.169.254/opc/v2/instance/'

printf 'STEP=ORACLE_E2_PHASE2B_VAULT_PREFLIGHT\n'

JSON="$(curl --noproxy '*' -fsS --max-time 5 -H 'Authorization: Bearer Oracle' "$IMDS")" || {
  printf 'IDENTITY_GATE=FAIL_IMDS\n'
  exit 64
}

FIELDS="$(JSON="$JSON" python3 - <<'PY'
import json, os
j=json.loads(os.environ['JSON'])
for k in ('displayName','id','compartmentId','shape','region','availabilityDomain','faultDomain'):
    print(f'{k}={j.get(k, "")}')
PY
)"

NAME="$(printf '%s\n' "$FIELDS" | sed -n 's/^displayName=//p')"
SHAPE="$(printf '%s\n' "$FIELDS" | sed -n 's/^shape=//p')"
INSTANCE_ID="$(printf '%s\n' "$FIELDS" | sed -n 's/^id=//p')"
COMPARTMENT_ID="$(printf '%s\n' "$FIELDS" | sed -n 's/^compartmentId=//p')"

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
[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" == ocid1.instance.* ]] || {
  printf 'IDENTITY_GATE=FAIL_INSTANCE_OCID\n'
  exit 68
}
[[ -n "$COMPARTMENT_ID" && "$COMPARTMENT_ID" == ocid1.compartment.* ]] || {
  printf 'IDENTITY_GATE=FAIL_COMPARTMENT_OCID\n'
  exit 69
}

printf 'IDENTITY_GATE=PASS\n'
printf '%s\n' "$FIELDS"
printf 'hostname=%s\n' "$(hostname)"
printf 'architecture=%s\n' "$(uname -m)"
printf 'loadavg=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/ {printf "%s=%s_%s\n", $1,$2,$3}' /proc/meminfo

df -P -B1 / | awk 'NR==2 {printf "root_bytes_total=%s\nroot_bytes_used=%s\nroot_bytes_available=%s\nroot_used_percent=%s\n",$2,$3,$4,$5}'

if command -v oci >/dev/null 2>&1; then
  printf 'OCI_CLI_PRESENT=YES\n'
  printf 'OCI_CLI_VERSION=%s\n' "$(oci --version 2>/dev/null | head -n1)"
else
  printf 'OCI_CLI_PRESENT=NO\n'
fi

set +e
systemctl is-active --quiet "$SERVICE_NAME"
ACTIVE_RC=$?
systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null
ENABLED_RC=$?
set -e

printf 'SERVICE_ACTIVE_RC=%s\n' "$ACTIVE_RC"
printf 'SERVICE_ENABLED_RC=%s\n' "$ENABLED_RC"

STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
printf 'SERVICE_STATE=%s\n' "$STATE"
[[ "$STATE" != active ]]

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BINDINGS=%s\n' "${LISTEN_3100:-NONE}"
[[ -z "$LISTEN_3100" ]]

for path in \
  /run/wave-alpha-alpha/credentials \
  /run/wave-alpha-alpha/credentials.new \
  /run/wave-alpha-alpha/credentials.upload
do
  if sudo test -e "$path"; then
    printf 'RUNTIME_CREDENTIAL_PATH_PRESENT=%s\n' "$path"
    exit 70
  else
    printf 'RUNTIME_CREDENTIAL_PATH_ABSENT=%s\n' "$path"
  fi
done

printf 'PREFLIGHT_MUTATION=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'PHASE2B_VAULT_PREFLIGHT=PASS\n'
printf 'BLOCK_DONE=YES\n'
