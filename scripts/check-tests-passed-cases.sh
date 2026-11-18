#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."
root="$PWD"
cases=.github/tests-passed-cases.json
expected_cases=60
work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT

inspect() {
  (cd "$1" && node --input-type=module -e '
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import yaml from "js-yaml";
const workflow = ".github/workflows/tests.yml";
const { jobs } = yaml.load(readFileSync(workflow, "utf8"));
const lenient = [];
const unreadable = [];
const uses = [];
const find = (file, node, path) => {
  if (Array.isArray(node)) {
    node.forEach((item, i) => find(file, item, `${path}[${item?.name ?? item?.id ?? item?.uses ?? String(item?.run ?? i).split("\n")[0]}]`));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key.toLowerCase() === "continue-on-error") lenient.push(`${file}: ${path}.${key}`);
      if (key === "uses" && typeof value === "string" && value.startsWith("./")) uses.push({ file, path, value });
      find(file, value, `${path}.${key}`);
    }
  }
};
find(workflow, jobs, "jobs");
const scanned = new Set();
const scan = (file) => {
  if (scanned.has(file)) return;
  scanned.add(file);
  find(file, yaml.load(readFileSync(file, "utf8"))?.runs, "runs");
};
readdirSync(".github/actions", { recursive: true }).filter((file) => /(^|\/)action\.ya?ml$/.test(file)).sort()
  .forEach((file) => scan(`.github/actions/${file}`));
for (let i = 0; i < uses.length; i++) {
  const { file, path, value } = uses[i];
  const files = ["action.yml", "action.yaml"].map((name) => posix.join(value, name)).filter(existsSync);
  if (!files.length) unreadable.push(`${file}: ${path} uses ${value}, which has no action.yml or action.yaml.`);
  files.forEach(scan);
}
const record = jobs.jest.steps.find((s) => s.id === "gate-cases");
const recorded = jobs.jest.outputs?.checked === "${{ steps.gate-cases.outputs.checked }}" &&
  record?.run === "bash scripts/check-tests-passed-cases.sh";
if (lenient.length || unreadable.length || !recorded) {
  for (const line of lenient) console.error(line);
  if (lenient.length) console.error("The test gate cannot trust these: continue-on-error lets a failed job or step count as passed. Remove it.");
  for (const line of unreadable) console.error(line);
  if (!recorded) console.error("The Jest job must run bash scripts/check-tests-passed-cases.sh in step gate-cases and output checked: ${{ steps.gate-cases.outputs.checked }}, the record the test gate requires.");
  process.exit(1);
}
const gate = jobs["tests-passed"];
const needs = [gate.needs].flat();
const step = gate.steps.find((s) => s.run);
console.log(JSON.stringify({
  run: step.run,
  needs,
  missing: Object.keys(jobs).filter((job) => job !== "tests-passed" && !needs.includes(job)),
  always: gate.if === "always()",
}));
')
}

inspect "$root" > "$work/gate.json"

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

