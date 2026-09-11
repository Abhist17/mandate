#!/usr/bin/env bash
# One-time tuning of the live deployment for public-testnet gas economics.
#
# The oracle's 60s staleness bound is right for a keeper that marks every block for free. On
# the public network at ~100 gwei that keeper drains a wallet in minutes, so it runs in
# demand mode and refreshes prices every ~8 minutes. The bound has to be wider than that or
# every trade reverts with StalePrice between refreshes. 10 minutes: still tight enough that
# a dead keeper halts trading rather than marking against a stale price.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . ./.env; set +a
RPC=https://testnet-rpc.monad.xyz

for m in 16 32 48; do
  cast send "$ORACLE_ADDRESS" "configureFeed(uint16,bool,uint64,uint16)" $m false 600 2500 \
    --private-key "$PRIVATE_KEY" --rpc-url $RPC --legacy >/dev/null && echo "market $m: staleness bound -> 600s"
done

# Kick a fresh price in immediately so trading unblocks now rather than on the keeper's first tick.
TS=$(cast block latest --field timestamp --rpc-url $RPC)
curl -s --max-time 20 https://testnet.perpl.xyz/api/v1/pub/context | python3 -c "
import sys,json
c=json.load(sys.stdin)
for m in c['markets']:
    if m['id'] in (16,32,48):
        print(m['id'], int(round(m['state']['orl']/10**m['config']['price_decimals']*1e8)))
" | while read -r id px; do
  cast send "$ORACLE_ADDRESS" "pushPrice(uint16,uint256,uint64)" "$id" "$px" "$TS" \
    --private-key "$PRIVATE_KEY" --rpc-url $RPC --legacy >/dev/null && echo "market $id: fresh price pushed"
done
echo "done — restart the keeper: make keeper"
