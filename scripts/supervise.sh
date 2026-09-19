#!/usr/bin/env bash
#
# Keep the live deployment alive, and say plainly when it cannot be.
#
# Every outage so far had the same shape: a background process died or a wallet ran dry, and
# nothing noticed until a person clicked a button and got a revert. This watches the three
# things that actually break, restarts what it can, and writes a status file the app reads so
# the site can tell the truth about itself instead of looking broken.
#
#   ./scripts/supervise.sh            watch and repair every 60s
#   ./scripts/supervise.sh --once     one pass, for cron
#
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"

LOGS=.local-logs; mkdir -p "$LOGS"
STATUS=web/public/status.json
ONCE=${1:-}
INTERVAL=60
# Below this the keeper cannot reliably send a price push, so say so before it fails.
LOW_GAS=0.08

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s  %s\n' "$(ts)" "$1" | tee -a "$LOGS/supervise.log"; }

pass() {
  set -a; . ./.env; set +a
  local rpc=${MONAD_TESTNET_RPC:-https://testnet-rpc.monad.xyz}
  local problems=() repaired=()

  # ── 1. keeper alive? ────────────────────────────────────────────────────────
  local kcount
  kcount=$(ps -eo args | grep -c '[t]sx keeper/src/index.ts')
  if [ "$kcount" -eq 0 ]; then
    log "keeper down — restarting"
    setsid nohup npx tsx keeper/src/index.ts > "$LOGS/keeper.log" 2>&1 < /dev/null &
    disown
    repaired+=("keeper restarted")
    sleep 5
  elif [ "$kcount" -gt 2 ]; then
    # Duplicates double the gas burn for no benefit.
    log "$kcount keeper processes — trimming duplicates"
    ps -eo pid,args | grep '[t]sx keeper/src/index.ts' | awk 'NR>2 {print $1}' | xargs -r kill 2>/dev/null
    repaired+=("trimmed duplicate keepers")
  fi

  # ── 2. web alive? ───────────────────────────────────────────────────────────
  if ! curl -sf -o /dev/null --max-time 8 http://127.0.0.1:3000/; then
    log "web down — restarting"
    ( cd web && setsid nohup npx next start -p 3000 > "../$LOGS/web.log" 2>&1 < /dev/null & disown )
    repaired+=("web restarted")
    sleep 6
  fi

  # ── 3. gas ──────────────────────────────────────────────────────────────────
  local addr bal low=0
  addr=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
  bal=$(cast balance "$addr" --rpc-url "$rpc" --ether 2>/dev/null || echo 0)
  if python3 -c "import sys; sys.exit(0 if float('${bal:-0}') < $LOW_GAS else 1)" 2>/dev/null; then
    low=1
    problems+=("keeper wallet low on gas")
    log "LOW GAS: $bal MON at $addr — prices will stop updating"
  fi

  # ── 4. feed freshness ───────────────────────────────────────────────────────
  local now pub age=0
  now=$(cast block latest --field timestamp --rpc-url "$rpc" 2>/dev/null || echo 0)
  pub=$(cast call "${ORACLE_ADDRESS:-}" "price(uint16)(uint256,uint64)" 16 --rpc-url "$rpc" 2>/dev/null | tail -1 | grep -oE '^[0-9]+' || echo 0)
  if [ "${now:-0}" -gt 0 ] && [ "${pub:-0}" -gt 0 ]; then
    age=$(( now - pub ))
    [ "$age" -gt 600 ] && problems+=("price feed stale (${age}s)")
  fi

  # ── 5. publish status the app can read ──────────────────────────────────────
  # The site should never look broken without explaining itself. This file is what the
  # in-app banner reads, so a judge sees "the keeper wallet is empty" rather than a dead page.
  mkdir -p web/public
  NP=${#problems[@]}
  python3 - "$age" "$bal" "$low" "$NP" ${problems[@]+"${problems[@]}"} ${repaired[@]+"${repaired[@]}"} <<'PY' > "$STATUS"
import json, sys, datetime
age, bal, low, np = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rest = [a for a in sys.argv[5:] if a]
problems, repaired = rest[:np], rest[np:]
print(json.dumps({
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "feedAgeSeconds": int(age or 0),
    "keeperBalanceMon": float(bal or 0),
    "lowGas": low == "1",
    "problems": problems,
    "repaired": repaired,
    "healthy": not problems,
}, indent=2))
PY

  if [ ${#problems[@]} -eq 0 ]; then
    log "ok · feed ${age}s · gas ${bal} MON${repaired:+ · ${repaired[*]}}"
  else
    log "DEGRADED · ${problems[*]}"
  fi
}

if [ "$ONCE" = "--once" ]; then
  pass
else
  log "supervising every ${INTERVAL}s — ctrl-c to stop"
  while :; do pass; sleep $INTERVAL; done
fi
