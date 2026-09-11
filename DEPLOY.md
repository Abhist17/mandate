# Deploying Mandate

Everything here targets **Monad testnet (chain 10143)**. Nothing touches mainnet.

---

## Running it locally — one command

```bash
make up          # chain, contracts, prices, seed, web, keeper — from nothing
make down        # stop everything
make up-fresh    # tear down and rebuild from a clean chain
```

`make up` is idempotent: run it again and it reuses whatever is already running. The pieces
are background processes, so a closed terminal, a reboot or a crashed session leaves the app
looking reachable but dead — this is the fix. Logs land in `.local-logs/`.

It prints the wallet setup at the end. Read that part: the local fork reports the **same
chain id as real Monad testnet**, so MetaMask cannot tell them apart and must be given the
fork as its own network.

## For judges — fastest path in

If a live deployment is running, the addresses and a funded test wallet are in
[`DEPLOYMENT.md`](DEPLOYMENT.md) (written by the deploy script) and on the submission page.

To see the product working from a clean clone, in about five minutes:

```bash
git clone https://github.com/Abhist17/mandate && cd mandate
cp .env.example .env          # fill in PRIVATE_KEY with a funded testnet key
make install
make deploy-testnet           # prints every address
# paste the printed addresses into .env
make seed                     # four mandates in different states
make web                      # http://localhost:3000
```

Then, in a second terminal, the thing worth watching:

```bash
make demo                     # healthy mandate -> adverse move -> breach -> flatten
```

It prints a transaction hash. That transaction is the whole product.

---

## Prerequisites

