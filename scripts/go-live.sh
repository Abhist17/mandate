#!/usr/bin/env bash
#
# Take Mandate from local-only to a public URL on the real Monad testnet.
#
# Waits for the deployer wallet in .env to have gas, then: deploys, points the app at the
# public network, rebuilds, starts the keeper, and opens a public tunnel. Prints the URL.
#
#   ./scripts/go-live.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$HOME/.local/bin:$PATH"

LIVE_RPC=https://testnet-rpc.monad.xyz
LOGS=.local-logs; mkdir -p "$LOGS"
MIN_MON=1.5   # deploy is ~1.2 MON at 100 gwei; keep a margin for the keeper

g() { printf '\033[32m✓\033[0m %s\n' "$1"; }
i() { printf '\033[2m  %s\033[0m\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
pid_on_port() { ss -lptn "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

set -a; . ./.env; set +a
[ -n "${PRIVATE_KEY:-}" ] || die "PRIVATE_KEY is empty in .env"
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")

# ── 1. wait for gas ───────────────────────────────────────────────────────────
step "1. Deployer $DEPLOYER"
while :; do
  BAL=$(cast balance "$DEPLOYER" --rpc-url $LIVE_RPC --ether 2>/dev/null || echo 0)
  if python3 -c "import sys; sys.exit(0 if float('$BAL') >= $MIN_MON else 1)"; then
    g "$BAL MON — enough to deploy"; break
  fi
  printf '\r\033[2m  waiting for gas… balance %s MON (need %s). Send MON to %s\033[0m' "$BAL" "$MIN_MON" "$DEPLOYER"
  sleep 15
done

# ── 2. deploy ─────────────────────────────────────────────────────────────────
step "2. Deploy to Monad testnet"
( cd contracts && POOL_ASSET_ADDRESS= MONAD_TESTNET_RPC=$LIVE_RPC KEEPER_ADDRESS=$DEPLOYER \
    forge script script/Deploy.s.sol:Deploy --rpc-url $LIVE_RPC --broadcast --legacy \
    > "../$LOGS/deploy-live.log" 2>&1 ) || die "deploy failed — see $LOGS/deploy-live.log"

python3 - <<'PY'
import re
dep = open('DEPLOYMENT.md').read()
block = re.search(r'```\n(POOL_ASSET_ADDRESS=.*?)```', dep, re.S).group(1)
new = dict(l.split('=', 1) for l in block.strip().split('\n'))
new['MONAD_TESTNET_RPC'] = 'https://testnet-rpc.monad.xyz'
new['NEXT_PUBLIC_MONAD_RPC'] = 'https://testnet-rpc.monad.xyz'
lines = open('.env').read().split('\n'); out = []; seen = set()
for l in lines:
    k = l.split('=', 1)[0].strip()
    if k in new: out.append(f"{k}={new[k]}"); seen.add(k)
    else: out.append(l)
for k, v in new.items():
    if k not in seen: out.append(f"{k}={v}")
open('.env', 'w').write('\n'.join(out))
PY
set -a; . ./.env; set +a
g "registry $MANDATE_REGISTRY_ADDRESS"
i "https://testnet.monadscan.com/address/$MANDATE_REGISTRY_ADDRESS"

# ── 3. tune for live gas, first prices, seed ──────────────────────────────────
step "3. Tune, prices and seed"
# 60s staleness is a fork-era setting. See scripts/tune-live.sh.
# Three staleness bounds — oracle, venue, registry — and all three must be widened, or trades
# revert with StalePrice(.., 60) while the oracle reports the price as fresh. See tune-live.sh.
for m in 16 32 48; do
  cast send "$ORACLE_ADDRESS" "configureFeed(uint16,bool,uint64,uint16)" $m false 600 2500 \
    --private-key "$PRIVATE_KEY" --rpc-url $LIVE_RPC --legacy >/dev/null
done
cast send "$MINI_PERP_ADDRESS" "setMaxPriceAge(uint64)" 600 --private-key "$PRIVATE_KEY" --rpc-url $LIVE_RPC --legacy >/dev/null
cast send "$MANDATE_REGISTRY_ADDRESS" "setMaxMarkAge(uint64)" 600 --private-key "$PRIVATE_KEY" --rpc-url $LIVE_RPC --legacy >/dev/null
g "staleness bound 600s on oracle, venue and registry (keeper runs in demand mode)"
TS=$(cast block latest --field timestamp --rpc-url $LIVE_RPC)
curl -s --max-time 20 https://testnet.perpl.xyz/api/v1/pub/context > "$LOGS/perpl.json"
python3 - > "$LOGS/prices.txt" <<'PY'
import json
c = json.load(open('.local-logs/perpl.json'))
for m in c['markets']:
    if m['id'] in (16, 32, 48):
        print(m['id'], int(round(m['state']['orl'] / 10 ** m['config']['price_decimals'] * 1e8)), m['symbol'])
PY
while read -r id px sym; do
  cast send "$ORACLE_ADDRESS" "pushPrice(uint16,uint256,uint64)" "$id" "$px" "$TS" \
    --private-key "$PRIVATE_KEY" --rpc-url $LIVE_RPC --legacy >/dev/null
done < "$LOGS/prices.txt"
g "live Perpl prices on chain"

npx tsx scripts/seed-market.ts > "$LOGS/seed-market-live.log" 2>&1 && g "underwriting ladder posted" \
  || i "market seed skipped — see $LOGS/seed-market-live.log"
npx tsx scripts/seed.ts > "$LOGS/seed-live.log" 2>&1 && g "demo mandates seeded" \
  || i "mandate seed skipped — see $LOGS/seed-live.log"

# ── 4. web, pointed at the public network ─────────────────────────────────────
step "4. Web app"
wpid=$(pid_on_port 3000 || true); [ -n "${wpid:-}" ] && kill "$wpid" 2>/dev/null && sleep 2
( cd web && rm -rf .next && npx next build > "../$LOGS/web-build.log" 2>&1 ) || die "web build failed — see $LOGS/web-build.log"
( cd web && setsid nohup npx next start -p 3000 > "../$LOGS/web.log" 2>&1 < /dev/null & disown )
for _ in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:3000/ && break; sleep 1; done
g "http://localhost:3000 — now reading Monad testnet"

# ── 5. keeper ─────────────────────────────────────────────────────────────────
step "5. Keeper"
kpid=$(pgrep -f "tsx keeper/src/index.ts" | head -1 || true); [ -n "${kpid:-}" ] && kill "$kpid" 2>/dev/null
setsid nohup npx tsx keeper/src/index.ts > "$LOGS/keeper.log" 2>&1 < /dev/null & disown
g "marking every block on the real network"

# ── 6. public URL ─────────────────────────────────────────────────────────────
step "6. Public URL"
tpid=$(pgrep -f "cloudflared tunnel" | head -1 || true); [ -n "${tpid:-}" ] && kill "$tpid" 2>/dev/null
setsid nohup cloudflared tunnel --url http://127.0.0.1:3000 > "$LOGS/tunnel.log" 2>&1 < /dev/null & disown
URL=""
for _ in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" | head -1 || true)
  [ -n "$URL" ] && break; sleep 1
done
[ -n "$URL" ] && echo "$URL" > "$LOGS/public-url.txt"

cat <<EOF

$(printf '\033[1m\033[32mMandate is live on Monad testnet.\033[0m')

  Public URL   ${URL:-"(tunnel starting — tail $LOGS/tunnel.log)"}
  Registry     https://testnet.monadscan.com/address/$MANDATE_REGISTRY_ADDRESS
  Deployer     $DEPLOYER  ($(cast balance "$DEPLOYER" --rpc-url $LIVE_RPC --ether) MON left)

Anyone with MetaMask on Monad testnet can open that URL and use it.
The tunnel lives as long as this machine is up; \`./scripts/go-live.sh\` reopens it.
EOF
