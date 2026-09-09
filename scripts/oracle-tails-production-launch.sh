#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"
umask 077

NODE_BIN="${WAVE_ALPHA_NODE_BIN:-/opt/wave-alpha/node/current/bin/node}"
APP_DIR="${WAVE_ALPHA_APP_DIR:-/opt/wave-alpha/alpha-tails-writer/current}"
CRED_DIR="${CREDENTIALS_DIRECTORY:-}"

EXPECTED_ENDPOINT='https://0f534c1b6f9bc097235b37c07d1dc32e.r2.cloudflarestorage.com'
EXPECTED_BUCKET='wave-alpha-data'

require_file() {
  local path="$1"
  [[ -n "$path" && -f "$path" ]] || {
    printf '[TAILS-PRODUCTION] missing credential file: %s\n' "$path" >&2
    exit 64
  }
}

[[ -x "$NODE_BIN" ]] || {
  printf '[TAILS-PRODUCTION] node binary unavailable\n' >&2
  exit 65
}

[[ -d "$APP_DIR" ]] || {
  printf '[TAILS-PRODUCTION] app directory unavailable\n' >&2
  exit 66
}

[[ -n "$CRED_DIR" ]] || {
  printf '[TAILS-PRODUCTION] CREDENTIALS_DIRECTORY unavailable\n' >&2
  exit 67
}

for inherited in   R2_ACCESS_KEY_ID   R2_SECRET_ACCESS_KEY   AWS_ACCESS_KEY_ID   AWS_SECRET_ACCESS_KEY   SUPABASE_SERVICE_ROLE_KEY   API_SECRET_KEY
 do
  if [[ -n "${!inherited:-}" ]]; then
    printf '[TAILS-PRODUCTION] refusing inherited credential env: %s\n' "$inherited" >&2
    exit 68
  fi
done

R2_ID_FILE="$CRED_DIR/R2_TAILS_WRITE_ACCESS_KEY_ID"
R2_SECRET_FILE="$CRED_DIR/R2_TAILS_WRITE_SECRET_ACCESS_KEY"

require_file "$R2_ID_FILE"
require_file "$R2_SECRET_FILE"

[[ "${TAILS_WRITER_MODE:-}" == 'production' ]] || {
  printf '[TAILS-PRODUCTION] TAILS_WRITER_MODE mismatch\n' >&2
  exit 69
}

[[ "${TAILS_PRODUCTION_WRITE:-}" == 'true' ]] || {
  printf '[TAILS-PRODUCTION] TAILS_PRODUCTION_WRITE must be true\n' >&2
  exit 70
}

[[ "${R2_ENDPOINT_URL:-}" == "$EXPECTED_ENDPOINT" ]] || {
  printf '[TAILS-PRODUCTION] R2_ENDPOINT_URL mismatch\n' >&2
  exit 71
}

[[ "${R2_BUCKET_NAME:-}" == "$EXPECTED_BUCKET" ]] || {
  printf '[TAILS-PRODUCTION] R2_BUCKET_NAME mismatch\n' >&2
  exit 72
}

export R2_ACCESS_KEY_ID="$(cat "$R2_ID_FILE")"
export R2_SECRET_ACCESS_KEY="$(cat "$R2_SECRET_FILE")"

[[ -n "$R2_ACCESS_KEY_ID" && -n "$R2_SECRET_ACCESS_KEY" ]] || {
  printf '[TAILS-PRODUCTION] empty writer credential\n' >&2
  exit 73
}

cd "$APP_DIR"
exec "$NODE_BIN" oracle-tails-production-writer.js
