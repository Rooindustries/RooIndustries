#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
cases=.github/tests-passed-cases.json
expected_cases=39
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
  guard: tree.steps.slice(0, tree.steps.findIndex((s) => s.id === "check"))
    .find((s) => s.name === "Refuse jobs or steps that pass on failure")?.run ?? "",
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
jq -r .guard "$work/gate.json" > "$work/guard.sh"

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

run_guard() {
  rm -rf -- "${work:?}/repo"
  mkdir -p "$work/repo/.github/workflows"
  case "$1" in
    missing) ;;
    none) cp .github/workflows/tests.yml "$work/repo/.github/workflows/tests.yml" ;;
    job) sed '/^  jest:$/a\    continue-on-error: true' .github/workflows/tests.yml > "$work/repo/.github/workflows/tests.yml" ;;
    expression) sed '/^  jest:$/a\    continue-on-error: ${{ github.event_name == '"'push'"' }}' .github/workflows/tests.yml > "$work/repo/.github/workflows/tests.yml" ;;
    quoted) sed '/^  jest:$/a\    "continue-on-error": true' .github/workflows/tests.yml > "$work/repo/.github/workflows/tests.yml" ;;
    step) sed '/^      - run: npm run lint$/a\        continue-on-error: true' .github/workflows/tests.yml > "$work/repo/.github/workflows/tests.yml" ;;
  esac
  exit_code=0
  output="$(cd "$work/repo" && bash -e "$work/guard.sh" 2>&1)" || exit_code=$?
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

run_guard none
judge "the tree check accepts tests.yml as it is" 0 ""
run_guard missing
judge "the tree check fails when it cannot read tests.yml" 1 "grep: .github/workflows/tests.yml: No such file or directory"
for plant in job expression quoted step; do
  run_guard "$plant"
  judge "the tree check refuses continue-on-error planted as $plant" 1 \
    "$(grep -nE 'continue[-]on[-]error' "$work/repo/.github/workflows/tests.yml")"
done

for event in pull_request merge_group push workflow_dispatch; do
  run_guard job
  tree=success
  [ "$exit_code" = 0 ] || tree=failure
  needs="$(jq -cn --argjson needs "$(jq -c .needs "$work/gate.json")" --arg tree "$tree" '
    $needs | map({key: ., value:
      if . != "tested-tree" then {result: "success", outputs: {}}
      elif $tree == "success" then {result: "success", outputs: {tested: "false"}}
      else {result: "failure", outputs: {}} end
    }) | from_entries
  ')"
  echo '{"jobs":[]}' > "$work/jobs.json"
  run_gate "$event" false "$needs"
  judge "a $event run with continue-on-error on jest fails at the tree check" 1 "Tests did not pass: tested-tree=failure"
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
