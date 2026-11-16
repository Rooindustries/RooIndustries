#!/usr/bin/env bash
set -euo pipefail

tap=$(mktemp "${TMPDIR:-/tmp}/booking-hold.XXXXXXXX")
trap 'rm -f -- "${tap:?}"' EXIT
node --test --test-reporter=tap tests/booking-hold.test.mjs | tee "$tap"
grep -Fx '# tests 15' "$tap"
grep -Fx '# pass 15' "$tap"
grep -Fx '# fail 0' "$tap"
grep -Fx '# skipped 0' "$tap"
