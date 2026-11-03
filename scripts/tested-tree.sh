#!/usr/bin/env bash
set -euo pipefail

cache_inputs=(package.json package-lock.json .npmrc next.config.mjs)

say() {
  printf '%s\n' "$1"
}

tested=false
tree="$(git rev-parse 'HEAD^{tree}')"

if ! git rev-parse --verify --quiet 'HEAD^' >/dev/null; then
  say "No parent commit to compare against; running the full suite."
elif ! git diff --quiet 'HEAD^' HEAD -- "${cache_inputs[@]}"; then
  say "This merge changed ${cache_inputs[*]}; running the full suite so main refreshes its caches."
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