| Tool | Why |
|---|---|
| [Foundry](https://getfoundry.sh) | contracts, tests, deploy script |
| Node 20+ | keeper, scripts, frontend |
| Testnet MON | gas. Faucet: https://faucet.monad.xyz |

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
make install
```

---

## 1. Configure

```bash
cp .env.example .env
```

Fill in at minimum:

```bash
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz
PRIVATE_KEY=0x…          # deployer, needs testnet MON
KEEPER_PRIVATE_KEY=0x…   # can be the same key for a demo; separate in anything real
KEEPER_ADDRESS=0x…       # address of KEEPER_PRIVATE_KEY
```

The values already filled in — the Perpl endpoints and the Pyth address — were verified live
during Phase 1 and are recorded in [`docs/PHASE1-FINDINGS.md`](docs/PHASE1-FINDINGS.md).

## 2. Test before deploying

```bash
make test        # 193 tests
make coverage    # RiskEngine 100%, MandateRegistry 100%, 95.52% across src/
```

## 3. Deploy

```bash
make deploy-testnet
```

Deploys, wires and seeds in one transaction batch:

- `PriceOracle` — publisher set to `KEEPER_ADDRESS`, 60s staleness bound, 25% deviation guard,
  Pyth wired at `0x2880aB155794e7179c9eE2e38200202908C17B43`
- `MiniPerp` — BTC/ETH/SOL listed with Perpl's live market parameters, 2M reserve funded
- `MandateAccount` implementation (cloned per mandate)
- `MandateRegistry` — pool wired, keeper granted issuer rights
- `CapitalPool` — 5M seeded as LP capital

Copy the printed addresses into `.env`:

```
POOL_ASSET_ADDRESS=…
ORACLE_ADDRESS=…
MINI_PERP_ADDRESS=…
MANDATE_ACCOUNT_IMPL_ADDRESS=…
MANDATE_REGISTRY_ADDRESS=…
CAPITAL_POOL_ADDRESS=…
```

Also set `INDEXER_START_BLOCK` to the deployment block — indexing Monad testnet from block 0
is slow and pointless.

### Verification

Monad testnet verifies through Sourcify:

```bash
cd contracts
forge verify-contract <ADDRESS> src/MandateRegistry.sol:MandateRegistry \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org \
  --chain-id 10143
```

## 4. Start the keeper

```bash
make keeper
```

It relays Perpl's live oracle prices onchain and marks every Active mandate each block,
logging gas as it goes.

**The keeper is a convenience, not a trust assumption.** `markAndEnforce` is permissionless.
To prove that rather than assert it, kill the keeper and run:

```bash
cast send $MANDATE_REGISTRY_ADDRESS "markAndEnforce(uint256)" 1 \
  --private-key <ANY_KEY> --rpc-url $MONAD_TESTNET_RPC --legacy
```

Any address works. That is the point of the design.

## 5. Open claims to testers

`DemoIssuer` is deployed and granted the issuer role automatically, so anyone can claim one
mandate per address on fixed terms — no approval step, no queue, no DM. This is the whole
tester funnel; without it every allocation goes through you.

```bash
# Adjust the terms testers get
cast send $DEMO_ISSUER_ADDRESS "setTerms(uint256,uint16,uint16,uint16,uint16,uint64,uint8)" \
  100000000000 1000 500 8000 30000 604800 0 \
  --private-key $PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC --legacy

# Cap total exposure
cast send $DEMO_ISSUER_ADDRESS "setMaxClaims(uint256)" 100 \
  --private-key $PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC --legacy

# Let a tester who breached have another go
cast send $DEMO_ISSUER_ADDRESS "resetClaim(address)" <TESTER> \
  --private-key $PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC --legacy

# Kill switch — stops all claims, touches nothing already issued
cast send $MANDATE_REGISTRY_ADDRESS "setIssuer(address,bool)" $DEMO_ISSUER_ADDRESS false \
  --private-key $PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC --legacy
```

Make sure the pool has capital: each claim allocates from it, and allocations are capped at
20% of pool assets each.

## 6. Seed

```bash
make seed
```

Issues four mandates — healthy, near-floor, breached, flat — and prints their trader keys so
you can trade any of them from the UI.

## 7. Indexer

```bash
cd indexer && npm install && npm run dev
```

Then set `NEXT_PUBLIC_ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql` and restart the web
dev server.

Without it the equity curve degrades to a recent-only window, because Monad's public RPC caps
`eth_getLogs` at a 100-block range — about forty seconds of history. The chart says which
source it is using.

## 8. Frontend

```bash
make web       # http://localhost:3000
```

Two views: **Trader** (equity curve with the drawdown floor beneath it, distance-to-floor,
terms, trade panel) and **Liquidity** (TVL, utilisation, per-mandate headroom, history).

The frontend reads addresses from `.env` at build time, so restart the dev server after
changing them.

---

## Deployment defaults

Per SPEC §7:

| Parameter | Value |
|---|---|
| Max drawdown | 10% trailing from the high-water mark |
| Daily loss limit | 5% from day-start equity |
| Profit split | 80% trader / 20% pool |
| Position cap | 3x allocation |
| Daily reset | 00:00 UTC (per-mandate parameter) |
| Pre-trade adverse buffer | 2% of new notional |
| Oracle staleness bound | 60s |
| Max allocation per mandate | 20% of pool assets |
| Withdrawal delay | 60s |

## Markets

Ids and parameters mirror Perpl's live Monad testnet configuration:

| Market | Id | Initial margin | Maintenance | Taker fee | Funding interval |
|---|---|---|---|---|---|
| BTC | 16 | 15% | 7.5% | 0.069% | 2580s |
| ETH | 32 | 12% | 6% | 0.069% | 2580s |
| SOL | 48 | 10% | 5% | 0.069% | 2580s |

## ⚠️ A local fork shares Monad testnet's chain id

`anvil --fork-url https://testnet-rpc.monad.xyz` reports **chain id 10143 — the same as the
real network**. A wallet cannot tell the two apart, so "you're on the right network" checks
pass while transactions go to whichever one the wallet is actually pointed at.

The failure is quiet and it costs the user money: a call to an address that has no code on
that network **succeeds**, burns ~21k gas, and does nothing. The app then shows a bare
failure with no explanation.

Two defences, both in place:

- `NetworkGuard` in the app checks for *code at the registry address* rather than trusting the
  chain id, and blocks the UI with an explanation if it isn't there.
- Run a local fork on its own chain id when testing with a real wallet:

  ```bash
  anvil --fork-url https://testnet-rpc.monad.xyz --chain-id 31337 --port 8546
  ```

  Then add that as a custom network in the wallet. The wallet can now tell them apart.

## Troubleshooting

**`StalePrice`** — the oracle feed is older than 60s. Start the keeper, or push manually:

```bash
cast send $ORACLE_ADDRESS "pushPrice(uint16,uint256,uint64)" 16 <PRICE_1E8> \
  $(cast block latest --field timestamp --rpc-url $MONAD_TESTNET_RPC) \
  --private-key $KEEPER_PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC --legacy
```

Note the timestamp comes from the chain, not `date +%s`: `PriceOracle` rejects a `publishedAt`
in the future, and a node's clock can lag wall clock.

**`InvalidPrice`** — the same thing, from the other direction. Use the chain's timestamp.

**`InsufficientVenueLiquidity`** — the venue reserve cannot cover a winning position. MiniPerp
has no order book and so no natural counterparty; top it up with
`MiniPerp.fundReserve(amount)` (permissionless).

**Empty equity curve** — no indexer, and the mandate's marks are older than the RPC's
100-block window. Start the indexer.

**`AllocationCapExceeded`** — the requested allocation exceeds 20% of pool assets. Deposit
more, or issue a smaller mandate.

**A transaction "succeeds" but nothing happens** — you are almost certainly pointed at a
different network from the one the contracts are on. See the chain-id note above. Check with:

```bash
cast code $MANDATE_REGISTRY_ADDRESS --rpc-url <the rpc your wallet uses>
```

An empty `0x` means there is no contract there.
