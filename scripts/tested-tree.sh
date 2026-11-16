#!/usr/bin/env bash
set -euo pipefail

cache_inputs=(package.json package-lock.json .npmrc next.config.mjs .github/actions/postgres/action.yml)

say() {
  printf '%s\n' "$1"
}

tested=false
tree="$(git rev-parse 'HEAD^{tree}')"
before="${PUSH_BEFORE:-}"

if [ "$GITHUB_EVENT_NAME" = push ] && \
  { [ -z "$before" ] || [ "$before" = 0000000000000000000000000000000000000000 ]; }; then
  say "No earlier main commit to compare this push against; running the full suite."
elif [ "$GITHUB_EVENT_NAME" = push ] && ! git cat-file -e "$before^{commit}" 2>/dev/null \
  && ! git fetch --quiet --no-tags --depth=1 origin "$before"; then
  say "Couldn't fetch the earlier main commit $before; running the full suite."
elif [ "$GITHUB_EVENT_NAME" = push ] && ! git diff --quiet "$before" HEAD -- "${cache_inputs[@]}"; then
  say "This push changed ${cache_inputs[*]}; running the full suite so main refreshes its caches."
elif ! runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=tested-tree-$tree&per_page=100" \
  --jq '.artifacts[] | select(.expired | not) | .workflow_run.id')"; then
  say "Couldn't look up which runs tested tree $tree; running the full suite."
else
  for run in $runs; do
    if ! head_sha="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run" --jq \
      'select(.conclusion == "success" and (.event | IN("pull_request", "merge_group", "push", "workflow_dispatch"))
        and .path == ".github/workflows/tests.yml"
        and .head_repository.full_name == env.GITHUB_REPOSITORY) | (.head_sha // "missing")')"; then
      say "Couldn't look up run $run; not counting it."
      continue
    fi
    if [ -z "$head_sha" ]; then
      continue
    fi
    if [ "$head_sha" = missing ] || ! run_tree="$(gh api "repos/$GITHUB_REPOSITORY/git/commits/$head_sha" \
      --jq '.tree.sha // empty')"; then
      say "Couldn't read the commit of run $run; not counting it."
      continue
    fi
    if [ "$run_tree" != "$tree" ]; then
      say "Run $run tested tree $run_tree, not $tree; not counting it."
      continue
    fi
    say "Run $run already passed on tree $tree; skipping the suite."
    tested=true
    break
  done
  if [ "$tested" = false ]; then
    say "No passed run tested tree $tree; running the full suite."
  fi
fi

echo "tested=$tested" >> "$GITHUB_OUTPUT"
