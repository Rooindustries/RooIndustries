#!/usr/bin/env bash
set -euo pipefail

cache_inputs=(package.json package-lock.json .npmrc next.config.mjs)

say() {
  printf '%s\n' "$1"
}

tested=false
tree="$(git rev-parse 'HEAD^{tree}')"
before="${PUSH_BEFORE:-}"

if [ -z "$before" ] || [ "$before" = 0000000000000000000000000000000000000000 ]; then
  say "No earlier main commit to compare this push against; running the full suite."
elif ! git cat-file -e "$before^{commit}" 2>/dev/null && ! git fetch --quiet --no-tags --depth=1 origin "$before"; then
  say "Couldn't fetch the earlier main commit $before; running the full suite."
elif ! git diff --quiet "$before" HEAD -- "${cache_inputs[@]}"; then
  say "This push changed ${cache_inputs[*]}; running the full suite so main refreshes its caches."
elif ! runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=tested-tree-$tree&per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | .workflow_run.id')"; then
  say "Couldn't look up which runs tested tree $tree; running the full suite."
else
  for run in $runs; do
    if ! passed="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq \
      'select(.conclusion == "success" and .event == "pull_request" and .path == ".github/workflows/tests.yml"
        and .head_repository.full_name == env.GITHUB_REPOSITORY) | .id')"; then
      say "Couldn't look up run $run; not counting it."
      continue
    fi
    if [ -n "$passed" ]; then
      say "Pull request run $passed already passed on tree $tree; skipping the suite."
      tested=true
      break
    fi
  done
  if [ "$tested" = false ]; then
    say "No passed pull request run tested tree $tree; running the full suite."
  fi
fi

echo "tested=$tested" >> "$GITHUB_OUTPUT"
