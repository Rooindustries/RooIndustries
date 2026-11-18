#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
root="$PWD"
cases=.github/tests-passed-cases.json
expected_cases=48
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT

node --input-type=module -e '
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
const { jobs } = yaml.load(readFileSync(".github/workflows/tests.yml", "utf8"));
const gate = jobs["tests-passed"];
const tree = jobs["tested-tree"];
const needs = [gate.needs].flat();
const step = gate.steps.find((s) => s.run);
console.log(JSON.stringify({
  run: step.run,
  needs,
  missing: Object.keys(jobs).filter((job) => job !== "tests-passed" && !needs.includes(job)),
  always: gate.if === "always()",
  check: tree.steps.find((s) => s.id === "check") ?? {},
}));
' > "$work/gate.json"

missing="$(jq -r '.missing | join(", ")' "$work/gate.json")"
if [ -n "$missing" ]; then
  echo "Jobs the test gate does not wait for: $missing. Add them to tests-passed needs." >&2
  exit 1
fi
if [ "$(jq -r .always "$work/gate.json")" != true ]; then
  echo "The test gate must run with if: always(), or a failed job skips it." >&2
  exit 1
fi
jq -r .run "$work/gate.json" > "$work/gate.sh"
check_run="$(jq -r '.check.run // ""' "$work/gate.json")"
if [ "$(jq -r '.check.shell // ""' "$work/gate.json")" != "" ] ||
   [ "$(grep -m1 -v '^[[:space:]]*$' <<< "$check_run")" != "bash scripts/refuse-lenient-tests-workflow.sh" ] ||
   ! grep -qx 'bash scripts/tested-tree.sh' <<< "$check_run"; then
  echo "The tree check step (id: check) must run bash scripts/refuse-lenient-tests-workflow.sh first and bash scripts/tested-tree.sh after it, in the default shell, so no answer is written when the refusal fails." >&2
  exit 1
fi

mkdir "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_CALLS"
cat "$JOB_LIST"
STUB
chmod +x "$work/bin/gh"

checked=0
wrong=0

judge() {
  local name="$1" expected_exit="$2" phrase="$3"
  checked=$((checked + 1))
  if [ "$exit_code" != "$expected_exit" ] || ! grep -qxF -- "$phrase" <<< "$output"; then
    wrong=$((wrong + 1))
    printf 'Case "%s" should exit %s saying "%s". It exited %s saying:\n%s\n\n' \
      "$name" "$expected_exit" "$phrase" "$exit_code" "$output" >&2
  fi
}

run_gate() {
  exit_code=0
  output="$(env PATH="$work/bin:$PATH" JOB_LIST="$work/jobs.json" GH_CALLS="$work/gh-calls" \
    GITHUB_EVENT_NAME="$1" FORK="$2" NEEDS="$3" \
    GITHUB_REPOSITORY=Rooindustries/RooIndustries GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 \
    bash -e "$work/gate.sh" 2>&1)" || exit_code=$?
}

run_refusal() {
  rm -rf -- "${work:?}/repo"
  mkdir -p "$work/repo/.github/workflows"
  [ "$1" = missing ] || sed "$1" .github/workflows/tests.yml > "$work/repo/.github/workflows/tests.yml"
  exit_code=0
  output="$(cd "$work/repo" && bash "$root/scripts/refuse-lenient-tests-workflow.sh" 2>&1)" || exit_code=$?
}

check_plant() {
  local name="$1" plant="$2" line="$3"
  run_refusal "$plant"
  judge "the refusal fails on $name" 1 "$(grep -nF -- "$line" "$work/repo/.github/workflows/tests.yml" | head -1)"
}

tree_needs() {
  jq -cn --argjson needs "$(jq -c .needs "$work/gate.json")" --arg tree "$1" '
    $needs | map({key: ., value: (
      if . != "tested-tree" then {result: "success", outputs: {}}
      elif $tree == "answered" then {result: "success", outputs: {tested: "false"}}
      elif $tree == "masked" then {result: "success", outputs: {}}
      else {result: "failure", outputs: {}} end
    )}) | from_entries
  '
}

