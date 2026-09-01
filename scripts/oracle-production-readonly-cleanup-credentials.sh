#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

SERVICE_NAME="${SERVICE_NAME:-alpha-realtime-production-readonly.service}"
QUAL_SERVICE_NAME="${QUAL_SERVICE_NAME:-alpha-realtime-qualification.service}"
TARGET_DIR="${TARGET_DIR:-/run/wave-alpha-alpha/credentials}"

printf 'STEP=ORACLE_PHASE4B_CLEANUP_PRODUCTION_READONLY_CREDENTIALS\n'

for unit in "$SERVICE_NAME" "$QUAL_SERVICE_NAME"; do
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  printf 'SERVICE_STATE name=%s state=%s\n' "$unit" "$state"
  [[ "$state" != active ]] || {
    printf 'SERVICE_STATE_GATE=FAIL_ACTIVE name=%s\n' "$unit"
    exit 64
  }
done

LISTEN_3100="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BEFORE=%s\n' "${LISTEN_3100:-NONE}"
[[ -z "$LISTEN_3100" ]] || {
  printf 'PORT_GATE=FAIL\n'
  exit 65
}

if sudo -n test -e "$TARGET_DIR"; then
  printf 'TARGET_BEFORE=PRESENT\n'
  sudo -n rm -rf "$TARGET_DIR"
  printf 'MUTATION_EXECUTED=YES_TMPFS_ONLY\n'
else
  printf 'TARGET_BEFORE=ABSENT\n'
  printf 'MUTATION_EXECUTED=NO_ALREADY_ABSENT\n'
fi

sudo -n test ! -e "$TARGET_DIR"
printf 'TARGET_AFTER=ABSENT\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'SERVICE_STARTED=NO\n'
printf 'BLOCK_DONE=YES\n'
