#!/usr/bin/env bash
set -euo pipefail

case "${1:-catalog}" in catalog) ;; *) echo 'Usage: bash tests/repo-skills-e2e.sh [catalog]' >&2; exit 64 ;; esac
repo=$(git rev-parse --show-toplevel)
artifacts=${ROO_SKILLS_ARTIFACTS:-$repo/test-results/repo-skills}
mkdir -p "$artifacts" "${TMPDIR:-$HOME/.cache/agent-tmp}"
artifacts=$(cd "$artifacts" && pwd)
rm -f -- "$artifacts/result.json"
scratch=$(mktemp -d "${TMPDIR:-$HOME/.cache/agent-tmp}/roo-skills-e2e.XXXXXX")
cleanup() {
  local status=$?
  if [[ $status == 0 ]]; then rm -rf -- "$scratch"; else printf 'Diagnostics: %s\n' "$scratch" >&2; fi
}
trap cleanup EXIT
expected='["roo-integrations-ops","roo-navbar-regression-guard","roo-parallel-worktrees","roo-seo-release-qa","roo-single-folder-guard","roo-single-writer-lock"]'

mkdir -p "$scratch/checkout/nested" "$scratch/outside"
git -C "$repo" archive "${ROO_SKILLS_TREEISH:-HEAD}" .agents/skills .claude/skills | tar -x -C "$scratch/checkout"
git -C "$scratch/checkout" init -q
git -C "$scratch/outside" init -q

git init --quiet --bare --initial-branch=main "$scratch/origin.git"
git init --quiet --initial-branch=main "$scratch/source"
git -C "$scratch/source" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet --allow-empty -m fixture
git -C "$scratch/source" push --quiet "$scratch/origin.git" main
git clone --quiet "$scratch/origin.git" "$scratch/client"
git -C "$scratch/source" branch renamed
git -C "$scratch/source" push --quiet "$scratch/origin.git" renamed
git -C "$scratch/origin.git" symbolic-ref HEAD refs/heads/renamed
git -C "$scratch/client" fetch --quiet origin
before=$(git -C "$scratch/client" symbolic-ref --short refs/remotes/origin/HEAD)
[[ "$before" == origin/main ]]
git -C "$scratch/client" remote set-head origin --auto > /dev/null
after=$(git -C "$scratch/client" symbolic-ref --short refs/remotes/origin/HEAD)
[[ "$after" == origin/renamed && $(git -C "$scratch/client" branch --show-current) == main ]]
git -C "$scratch/client" remote set-url origin https://fixture-user:fixture-token@example.invalid/Rooindustries/RooIndustries.git
{
  git -C "$scratch/client" rev-parse --show-toplevel
  git -C "$scratch/client" remote
  git -C "$scratch/client" worktree list --porcelain
  git -C "$scratch/client" branch -a
} > "$scratch/identification.txt"
if grep -Fq 'fixture-token' "$scratch/identification.txt"; then exit 1; fi
jq -n --arg before "$before" --arg after "$after" '{cached:$before,refreshed:$after,worktreeBranch:"main",credentialsExposed:false}' > "$artifacts/git-workflow.json"

for skill in $(jq -r '.[]' <<<"$expected"); do
  target=$(realpath "$scratch/checkout/.claude/skills/$skill")
  [[ "$target" == "$scratch/checkout/.agents/skills/$skill" ]]
  [[ -f "$target/SKILL.md" ]]
done

read_response() {
  local wanted=$1 line
  while IFS= read -r -t 30 line <&"$loader_out"; do
    if jq -e --argjson id "$wanted" '.id == $id' >/dev/null <<<"$line"; then
      reply=$line
      return
    fi
  done
  echo "Codex loader did not answer request $wanted" >&2
  return 1
}

catalog() (
  local cwd=$1 label=$2 expected_root=$3
  coproc LOADER { exec codex app-server --stdio 2>"$scratch/$label-catalog.stderr"; }
  local loader_pid=${!} loader_in=${LOADER[1]} loader_out=${LOADER[0]}
  trap 'kill "$loader_pid" 2>/dev/null || true; wait "$loader_pid" 2>/dev/null || true' EXIT
  printf '%s\n' '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"roo-skills-e2e","version":"1.0.0"}}}' >&"$loader_in"
  read_response 1
  jq -e '.result != null and .error == null' >/dev/null <<<"$reply"
  printf '%s\n' '{"method":"initialized"}' >&"$loader_in"
  jq -nc --arg cwd "$cwd" '{id:2,method:"skills/list",params:{cwds:[$cwd],forceReload:true}}' >&"$loader_in"
  read_response 2
  printf '%s\n' "$reply" > "$scratch/$label-catalog.json"
  jq -e '.error == null and (.result.data | length) == 1 and (.result.data[0].errors | length) == 0' "$scratch/$label-catalog.json" >/dev/null
  jq '.result.data[0] | {cwd,skills:[.skills[] | select(.name | startswith("roo-")) | {name,path,scope,enabled}]}' "$scratch/$label-catalog.json" > "$artifacts/codex-$label.json"
  if [[ -n "$expected_root" ]]; then
    jq -e --argjson expected "$expected" --arg root "$expected_root/.agents/skills/" '
      [.skills[] | select(.scope == "repo" and .enabled and (.path | startswith($root))) | .name] | sort == $expected
    ' "$artifacts/codex-$label.json" >/dev/null
  else
    jq -e '[.skills[] | select(.scope == "repo")] | length == 0' "$artifacts/codex-$label.json" >/dev/null
  fi
)

catalog "$repo" inside "$repo"
catalog "$scratch/checkout" checkout "$scratch/checkout"
catalog "$scratch/checkout/nested" nested "$scratch/checkout"
catalog "$scratch/outside" outside ''

jq -n --argjson skills "$expected" --arg codex "$(codex --version)" \
  '{result:"passed",skills:$skills,codex:$codex,checks:["remote default branch refresh","repository identity without credentials","tracked skill files and relative links","repo discovery","clean checkout discovery","nested discovery","outside has no repo skills"]}' > "$artifacts/result.json"
printf 'Repo skills E2E passed. Artifacts: %s\n' "$artifacts"
