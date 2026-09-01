#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

NODE_BIN="${WAVE_ALPHA_NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
APP_DIR="${WAVE_ALPHA_APP_DIR:-/opt/wave-alpha/alpha-realtime/current}"
CRED_DIR="${CREDENTIALS_DIRECTORY:-}"

require_file() {
  local path="$1"
  [[ -n "$path" && -f "$path" ]] || {
    printf '[PRODUCTION-READONLY] missing credential file: %s\n' "$path" >&2
    exit 64
  }
}

[[ -x "$NODE_BIN" ]] || {
  printf '[PRODUCTION-READONLY] node binary unavailable: %s\n' "$NODE_BIN" >&2
  exit 65
}
[[ -d "$APP_DIR" ]] || {
  printf '[PRODUCTION-READONLY] app directory unavailable: %s\n' "$APP_DIR" >&2
  exit 66
}
[[ -n "$CRED_DIR" ]] || {
  printf '[PRODUCTION-READONLY] CREDENTIALS_DIRECTORY unavailable\n' >&2
  exit 67
}

for inherited in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY SUPABASE_SERVICE_ROLE_KEY API_SECRET_KEY; do
  if [[ -n "${!inherited:-}" ]]; then
    printf '[PRODUCTION-READONLY] refusing inherited legacy credential env: %s\n' "$inherited" >&2
    exit 68
  fi
done

R2_ID_FILE="$CRED_DIR/R2_READ_ONLY_ACCESS_KEY_ID"
R2_SECRET_FILE="$CRED_DIR/R2_READ_ONLY_SECRET_ACCESS_KEY"
SUPABASE_ANON_FILE="$CRED_DIR/SUPABASE_ANON_KEY"
API_KEY_FILE="$CRED_DIR/PRODUCTION_READ_API_SECRET_KEY"

require_file "$R2_ID_FILE"
require_file "$R2_SECRET_FILE"
require_file "$SUPABASE_ANON_FILE"
require_file "$API_KEY_FILE"

export R2_READ_ONLY_ACCESS_KEY_ID="$(cat "$R2_ID_FILE")"
export R2_READ_ONLY_SECRET_ACCESS_KEY="$(cat "$R2_SECRET_FILE")"
export SUPABASE_ANON_KEY="$(cat "$SUPABASE_ANON_FILE")"
export PRODUCTION_READ_API_SECRET_KEY="$(cat "$API_KEY_FILE")"

for name in R2_READ_ONLY_ACCESS_KEY_ID R2_READ_ONLY_SECRET_ACCESS_KEY SUPABASE_ANON_KEY PRODUCTION_READ_API_SECRET_KEY; do
  [[ -n "${!name:-}" ]] || {
    printf '[PRODUCTION-READONLY] empty credential: %s\n' "$name" >&2
    exit 69
  }
done

[[ "${WAVE_RUNTIME_MODE:-}" == 'production-readonly' ]] || {
  printf '[PRODUCTION-READONLY] WAVE_RUNTIME_MODE mismatch\n' >&2
  exit 70
}
[[ "${WAVE_CANONICAL_PUBLISH:-}" == 'off' ]] || {
  printf '[PRODUCTION-READONLY] WAVE_CANONICAL_PUBLISH must be off\n' >&2
  exit 71
}
[[ "${ENABLE_TICK_CACHE:-}" == 'false' ]] || {
  printf '[PRODUCTION-READONLY] ENABLE_TICK_CACHE must be false\n' >&2
  exit 72
}

cd "$APP_DIR"
exec "$NODE_BIN" oracle-production-readonly.js
