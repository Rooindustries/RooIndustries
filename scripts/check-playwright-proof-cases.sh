#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
planted=.github/playwright-proof
real_config="$planted/planted/playwright.config.js"
real_group=rest-2
real_name="$real_group-1"
expected_cases=56
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT
checked=0
wrong=0

check_case() {
  local name="$1" run="$2" expected_exit="$3" phrase="$4" judge="${5:-scripts/compare-playwright-proof.mjs}"
  local exit_code=0 output
  output="$(node "$judge" "$run" 2>&1)" || exit_code=$?
  checked=$((checked + 1))
  if [ "$exit_code" != "$expected_exit" ] || ! grep -qF -- "$phrase" <<< "$output"; then
    wrong=$((wrong + 1))
    printf 'Case "%s" should exit %s saying "%s". It exited %s saying:\n%s\n\n' \
      "$name" "$expected_exit" "$phrase" "$exit_code" "$output" >&2
  fi
}

for case_dir in "$planted"/cases/*/; do
  if ! expected_exit="$(jq -er '.exit | numbers' "${case_dir}expect.json")" ||
     ! phrase="$(jq -er '.phrase | strings | select(length > 0)' "${case_dir}expect.json")"; then
    echo "${case_dir}expect.json gives no exit code and phrase, so the proof does not start." >&2
    exit 1
  fi
  check_case "$(basename "$case_dir")" "${case_dir}run" "$expected_exit" "$phrase"
done

ln -s "$PWD" "$work/linked"
check_case "the judge started through a symlinked path" "$planted/cases/leg-without-report/run" 2 \
  "Leg navigation-1: it has no report" "$work/linked/scripts/compare-playwright-proof.mjs"

mkdir -p "$work/real" "$work/cut"
node scripts/plan-playwright-proof.mjs plan 1 "[{\"group\":\"$real_group\",\"repeat\":1,\"seed\":0}]" \
  .github/playwright-timings.json "$real_config" > "$work/real/plan.json"
files="$(node scripts/plan-playwright-proof.mjs files "$work/real/plan.json" "$real_name")"
PW_LEG="$real_name" PLAYWRIGHT_JSON_OUTPUT_FILE="$work/real/$real_name.json" npx playwright test \
  --config "$real_config" --retries=0 --repeat-each=2 --reporter=json "$files"
check_case "a real report from the installed Playwright" "$work/real" 0 "Every planned leg is complete. Legs: 1. Tests: 2."
cp "$work/real/plan.json" "$work/cut/"
jq -c 'del(.suites[0].specs[0])' "$work/real/$real_name.json" > "$work/cut/$real_name.json"
check_case "the real report with one entry removed" "$work/cut" 2 "planned tests not in its report exactly 2 times: 1"

if [ "$wrong" != 0 ]; then
  echo "Planted cases judged wrongly: $wrong of $checked. The proof does not start." >&2
  exit 1
fi
if [ "$checked" != "$expected_cases" ]; then
  echo "Planted cases checked: $checked, not the $expected_cases this script counts on. The proof does not start." >&2
  exit 1
fi
echo "Planted cases judged as expected: all $checked."
