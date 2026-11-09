set -euo pipefail

archive_dir="$HOME/.cache/roo-playwright-apt"
mkdir -p "$archive_dir"
apt_config=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/playwright-apt.XXXXXX")
trap 'rm -f -- "$apt_config"' EXIT
chmod 644 "$apt_config"
printf 'Dir::Cache::archives "%s";\nAPT::Keep-Downloaded-Packages "true";\n' "$archive_dir" > "$apt_config"
sudo env APT_CONFIG="$apt_config" "$(command -v node)" "$PWD/node_modules/playwright/cli.js" install-deps "$@"
