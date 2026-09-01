#!/usr/bin/env bash
set -Eeuo pipefail

export USER="${USER:-$(id -un)}"

OCI_VERSION="3.90.0"
OCI_COMMIT="b7d3e213561db98603adf871eac8791cafadabb1"
INSTALL_SH_BLOB="4690a5d9c2e439ccf291ab31b629d8cad32c4613"
INSTALL_PY_BLOB="da75d6cc211d4c01201a4e8bf6d20a28125aa594"
ROOT="/opt/wave-alpha/oci-cli"
RELEASE="$ROOT/releases/$OCI_VERSION"
CURRENT="$ROOT/current"
SERVICE="alpha-realtime-qualification.service"
WORK="$(mktemp -d /tmp/wa-oci-cli-bootstrap.XXXXXX)"
SUCCESS=0

cleanup() {
  rm -rf "$WORK"
  if [[ "$SUCCESS" -ne 1 ]]; then
    sudo rm -rf "$RELEASE" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

blob_sha() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, sys
p=pathlib.Path(sys.argv[1])
b=p.read_bytes()
print(hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest())
PY
}

printf 'STEP=ORACLE_OCI_CLI_PINNED_BOOTSTRAP\n'

STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
printf 'SERVICE_STATE_BEFORE=%s\n' "$STATE"
[[ "$STATE" != active ]]

BIND="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_BEFORE=%s\n' "${BIND:-NONE}"
[[ -z "$BIND" ]]

[[ ! -e "$RELEASE" ]]

PYVER="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
printf 'PYTHON_VERSION=%s\n' "$PYVER"

MEM_KB="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
DISK_B="$(df -P -B1 / | awk 'NR==2 {print $4}')"
printf 'MEM_AVAILABLE_KB=%s\n' "$MEM_KB"
printf 'ROOT_AVAILABLE_BYTES=%s\n' "$DISK_B"
[[ "$MEM_KB" -ge 350000 ]]
[[ "$DISK_B" -ge 1073741824 ]]

BASE="https://raw.githubusercontent.com/oracle/oci-cli/$OCI_COMMIT/scripts/install"
curl -fsSL --max-time 30 "$BASE/install.sh" -o "$WORK/install.sh"
curl -fsSL --max-time 30 "$BASE/install.py" -o "$WORK/install.py"

SH_ACTUAL="$(blob_sha "$WORK/install.sh")"
PY_ACTUAL="$(blob_sha "$WORK/install.py")"
printf 'INSTALL_SH_BLOB_GATE=%s\n' "$( [[ "$SH_ACTUAL" == "$INSTALL_SH_BLOB" ]] && printf PASS || printf FAIL )"
printf 'INSTALL_PY_BLOB_GATE=%s\n' "$( [[ "$PY_ACTUAL" == "$INSTALL_PY_BLOB" ]] && printf PASS || printf FAIL )"
[[ "$SH_ACTUAL" == "$INSTALL_SH_BLOB" ]]
[[ "$PY_ACTUAL" == "$INSTALL_PY_BLOB" ]]

sudo install -d -o root -g root -m 0755 "$ROOT/releases"
cd "$WORK"
sudo bash ./install.sh \
  --accept-all-defaults \
  --no-tty \
  --use-local-cli-installer \
  --oci-cli-version "$OCI_VERSION" \
  --install-dir "$RELEASE" \
  --exec-dir "$RELEASE/bin"

[[ -x "$RELEASE/bin/oci" ]]
ACTUAL_VERSION="$($RELEASE/bin/oci --version 2>/dev/null | head -n1)"
printf 'OCI_CLI_VERSION=%s\n' "$ACTUAL_VERSION"
[[ "$ACTUAL_VERSION" == "$OCI_VERSION" ]]

sudo chown -R root:root "$RELEASE"
sudo chmod -R go-w "$RELEASE"
sudo ln -sfn "$RELEASE" "$CURRENT"

[[ "$(readlink -f "$CURRENT")" == "$RELEASE" ]]
printf 'OCI_CLI_CURRENT=%s\n' "$(readlink -f "$CURRENT")"
printf 'OCI_CLI_BYTES=%s\n' "$(du -sb "$RELEASE" | awk '{print $1}')"

STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
printf 'SERVICE_STATE_AFTER=%s\n' "$STATE"
[[ "$STATE" != active ]]

BIND="$(ss -lntH 2>/dev/null | awk '$4 ~ /:3100$/ {print $4}' | paste -sd, -)"
printf 'PORT_3100_AFTER=%s\n' "${BIND:-NONE}"
[[ -z "$BIND" ]]

SUCCESS=1
printf 'SYSTEM_PATH_CHANGED=NO\n'
printf 'SERVICE_STARTED=NO\n'
printf 'SECRET_VALUES_PRINTED=NO\n'
printf 'OCI_CLI_BOOTSTRAP=PASS\n'
printf 'BLOCK_DONE=YES\n'
