#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || $1 != --live ]]; then
  echo 'Usage: bash scripts/diagnose-repo-skill-harnesses.sh --live' >&2
  echo 'This diagnostic sends requests to live model providers using the active profiles.' >&2
  echo 'Run it only when the user requested live harness validation. Repository E2E tests do not invoke it.' >&2
  exit 64
fi

repo=$(git rev-parse --show-toplevel)
artifacts=${ROO_SKILLS_ARTIFACTS:-$repo/test-results/repo-skills}
mkdir -p "$artifacts" "${TMPDIR:-$HOME/.cache/agent-tmp}"
artifacts=$(cd "$artifacts" && pwd)
scratch=$(mktemp -d "${TMPDIR:-$HOME/.cache/agent-tmp}/roo-skills-diagnostic.XXXXXX")
cleanup() {
  local status=$?
  if [[ $status == 0 ]]; then rm -r -- "$scratch"; else printf 'Diagnostics: %s\n' "$scratch" >&2; fi
}
trap cleanup EXIT
expected='["roo-integrations-ops","roo-navbar-regression-guard","roo-parallel-worktrees","roo-seo-release-qa","roo-single-folder-guard","roo-single-writer-lock"]'
mkdir -p "$scratch/checkout/nested" "$scratch/outside"
git -C "$repo" archive "${ROO_SKILLS_TREEISH:-HEAD}" .agents/skills .claude/skills | tar -x -C "$scratch/checkout"
git -C "$scratch/checkout" init -q
git -C "$scratch/outside" init -q

prompt='This is a read-only skill discovery check. Do not call tools, inspect files, or delegate. From the skills already offered in your current context, output only a JSON array of skill names beginning with roo-. Use [] if none are offered. Do not infer names from repository instructions.'
codex_config=(
  -c 'features.shell_tool=false'
  -c 'features.multi_agent=false'
  -c 'features.view_image=false'
  -c 'features.apps=false'
  -c 'features.plugins=false'
  -c 'features.hooks=false'
  -c 'features.browser_use=false'
  -c 'features.computer_use=false'
  -c 'features.image_generation=false'
  -c 'web_search="disabled"'
)
server_keys=$(codex "${codex_config[@]}" mcp list --json | jq -r '.[].name')
while IFS= read -r key; do
  [[ -z "$key" ]] || codex_config+=(-c "mcp_servers.$key.enabled=false")
done <<<"$server_keys"

probe() {
  local harness=$1 cwd=$2 label=$3 wanted=$4
  local output="$scratch/$harness-$label.jsonl"
  if [[ "$harness" == claude ]]; then
    (cd "$cwd"; timeout 180s claude -p "$prompt" \
      --output-format stream-json --verbose --no-session-persistence --max-turns 1 --tools Skill \
      --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"disableAllHooks":true}') \
      < /dev/null > "$output" 2> "$scratch/$harness-$label.stderr"
    jq -se 'all(.[]; .is_error != true) and ([.[] | select(.type == "assistant") | .message.content[]? | select(.type == "tool_use")] | length) == 0' "$output" >/dev/null
    jq -s '[.[] | select(.type == "result")][-1].result | fromjson | sort' "$output" > "$artifacts/$harness-context-$label.json"
  else
    timeout 180s codex exec --json --ephemeral --skip-git-repo-check -C "$cwd" --sandbox read-only \
      -c 'notify=[]' \
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
jq -n --argjson skills "$expected" '{result:"passed",liveModelRequests:true,skills:$skills}' > "$artifacts/harness-diagnostic.json"
printf 'Live harness diagnostic passed. Artifacts: %s\n' "$artifacts"
