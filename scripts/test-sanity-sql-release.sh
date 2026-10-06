set -eu
python3 scripts/test-sanity-sql-rehearsal.py --scenario=release
node scripts/test-sanity-sql-stack.mjs
