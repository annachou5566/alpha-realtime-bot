#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"
umask 077

NODE_BIN="${WAVE_ALPHA_NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
APP_DIR="${WAVE_ALPHA_APP_DIR:-/opt/wave-alpha/competition-analytics-writer/current}"
CRED_DIR="${CREDENTIALS_DIRECTORY:-}"

[[ -x "$NODE_BIN" ]] || { printf '[COMP-ANALYTICS] node unavailable\n' >&2; exit 65; }
[[ -d "$APP_DIR" ]] || { printf '[COMP-ANALYTICS] app directory unavailable\n' >&2; exit 66; }
[[ -n "$CRED_DIR" ]] || { printf '[COMP-ANALYTICS] credential directory unavailable\n' >&2; exit 67; }

for inherited in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY SUPABASE_SERVICE_ROLE_KEY
do
  if [[ -n "${!inherited:-}" ]]; then
    printf '[COMP-ANALYTICS] refusing inherited credential env: %s\n' "$inherited" >&2
    exit 68
  fi
done

R2_ID_FILE="$CRED_DIR/R2_TAILS_WRITE_ACCESS_KEY_ID"
R2_SECRET_FILE="$CRED_DIR/R2_TAILS_WRITE_SECRET_ACCESS_KEY"

for f in "$R2_ID_FILE" "$R2_SECRET_FILE"; do
  [[ -f "$f" ]] || { printf '[COMP-ANALYTICS] required credential file missing\n' >&2; exit 69; }
done

export R2_ACCESS_KEY_ID="$(cat "$R2_ID_FILE")"
export R2_SECRET_ACCESS_KEY="$(cat "$R2_SECRET_FILE")"

[[ -n "$R2_ACCESS_KEY_ID" && -n "$R2_SECRET_ACCESS_KEY" ]] || {
  printf '[COMP-ANALYTICS] empty R2 writer credential\n' >&2
  exit 70
}

cd "$APP_DIR"
exec "$NODE_BIN" oracle-competition-analytics-once.js
