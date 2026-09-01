#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

SERVICE_NAME="${SERVICE_NAME:-alpha-realtime-production-readonly.service}"
QUAL_SERVICE_NAME="${QUAL_SERVICE_NAME:-alpha-realtime-qualification.service}"
RUN_ROOT="${RUN_ROOT:-/run/wave-alpha-alpha}"
TARGET_DIR="$RUN_ROOT/credentials"
NEW_DIR="$RUN_ROOT/credentials.new"

R2_ID_SECRET="${R2_READ_ONLY_ACCESS_KEY_ID_SECRET_OCID:-}"
R2_SECRET_SECRET="${R2_READ_ONLY_SECRET_ACCESS_KEY_SECRET_OCID:-}"
SUPABASE_ANON_SECRET="${SUPABASE_ANON_KEY_SECRET_OCID:-}"
READ_API_SECRET="${PRODUCTION_READ_API_SECRET_KEY_SECRET_OCID:-}"

printf 'STEP=ORACLE_PHASE4B_MATERIALIZE_PRODUCTION_READONLY_CREDENTIALS\n'

for pair in \
  "R2_READ_ONLY_ACCESS_KEY_ID:$R2_ID_SECRET" \
  "R2_READ_ONLY_SECRET_ACCESS_KEY:$R2_SECRET_SECRET" \
  "SUPABASE_ANON_KEY:$SUPABASE_ANON_SECRET" \
  "PRODUCTION_READ_API_SECRET_KEY:$READ_API_SECRET"
do
  name="${pair%%:*}"
  secret_id="${pair#*:}"
  [[ "$secret_id" == ocid1.vaultsecret.* ]] || {
    printf 'SECRET_OCID_GATE=FAIL name=%s\n' "$name"
    exit 64
  }
done

OCI_BIN="${OCI_BIN:-/opt/wave-alpha/oci-cli/current/bin/oci}"
[[ -x "$OCI_BIN" ]] || {
  printf 'OCI_CLI_GATE=FAIL path=%s\n' "$OCI_BIN"
  exit 65
}

for unit in "$SERVICE_NAME" "$QUAL_SERVICE_NAME"; do
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  printf 'SERVICE_STATE name=%s state=%s\n' "$unit" "$state"
  [[ "$state" != active ]] || {
    printf 'SERVICE_STATE_GATE=FAIL_ACTIVE name=%s\n' "$unit"
    exit 66
  }
done

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BEFORE=%s\n' "${LISTEN_3100:-NONE}"
[[ -z "$LISTEN_3100" ]] || {
  printf 'PORT_GATE=FAIL\n'
  exit 67
}

sudo -n test ! -e "$TARGET_DIR" || {
  printf 'TARGET_COLLISION=YES\n'
  exit 68
}
sudo -n test ! -e "$NEW_DIR" || {
  printf 'NEW_DIR_COLLISION=YES\n'
  exit 69
}
printf 'TARGET_COLLISION=NO\n'
printf 'NEW_DIR_COLLISION=NO\n'

sudo -n install -d -o root -g root -m 0700 "$RUN_ROOT"
sudo -n install -d -o root -g root -m 0700 "$NEW_DIR"

TMP_FILES=()
cleanup() {
  for f in "${TMP_FILES[@]:-}"; do rm -f "$f" 2>/dev/null || true; done
  sudo -n rm -rf "$NEW_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

fetch_secret() {
  local name="$1"
  local secret_id="$2"
  local b64
  local out="$NEW_DIR/$name"
  local rc

  b64="$(mktemp "/dev/shm/wa-p4b-${name}.XXXXXX")"
  TMP_FILES+=("$b64")
  chmod 0600 "$b64"

  set +e
  "$OCI_BIN" secrets secret-bundle get \
    --auth instance_principal \
    --secret-id "$secret_id" \
    --stage CURRENT \
    --query 'data."secret-bundle-content".content' \
    --raw-output \
    --no-retry \
    >"$b64" 2>/dev/null
  rc=$?
  set -e

  printf 'SECRET_READ_RC name=%s rc=%s\n' "$name" "$rc"
  [[ "$rc" -eq 0 && -s "$b64" ]] || return 70

  sudo -n python3 - "$b64" "$out" <<'PY'
import base64
import os
import pathlib
import sys
src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
raw = src.read_text(encoding='utf-8').strip()
plain = base64.b64decode(raw, validate=True)
if not plain:
    raise SystemExit('empty decoded secret')
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    os.write(fd, plain)
finally:
    os.close(fd)
PY

  rm -f "$b64"
  sudo -n chown root:root "$out"
  sudo -n chmod 0600 "$out"
  sudo -n test -s "$out"
  printf 'SECRET_FILE_READY name=%s owner_mode=%s\n' "$name" "$(sudo -n stat -c '%U:%G_%a' "$out")"
}

fetch_secret R2_READ_ONLY_ACCESS_KEY_ID "$R2_ID_SECRET"
fetch_secret R2_READ_ONLY_SECRET_ACCESS_KEY "$R2_SECRET_SECRET"
fetch_secret SUPABASE_ANON_KEY "$SUPABASE_ANON_SECRET"
fetch_secret PRODUCTION_READ_API_SECRET_KEY "$READ_API_SECRET"

for name in R2_READ_ONLY_ACCESS_KEY_ID R2_READ_ONLY_SECRET_ACCESS_KEY SUPABASE_ANON_KEY PRODUCTION_READ_API_SECRET_KEY; do
  sudo -n test -s "$NEW_DIR/$name"
done

sudo -n mv "$NEW_DIR" "$TARGET_DIR"
trap - EXIT HUP INT TERM

printf 'MATERIALIZATION_MUTATION=YES_TMPFS_ONLY\n'
printf 'TARGET_DIR_READY=YES\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'SERVICE_STARTED=NO\n'
printf 'WRITER_CREDENTIAL_MATERIALIZED=NO\n'
printf 'BLOCK_DONE=YES\n'
