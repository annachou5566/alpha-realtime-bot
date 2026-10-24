#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

expected="${1:-}"
base='0dd32a1f2faa869eba400736571e0d549205e4c8'
printf 'WA_ALPHA_READER_OFFLINE_BEGIN\n'
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'GATE=FAIL_BAD_EXPECTED_SHA\n'
  exit 64
fi
for tool in git node npm timeout tar gzip sha256sum mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'GATE=FAIL_MISSING_TOOL name=%s\n' "$tool"
    exit 65
  fi
done
current="$(git rev-parse HEAD 2>/dev/null || true)"
printf 'EXPECTED_SHA=%s\nSOURCE_SHA=%s\n' "$expected" "$current"
if [[ "$current" != "$expected" ]]; then
  printf 'GATE=FAIL_SOURCE_SHA\n'
  exit 66
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf 'GATE=FAIL_DIRTY_TRACKED_FILES\n'
  exit 67
fi
if [[ "$(node --version)" != v22.* ]]; then
  printf 'GATE=FAIL_NODE22_REQUIRED\n'
  exit 68
fi
printf 'NODE_VERSION=%s\n' "$(node --version)"
for pair in \
  'package.json:048803d3c943b56c1135aa1d39cc984981592b7f' \
  'package-lock.json:49f6637e614f577c79593154f8a40fc28162dc5d'; do
  file="${pair%%:*}"
  pinned="${pair#*:}"
  if [[ ! -f "$file" || "$(git hash-object "$file")" != "$pinned" ]]; then
    printf 'GATE=FAIL_DEPENDENCY_DRIFT file=%s\n' "$file"
    exit 69
  fi
done
printf 'DEP_MANIFESTS=EXACT_BASE_MATCH\n'
work="$(mktemp -d /tmp/wa-alpha-rc-prep.XXXXXXXX)"
mkdir -p "$work/home" "$work/tmp" "$work/cache"
printf 'WORKSPACE=%s\n' "$work"
if timeout 480 npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --cache "$work/cache" >"$work/npm-ci.log" 2>&1; then
  printf 'NPM_CI=PASS\n'
else
  rc=$?
  printf 'NPM_CI=FAIL rc=%s\n' "$rc"
  tail -n 14 "$work/npm-ci.log"
  exit "$rc"
fi
if env -i PATH="$PATH" HOME="$work/home" TMPDIR="$work/tmp" NODE_ENV=test CI=1 timeout 360 npm test >"$work/npm-test.log" 2>&1; then
  printf 'NATIVE_TEST=PASS\n'
  grep -E '^# (tests|pass|fail|cancelled|skipped) ' "$work/npm-test.log" | tail -n 5 || true
else
  rc=$?
  printf 'NATIVE_TEST=FAIL rc=%s\n' "$rc"
  printf 'FIRST_FAILED_SUBTEST_CONTEXT_BEGIN\n'
  awk '/^not ok / {left=32} left>0 {print; left--; shown++; if (shown>=80) exit}' "$work/npm-test.log"
  printf 'FIRST_FAILED_SUBTEST_CONTEXT_END\n'
  grep -E '^# (tests|pass|fail|cancelled|skipped) ' "$work/npm-test.log" | tail -n 5 || true
  exit "$rc"
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf 'GATE=FAIL_SOURCE_CHANGED_AFTER_TEST\n'
  exit 70
fi
package="$work/alpha-reader-${expected}.tar.gz"
git archive --format=tar "$expected" | gzip -1 > "$package"
if [[ ! -s "$package" ]]; then
  printf 'GATE=FAIL_EMPTY_ARCHIVE\n'
  exit 71
fi
printf 'PACKAGE_SHA256=%s\n' "$(sha256sum "$package" | cut -d ' ' -f 1)"
printf 'PACKAGE_BYTES=%s\n' "$(wc -c < "$package")"
printf 'PACKAGE_PATH=%s\n' "$package"
printf 'GATE=PREPARED_NOT_DEPLOYED\nWA_ALPHA_READER_OFFLINE_END\n'