count="$(jq '.cases | length' "$cases")"
for ((i = 0; i < count; i++)); do
  jq ".cases[$i]" "$cases" > "$work/case.json"
  name="$(jq -r .name "$work/case.json")"
  needs="$(jq -c --argjson needs "$(jq -c .needs "$work/gate.json")" '
    . as $case
    | $needs | map({key: ., value: {
        result: ($case.results[.] // $case.default),
        outputs: (if . == "tested-tree" and $case.tested != null then {tested: $case.tested}
          elif . == "jest" and $case.checked != null then {checked: $case.checked} else {} end)
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
plant() {
  local name="$1" expected_exit="$2" file="$3" edit="$4" phrase="$5"
  shift 5
  rm -rf -- "${work:?}/repo"
  mkdir -p "$work/repo"
  cp -r .github "$work/repo/"
  ln -s "$root/node_modules" "$work/repo/node_modules"
  while [ "$#" -gt 0 ]; do
    mkdir -p "$work/repo/$(dirname "$1")"
    printf "%s\n" "$2" > "$work/repo/$1"
    shift 2
  done
  sed -i "$edit" "$work/repo/$file"
  exit_code=0
  output="$(inspect "$work/repo" 2>&1 > /dev/null)" || exit_code=$?
  judge "the runner on a copy with $name" "$expected_exit" "$phrase"
}

workflow=.github/workflows/tests.yml
setup=.github/actions/setup/action.yml
plant "tests.yml as it is" 0 "$workflow" "" ""
plant "continue-on-error on a job" 1 "$workflow" "$on_jest    continue-on-error: true" \
  "$workflow: jobs.jest.continue-on-error"
plant "continue-on-error on a step" 1 "$workflow" "$after_lint        continue-on-error: true" \
  "$workflow: jobs.jest.steps[npm run lint].continue-on-error"
plant "continue-on-error on the step that writes the record" 1 "$workflow" \
  "/^      - id: gate-cases$/a\\        continue-on-error: true" \
  "$workflow: jobs.jest.steps[gate-cases].continue-on-error"
plant "a tagged continue-on-error key" 1 "$workflow" "$on_jest    !!str continue-on-error: true" \
  "$workflow: jobs.jest.continue-on-error"
plant "a folded continue-on-error key" 1 "$workflow" "$on_jest    ? >-\n      continue-on-error\n    : true" \
  "$workflow: jobs.jest.continue-on-error"
plant "a continue-on-error key folded across lines in a flow mapping" 1 "$workflow" \
  "$after_lint      - {run: exit 1, ? \"continue-\\\\\n        on-error\" : true}" \
  "$workflow: jobs.jest.steps[exit 1].continue-on-error"
plant "continue-on-error: false" 1 "$workflow" "$on_jest    continue-on-error: false" \
  "$workflow: jobs.jest.continue-on-error"
plant "continue-on-error as an expression" 1 "$workflow" \
  "$on_jest    continue-on-error: \${{ github.event_name == 'push' }}" \
  "$workflow: jobs.jest.continue-on-error"
plant "an upper-case continue-on-error key" 1 "$workflow" "$on_jest    Continue-On-Error: true" \
  "$workflow: jobs.jest.Continue-On-Error"
plant "continue-on-error merged in from another mapping" 1 "$workflow" \
  "$on_jest    <<: {continue-on-error: true}" \
  "$workflow: jobs.jest.continue-on-error"
plant "continue-on-error on a step of a local action" 1 "$setup" \
  "/^    - uses: actions\/setup-node@v4$/a\\      continue-on-error: true" \
  "$setup: runs.steps[actions/setup-node@v4].continue-on-error"
failing=$'name: Checks\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: exit 1\n      continue-on-error: true'
passing=$'name: Checks\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: "true"'
outside="which is not ./.github/actions/<name>, an action from another repository or docker://."
folder="whose folder needs a composite action.yml and no action.yaml."
uses_plant() {
  local name="$1" ref="$2" phrase="$3"
  shift 3
  plant "$name" 1 "$workflow" "$after_lint      - uses: $ref" \
    "$workflow: jobs.jest.steps[$ref] uses $ref, $phrase" "$@"
}
uses_plant "a nested local action a job uses" ./.github/actions/group/checks "$outside" \
  .github/actions/group/checks/action.yml "$failing"
uses_plant "a composite action outside .github/actions" ./tools/checks "$outside" tools/checks/action.yml "$passing"
uses_plant "a JavaScript action outside .github/actions" ./tools/js "$outside" \
  tools/js/action.yml $'name: Js\nruns:\n  using: node20\n  main: index.js' tools/js/index.js ""
uses_plant "a self-repository reference" '$/tools/checks' "$outside" tools/checks/action.yml "$failing"
uses_plant "this repository by name" rooINDUSTRIES/RooIndustries/tools/checks@main "$outside" \
  tools/checks/action.yml "$failing"
uses_plant "an expression in uses" '${{ vars.CHECKS }}' "$outside"
uses_plant "an expression in another repository's path" 'octo/repo/${{vars.PATH}}@v1' "$outside"
uses_plant "a Dockerfile-only local action" ./.github/actions/docker "$folder" \
  .github/actions/docker/Dockerfile "FROM alpine:3.20"
uses_plant "an action.yaml beside action.yml" ./.github/actions/twin "$folder" \
  .github/actions/twin/action.yml "$passing" .github/actions/twin/action.yaml "$passing"
uses_plant "a JavaScript action under .github/actions" ./.github/actions/js "$folder" \
  .github/actions/js/action.yml $'name: Js\nruns:\n  using: node20\n  main: index.js' .github/actions/js/index.js ""
plant "a reusable workflow job" 1 "$workflow" "\$a\\  reuse:\n    uses: octo/repo/.github/workflows/x.yml@v1" \
  "$workflow: jobs.reuse uses octo/repo/.github/workflows/x.yml@v1, a reusable workflow the test gate cannot check."
plant "continue-on-error in a local action another local action uses" 1 "$workflow" \
  "$after_lint      - uses: ./.github/actions/outer" \
  ".github/actions/inner/action.yml: runs.steps[exit 1].continue-on-error" \
  .github/actions/outer/action.yml $'name: Outer\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner' \
  .github/actions/inner/action.yml "$failing"
plant "continue-on-error in a nested local action no job uses" 1 "$workflow" "" \
  ".github/actions/group/unused/action.yml: every action under .github/actions must be a composite action.yml in its own folder, with no action.yaml beside it." \
  .github/actions/group/unused/action.yml "$failing"
plant "a Jest record not written by this script" 1 "$workflow" \
  "s/checked: \${{ steps.gate-cases.outputs.checked }}/checked: \"true\"/" \
  "The Jest job must run bash scripts/check-tests-passed-cases.sh in step gate-cases and output checked: \${{ steps.gate-cases.outputs.checked }}, the record the test gate requires."

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
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo checked=true >> "$GITHUB_OUTPUT"
fi
