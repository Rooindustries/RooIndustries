#!/usr/bin/env bash
set -euo pipefail

mode=${1:-catalog}
case "$mode" in catalog|harnesses) ;; *) echo 'Usage: bash tests/repo-skills-e2e.sh [catalog|harnesses]' >&2; exit 64 ;; esac
repo=$(git rev-parse --show-toplevel)
artifacts=${ROO_SKILLS_ARTIFACTS:-$repo/test-results/repo-skills}
mkdir -p "$artifacts" "${TMPDIR:-$HOME/.cache/agent-tmp}"
artifacts=$(cd "$artifacts" && pwd)
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

if [[ "$mode" == harnesses ]]; then
  prompt='This is a read-only skill discovery check. Do not call tools, inspect files, or delegate. From the skills already offered in your current context, output only a JSON array of skill names beginning with roo-. Use [] if none are offered. Do not infer names from repository instructions.'
  server_keys=$(codex mcp list --json | jq -r '.[].name')
  codex_config=()
  while IFS= read -r key; do
    [[ -z "$key" ]] || codex_config+=(-c "mcp_servers.$key.enabled=false")
  done <<<"$server_keys"

  probe() {
    local harness=$1 cwd=$2 label=$3 wanted=$4
    local output="$scratch/$harness-$label.jsonl"
    if [[ "$harness" == claude ]]; then
      (cd "$cwd"; timeout 180s claude -p "$prompt" --model claude-opus-5-5 --effort xhigh \
        --output-format stream-json --verbose --no-session-persistence --max-turns 1 --tools Skill \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"disableAllHooks":true}') \
        < /dev/null > "$output" 2> "$scratch/$harness-$label.stderr"
      jq -se 'all(.[]; .is_error != true) and ([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")] | length) == 0' "$output" >/dev/null
      jq -s '[.[] | select(.type == "result")][-1].result | fromjson | sort' "$output" > "$artifacts/$harness-context-$label.json"
    else
      timeout 180s codex exec --json --ephemeral --skip-git-repo-check -C "$cwd" --sandbox read-only \
        -m gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' -c 'notify=[]' \
        -c 'suppress_unstable_features_warning=true' "${codex_config[@]}" "$prompt" \
        < /dev/null > "$output" 2> "$scratch/$harness-$label.stderr"
      jq -se 'any(.[]; .type == "turn.completed") and all(.[]; .type != "error" and .type != "turn.failed") and ([.[] | select(.type == "item.completed" and .item.type != "agent_message" and .item.type != "reasoning")] | length) == 0' "$output" >/dev/null
      jq -s '[.[] | select(.type == "item.completed" and .item.type == "agent_message")][-1].item.text | fromjson | sort' "$output" > "$artifacts/$harness-context-$label.json"
    fi
    jq -e --argjson expected "$wanted" '. == $expected' "$artifacts/$harness-context-$label.json" >/dev/null
  }

  for harness in claude codex; do
    probe "$harness" "$repo" inside "$expected"
    probe "$harness" "$scratch/outside" outside '[]'
  done
  probe claude "$scratch/checkout/nested" checkout "$expected"
fi

jq -n --arg mode "$mode" --argjson skills "$expected" --arg codex "$(codex --version)" \
  '{result:"passed",mode:$mode,skills:$skills,codex:$codex,checks:["tracked skill files and relative links","repo discovery","clean checkout discovery","nested discovery","outside has no repo skills"]}' > "$artifacts/result.json"
printf 'Repo skills E2E passed (%s). Artifacts: %s\n' "$mode" "$artifacts"
