#!/usr/bin/env bash
# Stop everything scripts/up.sh started.
set -uo pipefail
cd "$(dirname "$0")/.."

pid_on_port() { ss -lptn "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

for p in 3000 8546; do
  pid=$(pid_on_port $p)
  if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null && echo "stopped :$p"; fi
done
# Every process in the keeper's tree, not just the first match: `npx tsx` is npm → sh → node,
# and killing only the npm wrapper orphans the node process, which keeps running and marking
# — two keepers, double the gas.
pkill -f 'keeper/src/index\.ts' && echo "stopped keeper" || true
echo "done"
