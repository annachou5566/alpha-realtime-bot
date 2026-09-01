#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

NODE_BIN="${WAVE_ALPHA_NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
APP_DIR="${WAVE_ALPHA_APP_DIR:-/opt/wave-alpha/alpha-realtime/current}"
CRED_DIR="${CREDENTIALS_DIRECTORY:-}"

require_file() {
  local path="$1"
  [[ -n "$path" && -f "$path" ]] || {
    printf '[QUALIFICATION] missing credential file: %s\n' "$path" >&2
    exit 64
  }
}

[[ -x "$NODE_BIN" ]] || {
  printf '[QUALIFICATION] node binary unavailable: %s\n' "$NODE_BIN" >&2
  exit 65
}
[[ -d "$APP_DIR" ]] || {
  printf '[QUALIFICATION] app directory unavailable: %s\n' "$APP_DIR" >&2
  exit 66
}
[[ -n "$CRED_DIR" ]] || {
  printf '[QUALIFICATION] CREDENTIALS_DIRECTORY unavailable\n' >&2
  exit 67
}

R2_ID_FILE="$CRED_DIR/R2_READ_ONLY_ACCESS_KEY_ID"
R2_SECRET_FILE="$CRED_DIR/R2_READ_ONLY_SECRET_ACCESS_KEY"
SUPABASE_ANON_FILE="$CRED_DIR/SUPABASE_ANON_KEY"
API_KEY_FILE="$CRED_DIR/QUALIFICATION_API_SECRET_KEY"

require_file "$R2_ID_FILE"
require_file "$R2_SECRET_FILE"
require_file "$SUPABASE_ANON_FILE"
require_file "$API_KEY_FILE"

export R2_READ_ONLY_ACCESS_KEY_ID="$(cat "$R2_ID_FILE")"
export R2_READ_ONLY_SECRET_ACCESS_KEY="$(cat "$R2_SECRET_FILE")"
export SUPABASE_ANON_KEY="$(cat "$SUPABASE_ANON_FILE")"
export QUALIFICATION_API_SECRET_KEY="$(cat "$API_KEY_FILE")"

for name in R2_READ_ONLY_ACCESS_KEY_ID R2_READ_ONLY_SECRET_ACCESS_KEY SUPABASE_ANON_KEY QUALIFICATION_API_SECRET_KEY; do
  [[ -n "${!name:-}" ]] || {
    printf '[QUALIFICATION] empty credential: %s\n' "$name" >&2
    exit 68
  }
done

cd "$APP_DIR"
exec "$NODE_BIN" oracle-qualification.js
