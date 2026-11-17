#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
expected_cases=16
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT
checked=0
wrong=0

ln -s "$PWD" "$work/linked"

check_starts() {
  local script="$1" expected_exit="$2" expected="$3" judge="$4"
  shift 4
  local start exit_code
  ln -s "$PWD/scripts/$script.mjs" "$work/$script.mjs"
  for start in "scripts/$script.mjs" "$PWD/scripts/$script.mjs" "$work/linked/scripts/$script.mjs" "$work/$script.mjs"; do
    exit_code=0
    node "$start" "$@" > "$work/stdout" 2> "$work/stderr" || exit_code=$?
    checked=$((checked + 1))
    [ -e "$work/$script.stdout" ] || cp "$work/stdout" "$work/$script.stdout"
    if [ "$exit_code" != "$expected_exit" ] || ! "$judge" || ! cmp -s "$work/stdout" "$work/$script.stdout"; then
      wrong=$((wrong + 1))
      printf 'node %s should exit %s with %s, the same as its other starts. It exited %s.\nstdout:\n%s\nstderr:\n%s\n\n' \
        "$start" "$expected_exit" "$expected" "$exit_code" "$(cat "$work/stdout")" "$(cat "$work/stderr")" >&2
    fi
  done
}

one_group_pattern() {
  [ "$(wc -l < "$work/stdout")" = 1 ] && grep -qxE '/tests/\(.+\)\\\.spec\\\.js\$' "$work/stdout" &&
    grep -qF 'rest-1: ' "$work/stderr"
}
check_starts playwright-groups 0 'one spec file pattern on stdout and "rest-1: " on stderr' one_group_pattern \
  rest-1 .github/playwright-timings.json

mkdir "$work/reports"
printf '%s\n' '{"suites":[{"file":"planted.spec.js","specs":[{"tests":[{"results":[{"duration":1500}]}]}]}]}' \
  > "$work/reports/planted.json"
printf '{\n  "planted.spec.js": 1.5\n}\n' > "$work/merged.json"
merged_timings() { cmp -s "$work/stdout" "$work/merged.json"; }
check_starts playwright-timings 0 'the merged timings of the planted report on stdout' merged_timings "$work/reports"

local_refusal() {
  [ ! -s "$work/stdout" ] && grep -qF 'Local provisioning requires a local Supabase URL' "$work/stderr"
}
SUPABASE_URL=https://placeholder.invalid SUPABASE_SECRET_KEY=placeholder check_starts provision-content-admin 1 \
  '"Local provisioning requires a local Supabase URL" on stderr and nothing on stdout' local_refusal \
  --email=check@example.com --target=local

(umask 077 && echo 'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co' > "$work/export.env")
target_fingerprint() {
  grep -qxE '  "SUPABASE_COMMERCE_EXPORT_EXPECTED_FINGERPRINT": "[0-9a-f]{64}"' "$work/stdout"
}
check_starts export-supabase-commerce-encrypted 0 'the target fingerprint on stdout' target_fingerprint \
  --env "$work/export.env" --print-target-fingerprint

while IFS= read -r file; do
  if grep -qE 'import\.meta\.main|require\.main' "$file" ||
     { grep -qF 'process.argv[1]' "$file" && grep -qE 'import\.meta\.(url|filename)|__filename' "$file"; }; then
    wrong=$((wrong + 1))
    echo "$file asks whether it is the main script, which a start through a symlink answers wrongly. Move what others import to scripts/lib and run the command unconditionally." >&2
  fi
done < <(find scripts -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) ! -path scripts/lib/node-options.mjs | sort)

if [ "$wrong" != 0 ]; then
  echo "Scripts that do not do their work however they are started: $wrong problems in $checked starts." >&2
  exit 1
fi
if [ "$checked" != "$expected_cases" ]; then
  echo "Starts checked: $checked, not the $expected_cases this script counts on." >&2
  exit 1
fi
echo "Every script does its work however it is started: all $checked starts."
