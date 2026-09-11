#!/usr/bin/env bash
# Stop everything scripts/up.sh started.
set -uo pipefail
cd "$(dirname "$0")/.."

pid_on_port() { ss -lptn "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

for p in 3000 8546; do
  pid=$(pid_on_port $p)
  if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null && echo "stopped :$p"; fi
done
kpid=$(pgrep -f "tsx keeper/src/index.ts" | head -1)
if [ -n "${kpid:-}" ]; then kill "$kpid" 2>/dev/null && echo "stopped keeper"; fi
echo "done"
