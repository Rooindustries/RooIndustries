#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
expected_cases=48
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT
checked=0
wrong=0

ln -s "$PWD" "$work/linked"

unset NODE_OPTIONS NODE_PRESERVE_SYMLINKS
start_modes=("node" "node --preserve-symlinks-main" "NODE_OPTIONS=--preserve-symlinks-main node")
missing_module() { grep -qF 'MODULE_NOT_FOUND' "$work/stderr"; }

check_starts() {
  local script="$1" works_exit="$2" works_with="$3" works="$4"
  shift 4
  local link="$work/$script.mjs" mode start exit_code expected_exit expected judge stdout
  local -a node_start
  ln -s "$PWD/scripts/$script.mjs" "$link"
  for mode in "${start_modes[@]}"; do
    read -r -a node_start <<< "$mode"
    for start in "scripts/$script.mjs" "$PWD/scripts/$script.mjs" "$work/linked/scripts/$script.mjs" "$link"; do
      expected_exit="$works_exit" expected="$works_with, the same as its other starts" judge="$works"
      stdout="$work/$script.stdout"
      if [ "$start" = "$link" ] && [[ "$mode" == *preserve-symlinks-main* ]]; then
        expected_exit=1 expected="Node's missing-module error on stderr and nothing on stdout" judge=missing_module
        stdout=/dev/null
      fi
      exit_code=0
      env "${node_start[@]}" "$start" "$@" > "$work/stdout" 2> "$work/stderr" || exit_code=$?
      checked=$((checked + 1))
      [ -e "$work/$script.stdout" ] || cp "$work/stdout" "$work/$script.stdout"
      if [ "$exit_code" != "$expected_exit" ] || ! "$judge" || ! cmp -s "$work/stdout" "$stdout"; then
        wrong=$((wrong + 1))
        printf '%s %s should exit %s with %s. It exited %s.\nstdout:\n%s\nstderr:\n%s\n\n' \
          "$mode" "$start" "$expected_exit" "$expected" "$exit_code" "$(cat "$work/stdout")" "$(cat "$work/stderr")" >&2
      fi
    done
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
