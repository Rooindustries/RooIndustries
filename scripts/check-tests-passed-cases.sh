#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
cases=.github/tests-passed-cases.json
expected_cases=2
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT

node --input-type=module -e '
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
const { jobs } = yaml.load(readFileSync(".github/workflows/tests.yml", "utf8"));
const gate = jobs["tests-passed"];
const needs = [gate.needs].flat();
const step = gate.steps.find((s) => s.run);
console.log(JSON.stringify({
  run: step.run,
  needs,
  missing: Object.keys(jobs).filter((job) => job !== "tests-passed" && !needs.includes(job)),
  always: gate.if === "always()",
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

mkdir "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
cat "$JOB_LIST"
STUB
chmod +x "$work/bin/gh"

checked=0
wrong=0
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
        if $list == null then "success"
        elif . == "Check for an already tested tree" then "success"
        else $list.conclusion end)}
      | if $list != null and .name == $list.lagging then .status = "in_progress" | .conclusion = null else . end]}
  ' "$work/case.json" > "$work/jobs.json"
  exit_code=0
  output="$(env PATH="$work/bin:$PATH" JOB_LIST="$work/jobs.json" GH_TOKEN=unused \
    GITHUB_EVENT_NAME="$(jq -r .event "$work/case.json")" FORK="$(jq -r .fork "$work/case.json")" \
    NEEDS="$needs" GITHUB_REPOSITORY=Rooindustries/RooIndustries GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 \
    bash -e "$work/gate.sh" 2>&1)" || exit_code=$?
  expected_exit="$(jq -r .exit "$work/case.json")"
  phrase="$(jq -r .phrase "$work/case.json")"
  checked=$((checked + 1))
  if [ "$exit_code" != "$expected_exit" ] || ! grep -qF -- "$phrase" <<< "$output"; then
    wrong=$((wrong + 1))
    printf 'Case "%s" should exit %s saying "%s". It exited %s saying:\n%s\n\n' \
      "$name" "$expected_exit" "$phrase" "$exit_code" "$output" >&2
  fi
done

if [ "$wrong" != 0 ]; then
  echo "Test gate cases judged wrongly: $wrong of $checked." >&2
  exit 1
fi
if [ "$checked" != "$expected_cases" ]; then
  echo "Test gate cases checked: $checked, not the $expected_cases this script counts on." >&2
  exit 1
fi
echo "Test gate cases judged as expected: all $checked."
