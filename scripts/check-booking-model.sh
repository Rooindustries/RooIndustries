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
for config in BookingHolds BookingHoldsLiveness BookingHoldsMove BookingHoldsRetries; do
  java -XX:+UseParallelGC -jar "$jar" -deadlock -workers auto \
    -metadir "$states/$config" -config "$config.cfg" BookingHolds.tla
done

witnesses=(
  NotWitnessRetainedRetrySuccess
  NotWitnessThreeFailuresThenRelease
  NotWitnessReadThenCommitExpiryRace
  NotWitnessVisitorClaimsExpiredRetained
  NotWitnessLateCaptureAfterFailure
  NotWitnessClaimCrashReconcileReschedule
  NotWitnessPendingVetoFailureReschedule
  NotWitnessNonceBoundaryFallbackRelease
)
for inv in "${witnesses[@]}"; do
  cfg="$states/witness-$inv.cfg"
  cat > "$cfg" <<EOF
SPECIFICATION RetrySpec
CONSTANTS
  Tabs = {t1, t2}
  Slots = {s1}
  HoldMinutes = 1
  Backstop = 1
  MaxTime = 1
  MaxNonce = 6
  MaxRetries = 3
SYMMETRY TabPermutations
INVARIANT $inv
EOF
  out="$states/witness-$inv.out"
  if java -XX:+UseParallelGC -jar "$jar" -deadlock -workers auto \
    -metadir "$states/meta-$inv" -config "$cfg" BookingHolds.tla > "$out" 2>&1; then
    echo "Reachability witness failed (never violated): $inv" >&2
    cat "$out" >&2
    exit 1
  fi
  if ! grep -Fq "Invariant $inv is violated." "$out"; then
    echo "Reachability witness errored unexpectedly: $inv" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "Reachability witness verified: $inv"
done
