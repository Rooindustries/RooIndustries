#!/usr/bin/env bash
set -euo pipefail

version=1.7.4
checksum=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
cache_dir="${TLA_TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tla-tools}"
mkdir -p "$cache_dir"
cache_dir="$(cd "$cache_dir" && pwd)"
jar="$cache_dir/tla2tools-$version.jar"
download=""
states="$(mktemp -d)"
trap 'rm -rf -- "$states" ${download:+"$download"}' EXIT

has_checksum() {
  if command -v sha256sum >/dev/null; then
    printf '%s  %s\n' "$checksum" "$1" | sha256sum --check --status -
  else
    printf '%s  %s\n' "$checksum" "$1" | shasum -a 256 --check --status -
  fi
}

if ! has_checksum "$jar" 2>/dev/null; then
  download="$(mktemp "$cache_dir/tla2tools.XXXXXX")"
  curl --fail --silent --show-error --location \
    "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar" -o "$download"
  has_checksum "$download"
  mv "$download" "$jar"
  download=""
fi

cd "$(dirname "$0")/../formal"
for config in BookingHolds BookingHoldsLiveness BookingHoldsMove; do
  java -XX:+UseParallelGC -jar "$jar" -deadlock -workers auto \
    -metadir "$states/$config" -config "$config.cfg" BookingHolds.tla
done
