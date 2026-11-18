#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/tests.yml
q="[\"']"
lines="$(grep -niE \
  -e 'continue-on-error' \
  -e "^[[:space:]-]*${q}.*${q}[[:space:]]*:([[:space:]]|$)" \
  -e "[{,][[:space:]]*${q}[^\"']*${q}[[:space:]]*:" \
  -e '^[[:space:]-]*\?([[:space:]]|$)' \
  -e '[{,][[:space:]]*\?[[:space:]]' \
  "$workflow" || [ "$?" = 1 ])"
if [ -n "$lines" ]; then
  echo "$lines"
  echo "$workflow cannot be trusted by the test gate: continue-on-error lets a failed job or step count as passed, and a quoted or explicit (?) key can spell that name another way. Remove the lines above."
  exit 1
fi
