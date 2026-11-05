#!/usr/bin/env bash
set -euo pipefail

out="${1:?usage: build-fingerprint.sh <output file>}"
dist="${NEXT_DIST_DIR:?NEXT_DIST_DIR is required}"
report="$(mktemp)"
trap 'rm -f -- "${report:?}"' EXIT

if ! node scripts/check-budgets.js > "$report" 2>&1; then
  cat "$report" >&2
  echo "The budget report for the build in $(pwd -P) failed." >&2
  exit 1
fi
cat "$report"
if ! grep -q '^First load ' "$report"; then
  echo "The budget report measured no routes." >&2
  exit 1
fi

build_id="$(cat "$dist/BUILD_ID")"
mkdir -p "$(dirname "$out")"
{
  grep -E '^(First load|Lazy) ' "$report" | sort
  (cd "$dist/static" && find . -type f ! -path "./$build_id/*" -print0 | sort -z | xargs -0 sha256sum)
} > "$out"
