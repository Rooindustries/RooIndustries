#!/usr/bin/env bash
set -euo pipefail

count="${1:?usage: check-test-servers.sh <tests at a time>}"
if ! [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
  echo "The number of tests at a time must be a whole number of at least 1, not \"$count\"." >&2
  exit 1
fi
reports="$(dirname "$0")/../.next-fixture-ports"

listeners() {
  local sockets
  sockets="$(ss -ltnpH "sport = :$1")"
  [ -n "$sockets" ] && ! grep -qv 'pid=[0-9]' <<< "$sockets" &&
    grep -o 'pid=[0-9]*' <<< "$sockets" | cut -d= -f2 | sort -u
}

descends_from() {
  local pid="$1" stat
  while [ "$pid" != "$2" ]; do
    if [ "$pid" -le 1 ] || ! stat="$(cat "/proc/$pid/stat" 2> /dev/null)"; then
      return 1
    fi
    read -r _ pid _ <<< "${stat##*) }"
  done
}

held_by() {
  local holders listener
  holders="$(listeners "$1")" || return 1
  for listener in $holders; do
    descends_from "$listener" "$2" || return 1
  done
}

server_process() {
  local host="$ROO_TEST_HOST:$1" origin report instance content_port pid
  origin="http://$host"
  report="$reports/${host//[^a-zA-Z0-9.-]/_}.json"
  if ! curl --fail --silent "$origin" > /dev/null; then
    echo "$origin does not answer." >&2
  elif ! IFS=$'\t' read -r instance content_port pid < <(jq -r --arg origin "$origin" '
    select(.baseURL == $origin and (.instance | type == "string")
      and ([.pid, .ports.TOOLING_CONTENT_PORT] | all(type == "number" and . == floor)))
    | [.instance, .ports.TOOLING_CONTENT_PORT, .pid] | @tsv' "$report"); then
    echo "$origin has no ports report naming it, its fixture port and its process." >&2
  elif [ "$(curl --fail --silent "http://$ROO_TEST_HOST:$content_port/__instance")" != "$instance" ]; then
    echo "The fixture of $origin on port $content_port does not answer with its report's instance." >&2
  elif [ "$(listeners "$content_port")" != "$pid" ]; then
    echo "Fixture port $content_port of $origin is not held by process $pid, which reported it." >&2
  elif ! held_by "$1" "$pid"; then
    echo "The page port of $origin is not held by process $pid, which reported it, or by a child of it." >&2
  else
    echo "$pid"
    return
  fi
  return 1
}

declare -A servers=()
for ((index = 0; index < count; index++)); do
  port=$((PW_PORT + 100 * index))
  if pid="$(server_process "$port")"; then
    if [ -n "${servers[$pid]:-}" ]; then
      echo "http://$ROO_TEST_HOST:$port is held by process $pid," \
        "the server already counted on port ${servers[$pid]}." >&2
    else
      servers["$pid"]="$port"
    fi
  fi
done

found="${#servers[@]}"
if [ "$found" != "$count" ]; then
  echo "Asked for $count tests at a time, but $found test servers own their page port and fixture." \
    "Two workers against one server would share its state, so nothing was run." >&2
  exit 1
fi
echo "Test servers that own their page port and fixture: $found."
