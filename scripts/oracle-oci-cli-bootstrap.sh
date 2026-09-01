#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

OCI_VERSION="3.90.0"
ROOT="/opt/wave-alpha/oci-cli"
RELEASE="$ROOT/releases/$OCI_VERSION"
CURRENT="$ROOT/current"
SERVICE="alpha-realtime-qualification.service"
SUCCESS=0

cleanup() {
  if [[ "$SUCCESS" -ne 1 ]]; then
    sudo rm -rf "$RELEASE" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

printf 'STEP=ORACLE_OCI_CLI_PINNED_VENV_BOOTSTRAP\n'

STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
printf 'SERVICE_STATE_BEFORE=%s\n' "$STATE"
[[ "$STATE" != active ]]

BIND="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BEFORE=%s\n' "${BIND:-NONE}"
[[ -z "$BIND" ]]

[[ ! -e "$RELEASE" ]]
[[ ! -L "$CURRENT" ]]

PYVER="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
printf 'PYTHON_VERSION=%s\n' "$PYVER"
python3 -m venv --help >/dev/null 2>&1 || {
  printf 'PYTHON_VENV_GATE=FAIL\n'
  exit 64
}
printf 'PYTHON_VENV_GATE=PASS\n'

MEM_KB="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
DISK_B="$(df -P -B1 / | awk 'NR==2 {print $4}')"
printf 'MEM_AVAILABLE_KB=%s\n' "$MEM_KB"
printf 'ROOT_AVAILABLE_BYTES=%s\n' "$DISK_B"
[[ "$MEM_KB" -ge 350000 ]]
[[ "$DISK_B" -ge 1073741824 ]]

RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"
sudo install -d -o root -g root -m 0755 "$ROOT/releases"
sudo install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0755 "$RELEASE"

python3 -m venv "$RELEASE"
[[ -x "$RELEASE/bin/python" ]]
[[ -x "$RELEASE/bin/pip" ]]

export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_CACHE_DIR=1

PACKAGES=(
  'oci_cli==3.90.0'
  'oci==2.183.0'
  'arrow==1.4.0'
  'certifi==2025.11.12'
  'click==8.1.2'
  'cryptography==49.0.0'
  'jmespath==1.0.1'
  'python-dateutil==2.9.0.post0'
  'pytz==2026.2'
  'six==1.17.0'
  'terminaltables==3.1.10'
  'pyOpenSSL==26.4.0'
  'PyYAML==6.0.2'
  'prompt-toolkit==3.0.43'
  'setuptools==80.10.2'
  'urllib3==2.7.0'
  'circuitbreaker==2.1.3'
  'crc32c==2.8.0'
  'PyJWT==2.13.0'
  'tzdata==2026.3'
  'cffi==2.1.1'
  'wcwidth==0.8.3'
  'typing-extensions==4.16.0'
  'pycparser==3.0'
  'packaging==26.3'
  'wheel==0.48.0'
)

"$RELEASE/bin/pip" install --only-binary=:all: --no-deps "${PACKAGES[@]}"
"$RELEASE/bin/pip" check
printf 'PIP_CHECK=PASS\n'

"$RELEASE/bin/python" - "$RELEASE" <<'PY'
import pathlib, sys
release=pathlib.Path(sys.argv[1]).resolve()
assert pathlib.Path(sys.prefix).resolve() == release
import oci  # noqa: F401
import oci_cli  # noqa: F401
print('VENV_IMPORT_GATE=PASS')
PY

[[ -x "$RELEASE/bin/oci" ]]
ACTUAL_VERSION="$($RELEASE/bin/oci --version 2>/dev/null | head -n1)"
printf 'OCI_CLI_VERSION=%s\n' "$ACTUAL_VERSION"
[[ "$ACTUAL_VERSION" == "$OCI_VERSION" ]]

FREEZE_SHA256="$($RELEASE/bin/pip freeze --all | LC_ALL=C sort | sha256sum | awk '{print $1}')"
printf 'INSTALLED_FREEZE_SHA256=%s\n' "$FREEZE_SHA256"

sudo chown -R root:root "$RELEASE"
sudo chmod -R go-w "$RELEASE"
sudo ln -s "$RELEASE" "$CURRENT"

[[ "$(readlink -f "$CURRENT")" == "$RELEASE" ]]
printf 'OCI_CLI_CURRENT=%s\n' "$(readlink -f "$CURRENT")"
printf 'OCI_CLI_BYTES=%s\n' "$(sudo du -sb "$RELEASE" | awk '{print $1}')"

STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
printf 'SERVICE_STATE_AFTER=%s\n' "$STATE"
[[ "$STATE" != active ]]

BIND="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_AFTER=%s\n' "${BIND:-NONE}"
[[ -z "$BIND" ]]

SUCCESS=1
printf 'APT_EXECUTED=NO\n'
printf 'SYSTEM_PACKAGE_MUTATION=NO\n'
printf 'SYSTEM_PATH_CHANGED=NO\n'
printf 'SERVICE_STARTED=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'OCI_CLI_BOOTSTRAP=PASS\n'
printf 'BLOCK_DONE=YES\n'
