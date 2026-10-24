#!/usr/bin/env bash
# Read-only, names/metadata only. Run under sudo on the qualified Oracle VM.
printf 'WA_ALPHA_FINAL_PROVISION_BEGIN\n'
svc=alpha-realtime-production-readonly.service
host=$(hostname -s 2>/dev/null)
printf 'HOST=%s\n' "$host"
if [ "$host" != micro-server-auto-2 ]; then
  printf 'GATE=HOLD_WRONG_VM\nMUTATION=NONE\nWA_ALPHA_FINAL_PROVISION_RC=10\nWA_ALPHA_FINAL_PROVISION_END\n'
else
  for property in ExecStartPre ExecStartPost EnvironmentFiles; do
    value=$(systemctl show -P "$property" "$svc" 2>/dev/null)
    case "$value" in ''|'[]') configured=NO;; *) configured=YES;; esac
    printf '%s_CONFIGURED=%s\n' "$property" "$configured"
  done
  src=/run/wave-alpha-alpha/credentials
  for name in R2_READ_ONLY_ACCESS_KEY_ID R2_READ_ONLY_SECRET_ACCESS_KEY SUPABASE_ANON_KEY ALPHA_LIVE_PUBLISH_KEY; do
    file="$src/$name"
    if [ -L "$file" ]; then
      printf 'SOURCE_%s=HOLD_SYMLINK\n' "$name"
    elif [ -f "$file" ]; then
      metadata=$(stat -c '%u:%a:%h:%F' -- "$file" 2>/dev/null)
      printf 'SOURCE_%s_METADATA=%s\n' "$name" "$metadata"
    else
      printf 'SOURCE_%s=HOLD_MISSING\n' "$name"
    fi
  done
  for file in \
    /run/wave-alpha-alpha/credentials/PRODUCTION_READ_API_SECRET_KEY \
    /etc/credstore.encrypted/PRODUCTION_READ_API_SECRET_KEY_NEXT \
    /etc/systemd/system/alpha-realtime-production-readonly.service.d/60-wavealpha-api-next.conf; do
    case "$file" in
      */PRODUCTION_READ_API_SECRET_KEY) label=OLD_PLAINTEXT;;
      */PRODUCTION_READ_API_SECRET_KEY_NEXT) label=OLD_NEXT_ENCRYPTED;;
      *) label=DUAL_DROPIN;;
    esac
    if [ -L "$file" ]; then
      printf '%s=HOLD_SYMLINK\n' "$label"
    elif [ -f "$file" ]; then
      printf '%s_LINK_COUNT=%s\n' "$label" "$(stat -c '%h' -- "$file" 2>/dev/null)"
    else
      printf '%s=ABSENT_OR_INACCESSIBLE\n' "$label"
    fi
  done
  printf 'BOOT_PROVISION_OWNER=UNPROVEN_FROM_METADATA_ALONE\nCLEANUP_GO=NO\n'
  printf 'ROLLBACK_RUNTIME_TEST=NOT_RUN\n'
  printf 'CLEANUP_EXECUTED=NO\nMUTATION=NONE\nWA_ALPHA_FINAL_PROVISION_RC=0\nWA_ALPHA_FINAL_PROVISION_END\n'
fi
[ "$host" = micro-server-auto-2 ]