count="$(jq '.cases | length' "$cases")"
for ((i = 0; i < count; i++)); do
  jq ".cases[$i]" "$cases" > "$work/case.json"
  name="$(jq -r .name "$work/case.json")"
  needs="$(jq -c --argjson needs "$(jq -c .needs "$work/gate.json")" '
    . as $case
    | $needs | map({key: ., value: {
        result: ($case.results[.] // $case.default),
        outputs: (if . == "tested-tree" and $case.tested != null then {tested: $case.tested} else {} end)
      }}) | from_entries
  ' "$work/case.json")"
  jq -c --slurpfile all "$cases" '
    .jobList as $list
    | {jobs: [$all[0].jobNames[] | {name: ., status: "completed", conclusion: (
        if . == "Check for an already tested tree" then "success" else $list.conclusion end)}
      | if $list.lagging == null or .name == $list.lagging then .status = "in_progress" | .conclusion = null else . end]}
  ' "$work/case.json" > "$work/jobs.json"
  run_gate "$(jq -r .event "$work/case.json")" "$(jq -r .fork "$work/case.json")" "$needs"
  judge "$name" "$(jq -r .exit "$work/case.json")" "$(jq -r .phrase "$work/case.json")"
done

on_jest='/^  jest:$/a\'
after_lint='/^      - run: npm run lint$/a\'
on_check='/^      - id: check$/a\'
escaped='"continue\\x2Don\\x2Derror"'

run_refusal ""
judge "the refusal accepts tests.yml as it is" 0 ""
run_refusal missing
judge "the refusal fails when it cannot read tests.yml" 1 "grep: .github/workflows/tests.yml: No such file or directory"
check_plant "continue-on-error on a job" "$on_jest    continue-on-error: true" "    continue-on-error: true"
check_plant "continue-on-error with an expression" "$on_jest    continue-on-error: \${{ github.event_name == 'push' }}" "    continue-on-error: \${{"
check_plant "continue-on-error on a step" "$after_lint        continue-on-error: true" "        continue-on-error: true"
check_plant "continue-on-error on the check step" "$on_check        continue-on-error: true" "        continue-on-error: true"
check_plant "an upper-case spelling" "$on_jest    Continue-On-Error: true" "    Continue-On-Error: true"
check_plant "an escaped double-quoted key" "$on_jest    $escaped: true" "    \"continue\x2Don\x2Derror\": true"
check_plant "a single-quoted key" "$on_jest    'timeout-minutes': 30" "    'timeout-minutes': 30"
check_plant "a quoted key in a flow mapping" "$after_lint      - {run: exit 1, $escaped: true}" "      - {run: exit 1, \"continue\x2Don\x2Derror\": true}"
check_plant "an explicit key" "$on_jest    ? $escaped\n    : true" "    ? \"continue\x2Don\x2Derror\""

echo '{"jobs":[]}' > "$work/jobs.json"
for event in pull_request merge_group push workflow_dispatch; do
  run_refusal "$on_jest    $escaped: true"
  tree=answered
  [ "$exit_code" = 0 ] || tree=failed
  run_gate "$event" false "$(tree_needs "$tree")"
  judge "a $event run with an escaped continue-on-error key on jest fails at the tree check" 1 "Tests did not pass: tested-tree=failure"
  run_refusal "$on_check        continue-on-error: true"
  tree=answered
  [ "$exit_code" = 0 ] || tree=masked
  run_gate "$event" false "$(tree_needs "$tree")"
  judge "a $event run whose refusal is masked by continue-on-error on the check step fails" 1 "Tests did not pass: invalid test results=failure"
done

if [ -s "$work/gh-calls" ]; then
  echo "The test gate must judge from needs alone, but it called: $(sort -u "$work/gh-calls" | paste -sd ';')" >&2
  exit 1
fi
if [ "$wrong" != 0 ]; then
  echo "Test gate cases judged wrongly: $wrong of $checked." >&2
  exit 1
fi
if [ "$checked" != "$expected_cases" ]; then
  echo "Test gate cases checked: $checked, not the $expected_cases this script counts on." >&2
  exit 1
fi
echo "Test gate cases judged as expected: all $checked."
