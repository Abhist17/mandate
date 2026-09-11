#!/usr/bin/env bash
#
# Bring the whole local stack up from nothing, idempotently.
#
# Exists because the pieces are background processes: a closed terminal, a reboot or a
# crashed session leaves the app reachable-looking but dead, and putting it back took eight
# commands in the right order with addresses copied between them. One command is the fix.
#
#   ./scripts/up.sh          bring everything up (reuses what is already running)
#   ./scripts/up.sh --fresh  tear down and rebuild from a clean chain
#
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.foundry/bin:$PATH"
FRESH=${1:-}
RPC=http://127.0.0.1:8546
LOGS=.local-logs
mkdir -p "$LOGS"

g() { printf '\033[32m✓\033[0m %s\n' "$1"; }
i() { printf '\033[2m  %s\033[0m\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

pid_on_port() { ss -lptn "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

# ── 0. optional teardown ──────────────────────────────────────────────────────
if [ "$FRESH" = "--fresh" ]; then
  step "Tearing down"
  for p in 8546 3000; do
    pid=$(pid_on_port $p || true)
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null && i "stopped :$p"
  done
  kpid=$(pgrep -f "tsx keeper/src/index.ts" | head -1 || true)
  [ -n "${kpid:-}" ] && kill "$kpid" 2>/dev/null && i "stopped keeper"
  sleep 2
fi

# ── 1. local chain ────────────────────────────────────────────────────────────
step "1. Local Monad fork"
if cast block-number --rpc-url $RPC >/dev/null 2>&1; then
  g "already running at block $(cast block-number --rpc-url $RPC)"
  CHAIN_WAS_UP=1
else
  setsid nohup anvil --fork-url https://testnet-rpc.monad.xyz --port 8546 --silent \
    > "$LOGS/anvil.log" 2>&1 < /dev/null &
  disown
  for _ in $(seq 1 60); do
    cast block-number --rpc-url $RPC >/dev/null 2>&1 && break
    sleep 1
  done
  cast block-number --rpc-url $RPC >/dev/null 2>&1 || die "anvil did not start — see $LOGS/anvil.log"
  g "forked Monad testnet at block $(cast block-number --rpc-url $RPC)"
  CHAIN_WAS_UP=0
fi

# ── 2. contracts ──────────────────────────────────────────────────────────────
step "2. Contracts"
set -a; . ./.env; set +a

REGISTRY_LIVE=0
if [ -n "${MANDATE_REGISTRY_ADDRESS:-}" ]; then
  code=$(cast code "$MANDATE_REGISTRY_ADDRESS" --rpc-url $RPC 2>/dev/null || echo 0x)
  [ "$code" != "0x" ] && REGISTRY_LIVE=1
fi

if [ "$REGISTRY_LIVE" = "1" ] && [ "$CHAIN_WAS_UP" = "1" ]; then
  g "already deployed at $MANDATE_REGISTRY_ADDRESS"
else
  i "deploying…"
  ( cd contracts && POOL_ASSET_ADDRESS= MONAD_TESTNET_RPC=$RPC \
      forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --broadcast --legacy \
      > "../$LOGS/deploy.log" 2>&1 ) || die "deploy failed — see $LOGS/deploy.log"

  python3 - <<'PY'
import re
dep = open('DEPLOYMENT.md').read()
block = re.search(r'```\n(POOL_ASSET_ADDRESS=.*?)```', dep, re.S).group(1)
new = dict(l.split('=', 1) for l in block.strip().split('\n'))
lines = open('.env').read().split('\n')
out, seen = [], set()
for l in lines:
    k = l.split('=', 1)[0].strip()
    if k in new:
        out.append(f"{k}={new[k]}"); seen.add(k)
    else:
        out.append(l)
for k, v in new.items():
    if k not in seen:
        out.append(f"{k}={v}")
open('.env', 'w').write('\n'.join(out))
PY
  set -a; . ./.env; set +a
  g "deployed · registry $MANDATE_REGISTRY_ADDRESS"
fi

# ── 3. prices ─────────────────────────────────────────────────────────────────
# Every trading path calls priceNoOlderThan, so a stale feed blocks everything with a
# StalePrice revert that looks like a bug and is not one.
step "3. Relay Perpl prices"
TS=$(cast block latest --field timestamp --rpc-url $RPC)
curl -s --max-time 20 https://testnet.perpl.xyz/api/v1/pub/context > "$LOGS/perpl.json" || true
if [ -s "$LOGS/perpl.json" ]; then
  python3 - > "$LOGS/prices.txt" <<'PY'
import json
c = json.load(open('.local-logs/perpl.json'))
for m in c['markets']:
    if m['id'] in (16, 32, 48):
        print(m['id'], int(round(m['state']['orl'] / 10 ** m['config']['price_decimals'] * 1e8)), m['symbol'])
PY
  while read -r id px sym; do
    cast send "$ORACLE_ADDRESS" "pushPrice(uint16,uint256,uint64)" "$id" "$px" "$TS" \
      --private-key "$KEEPER_PRIVATE_KEY" --rpc-url $RPC --legacy >/dev/null
    i "$sym \$$(python3 -c "print(f'{$px/1e8:,.2f}')")"
  done < "$LOGS/prices.txt"
  g "live Perpl prices on chain"
else
  die "could not reach Perpl — check your connection"
fi

# ── 4. seed ───────────────────────────────────────────────────────────────────
step "4. Seed"
ACTIVE=$(cast call "$MANDATE_REGISTRY_ADDRESS" "activeCount()(uint256)" --rpc-url $RPC 2>/dev/null || echo 0)
if [ "${ACTIVE:-0}" -gt 0 ]; then
  g "$ACTIVE mandates already live"
else
  npx tsx scripts/seed.ts > "$LOGS/seed.log" 2>&1 || die "seed failed — see $LOGS/seed.log"
  g "four mandates: healthy, near-floor, breached, flat"
fi

OFFERS=$(cast call "$UNDERWRITING_BOOK_ADDRESS" "offerCount()(uint256)" --rpc-url $RPC 2>/dev/null || echo 0)
if [ "${OFFERS:-0}" -gt 0 ]; then
  g "$OFFERS offers already on the book"
else
  npx tsx scripts/seed-market.ts > "$LOGS/seed-market.log" 2>&1 || die "market seed failed — see $LOGS/seed-market.log"
  g "underwriting ladder posted: \$25k/70% up to \$250k/92%"
fi

# ── 5. web ────────────────────────────────────────────────────────────────────
step "5. Web app"
wpid=$(pid_on_port 3000 || true)
[ -n "${wpid:-}" ] && kill "$wpid" 2>/dev/null && sleep 2
# Contract addresses are baked in at build time, so a redeploy needs a rebuild.
( cd web && rm -rf .next && npx next build > "../$LOGS/web-build.log" 2>&1 ) \
  || die "web build failed — see $LOGS/web-build.log"
( cd web && setsid nohup npx next start -p 3000 > "../$LOGS/web.log" 2>&1 < /dev/null & disown )
for _ in $(seq 1 40); do
  curl -sf -o /dev/null http://127.0.0.1:3000/ && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:3000/ || die "web did not start — see $LOGS/web.log"
g "http://localhost:3000"

# ── 6. keeper ─────────────────────────────────────────────────────────────────
step "6. Keeper"
kpid=$(pgrep -f "tsx keeper/src/index.ts" | head -1 || true)
[ -n "${kpid:-}" ] && kill "$kpid" 2>/dev/null && sleep 1
setsid nohup npx tsx keeper/src/index.ts > "$LOGS/keeper.log" 2>&1 < /dev/null &
disown
sleep 6
grep -q "marked" "$LOGS/keeper.log" && g "marking every block" || i "starting… (tail $LOGS/keeper.log)"

# ── done ──────────────────────────────────────────────────────────────────────
cat <<EOF

$(printf '\033[1mMandate is up.\033[0m')

  App        http://localhost:3000
  Chain      $RPC  (chain id 10143)
  Registry   $MANDATE_REGISTRY_ADDRESS
  Logs       $LOGS/

$(printf '\033[2mWallet setup — the local fork reports the SAME chain id as real Monad testnet,
  so MetaMask cannot tell them apart. Add it as its own network:
    Name: Mandate Local   RPC: http://127.0.0.1:8546   Chain ID: 10143   Symbol: MON
  then switch to it. Import this key for 10,000 test MON:
    0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\033[0m')

  Stop everything:  ./scripts/down.sh
EOF
