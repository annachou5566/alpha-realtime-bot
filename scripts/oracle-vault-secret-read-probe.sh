#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

SECRET_OCID="${VAULT_SECRET_OCID:-}"
EXPECTED_SHA256="${EXPECTED_SECRET_SHA256:-}"
SERVICE_NAME="${SERVICE_NAME:-alpha-realtime-qualification.service}"

printf 'STEP=ORACLE_E2_PHASE2B_VAULT_SECRET_READ_PROBE\n'

[[ -n "$SECRET_OCID" && "$SECRET_OCID" == ocid1.vaultsecret.* ]] || {
  printf 'SECRET_OCID_GATE=FAIL\n'
  exit 64
}
[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'EXPECTED_SHA256_GATE=FAIL\n'
  exit 65
}
command -v oci >/dev/null 2>&1 || {
  printf 'OCI_CLI_GATE=FAIL_MISSING\n'
  exit 66
}

STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
printf 'SERVICE_STATE_BEFORE=%s\n' "$STATE"
[[ "$STATE" != active ]]

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_BEFORE=%s\n' "${LISTEN_3100:-NONE}"
[[ -z "$LISTEN_3100" ]]

TMP="$(mktemp /dev/shm/wa-vault-probe.XXXXXX)"
chmod 600 "$TMP"
cleanup() {
  rm -f "$TMP"
}
trap cleanup EXIT HUP INT TERM

set +e
oci secrets secret-bundle get \
  --auth instance_principal \
  --secret-id "$SECRET_OCID" \
  --stage CURRENT \
  --query 'data."secret-bundle-content".content' \
  --raw-output \
  --no-retry \
  >"$TMP" 2>/dev/null
OCI_RC=$?
set -e

printf 'OCI_SECRET_READ_RC=%s\n' "$OCI_RC"
[[ "$OCI_RC" -eq 0 ]] || {
  printf 'INSTANCE_PRINCIPAL_SECRET_READ=FAIL\n'
  exit 67
}
[[ -s "$TMP" ]] || {
  printf 'SECRET_BUNDLE_CONTENT_GATE=FAIL_EMPTY\n'
  exit 68
}

ACTUAL_SHA256="$(python3 - "$TMP" <<'PY'
import base64, hashlib, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8').strip()
plain = base64.b64decode(raw, validate=True)
if not plain:
    raise SystemExit('empty decoded secret')
print(hashlib.sha256(plain).hexdigest())
PY
)"

[[ "$ACTUAL_SHA256" =~ ^[0-9a-f]{64}$ ]]
printf 'SECRET_SHA256_MATCH=%s\n' "$( [[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] && printf YES || printf NO )"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]]

rm -f "$TMP"
trap - EXIT HUP INT TERM

STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
printf 'SERVICE_STATE_AFTER=%s\n' "$STATE"
[[ "$STATE" != active ]]

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_AFTER=%s\n' "${LISTEN_3100:-NONE}"
[[ -z "$LISTEN_3100" ]]

printf 'INSTANCE_PRINCIPAL_AUTH=PASS\n'
printf 'VAULT_SECRET_READ=PASS\n'
printf 'SECRET_PLAINTEXT_PRINTED=NO\n'
printf 'PRODUCTION_CREDENTIAL_USED=NO\n'
printf 'PROBE_MUTATION=NO\n'
printf 'BLOCK_DONE=YES\n'
