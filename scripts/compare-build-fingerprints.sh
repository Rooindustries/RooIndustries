#!/usr/bin/env bash
set -euo pipefail

first="${1:?usage: compare-build-fingerprints.sh <fingerprint> <fingerprint>}"
second="${2:?usage: compare-build-fingerprints.sh <fingerprint> <fingerprint>}"

for file in "$first" "$second"; do
  if ! grep -q '^First load ' "$file" || ! grep -qE '^[0-9a-f]{64}  ' "$file"; then
    echo "$file is not a complete build fingerprint." >&2
    exit 1
  fi
done
if ! diff -u "$first" "$second"; then
  echo "The same source built in two checkouts produced different client chunk contents or sizes." >&2
  exit 1
fi
echo "Both builds produced identical client chunks and sizes ($(grep -c '^First load ' "$first") routes)."
