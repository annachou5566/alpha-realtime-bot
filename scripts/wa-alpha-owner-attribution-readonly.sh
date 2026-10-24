#!/usr/bin/env bash
# WA alpha read-only, filenames/states only; MUST NOT print secret content.
set +e
printf 'WA_ALPHA_OWNER_ATTRIBUTION_BEGIN\n'
if [ "$(id -u)" != 0 ] || [ "$(hostname -s)" != micro-server-auto-2 ]; then
  printf 'GATE=HOLD_IDENTITY\nMUTATION=NONE\nWA_ALPHA_OWNER_ATTRIBUTION_RC=10\nWA_ALPHA_OWNER_ATTRIBUTION_END\n'
  exit 10
fi
scope=(/etc/systemd/system /usr/lib/systemd/system /lib/systemd/system /etc/cloud/cloud.cfg.d /var/lib/cloud/scripts /usr/local/bin /usr/local/sbin /opt/wave-alpha/bin /opt/wave-alpha/scripts)
dirs=()
for p in "${scope[@]}"; do [ ! -d "$p" ] || dirs+=("$p"); done
if [ "${#dirs[@]}" -eq 0 ]; then
  printf 'GATE=HOLD_NO_SCOPE\nMUTATION=NONE\nWA_ALPHA_OWNER_ATTRIBUTION_RC=11\nWA_ALPHA_OWNER_ATTRIBUTION_END\n'
  exit 11
fi
mapfile -d '' -t files < <(find "${dirs[@]}" -maxdepth 3 -type f -size -256k \( -name '*.service' -o -name '*.timer' -o -name '*.conf' -o -name '*.sh' -o -name '*.yaml' -o -name '*.py' -o -name '*alpha*' -o -name '*wave*' \) -print0 2>/dev/null)
printf 'SCOPED_FILES=%s\n' "${#files[@]}"
if [ "${#files[@]}" -gt 900 ] || [ "${#files[@]}" -eq 0 ]; then
  printf 'GATE=HOLD_SCOPE_BOUND\nMUTATION=NONE\nWA_ALPHA_OWNER_ATTRIBUTION_RC=12\nWA_ALPHA_OWNER_ATTRIBUTION_END\n'
  exit 12
fi
mapfile -t refs < <(grep -lF -- '/run/wave-alpha-alpha/credentials' "${files[@]}" 2>/dev/null | sort -u)
printf 'CREDENTIAL_DIRECTORY_REF_COUNT=%s\n' "${#refs[@]}"
if [ "${#refs[@]}" -gt 30 ]; then
  printf 'GATE=HOLD_REFERENCE_BOUND\nMUTATION=NONE\nWA_ALPHA_OWNER_ATTRIBUTION_RC=13\nWA_ALPHA_OWNER_ATTRIBUTION_END\n'
  exit 13
fi
for f in "${refs[@]}"; do
  printf 'REFERENCE=%s\n' "$f"
  case "$f" in
    /etc/systemd/system/*.service|/usr/lib/systemd/system/*.service|/lib/systemd/system/*.service|/etc/systemd/system/*.timer)
      unit=${f##*/}
      active=$(systemctl show -P ActiveState "$unit" 2>/dev/null)
      printf 'UNIT=%s ACTIVE=%s\n' "$unit" "${active:-UNKNOWN}"
      ;;
    *) printf 'ROLE=UNCLASSIFIED_SOURCE_OR_DROPIN\n';;
  esac
done
printf 'BOOT_PROVISION_OWNER=UNPROVEN\n'
printf 'CLEANUP_GO=NO\nMUTATION=NONE\nWA_ALPHA_OWNER_ATTRIBUTION_RC=0\nWA_ALPHA_OWNER_ATTRIBUTION_END\n'
