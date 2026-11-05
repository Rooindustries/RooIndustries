#!/usr/bin/env bash
set -euo pipefail

twin="${1:?usage: check-reproducible-build.sh <path for a second checkout>}"
dist="${NEXT_DIST_DIR:?NEXT_DIST_DIR is required}"
: "${BASE_URL:?BASE_URL is required}"
here="$(pwd -P)"
report="$(mktemp -d)"

if [ -e "$twin" ]; then
  echo "$twin already exists; choose a fresh path." >&2
  exit 1
fi

cleanup() {
  git -C "$here" worktree remove --force "$twin" 2>/dev/null || true
  rm -rf -- "${report:?}"
}
trap cleanup EXIT

build() {
  (cd "$1" && exec node scripts/test-tooling-sweep-server.mjs) &
  local pid=$!
  local waited=0
  until curl --fail --silent "$BASE_URL" > /dev/null; do
    kill -0 "$pid"
    waited=$((waited + 1))
    if [ "$waited" -gt 900 ]; then
      kill "$pid"
      echo "Build in $1 did not start serving." >&2
      exit 1
    fi
    sleep 1
  done
  kill "$pid"
  wait "$pid" || true
}

measure() {
  local static="$1/$dist/static"
  local build_id
  build_id="$(cat "$1/$dist/BUILD_ID")"
  (cd "$1" && node scripts/check-budgets.js 2>&1 || true) | grep -E '^(First load|Lazy) ' | sort
  (cd "$static" && find . -type f ! -path "./$build_id/*" | sort)
}

git worktree add --detach "$twin" HEAD > /dev/null
cp -a --reflink=auto node_modules "$twin/"

build "$here"
measure "$here" > "$report/first.txt"
build "$twin"
measure "$twin" > "$report/second.txt"

if ! diff -u "$report/first.txt" "$report/second.txt"; then
  echo "The same source built in $here and $twin produced different client chunks or sizes." >&2
  exit 1
fi
echo "Both builds produced identical client chunks and sizes ($(grep -c '^First load' "$report/first.txt") routes)."
