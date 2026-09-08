<div align="center">

# Mandate

### The rules are the contract.

**An onchain prop firm on Monad.** LPs deposit capital. Traders receive a *mandate* — an
allocation with encoded terms. A keeper marks equity every block. Breach the drawdown and
the contract flattens the position and revokes the mandate in the same block.

No payout desk. No discretion. No "we reviewed your trading and found a violation" email.

[Architecture](#architecture) · [Why Monad](#why-this-needs-monad) · [Quickstart](#quickstart) · [Sponsors](#sponsor-integrations)

</div>

---

## The problem

Prop firms hand traders capital under a rulebook: max drawdown, daily loss limit, position
cap, profit split. Every one of those rules lives in a PDF, and every one is enforced by a
private server you have to trust. When the risk engine says you breached, you breached.
When the payout desk says no, it's no.

I trade a funded account. I blew two before this one. The rules were a PDF, the risk
engine was a black box, and the payout was somebody's decision.

## What Mandate does

A **mandate** is an allocation of pooled capital plus enforceable constraints on how it's
used, legible to both sides before either commits:

| Term | Meaning |
|---|---|
| `allocation` | Capital granted to the trader |
| `maxDrawdownBps` | Trailing drawdown from the equity high-water mark |
| `dailyLossBps` | Loss limit from day-start equity, reset at a configurable hour |
| `maxPositionBps` | Notional cap as a multiple of allocation |
| `profitSplitBps` | Trader's share of profit at settlement |
| `expiry` | Mandate deadline |

Every one of those is checked onchain — pre-trade, and again on every block mark.

## Why this needs Monad

The product is a continuous risk loop: mark every open mandate against live prices,
recompute trailing equity peaks, enforce. On a 12-second chain at real gas prices,
monitoring a few hundred accounts costs more than the fees earn — which is exactly why
every existing prop firm runs its risk engine on a private server you have to trust.

At 400ms blocks and sub-cent gas, trust-minimised enforcement becomes affordable for the
first time. The claim is not "Monad is faster so it's better." It's that **the enforcement
loop is only economically viable at this block time and gas cost.**

## `enforce()` is permissionless

Anyone can call it — any LP, any observer, any competing trader. The keeper is a
convenience, not a trust assumption. That's the property that distinguishes this from a
prop firm's private server.

## Architecture

```
LP deposits ──► CapitalPool ──► allocates ──► MandateAccount (one per mandate)
                    ▲                              │
                    │                              ▼
              profit split                    perp venue
                    │                              │
                    └────── RiskEngine ◄───────────┘
                                 ▲
                          Keeper (every block)
```

| Component | Path | Role |
|---|---|---|
| `RiskEngine` | `contracts/src/` | Pure drawdown/daily-loss/settlement maths |
| `MandateAccount` | `contracts/src/` | Per-mandate clone, pre-trade constraint checks |
| `MandateRegistry` | `contracts/src/` | Issuance, state, permissionless `markAndEnforce` |
| `CapitalPool` | `contracts/src/` | ERC-4626-style LP vault, allocation + settlement |
| Keeper | `keeper/` | Block subscriber, batched marks, gas accounting |
| Indexer | `indexer/` | Envio HyperIndex — equity curves, fill history |
| Frontend | `web/` | Trader view (equity curve + floor), LP view |

## Quickstart

```bash
cp .env.example .env      # fill in PRIVATE_KEY and RPC
make install
make build
make test
```

Deploy and drive the demo:

```bash
make deploy-testnet
make seed
make demo                 # healthy mandate -> adverse move -> breach -> flatten
```

## The number that makes the argument

A mark costs **106,718 gas — about 0.00011 MON**, measured, not estimated
(`keeper/data/marks.json` records every one). Marks are batched, so a per-block risk loop over
hundreds of accounts is affordable.

That is the entire case for building this on Monad, and it is a narrow claim on purpose: not
"Monad is fast so it's better," but *this specific enforcement loop is only economically
viable at this block time and gas cost.* On a 12-second chain at real gas prices, marking a
few hundred accounts every block costs more than the fees earn — which is exactly why every
incumbent prop firm runs its risk engine on a private server you have to trust.

## Status

Built for **Monad Metropolis**, Onchain Finance & Trading track.
See [SPEC.md](SPEC.md) for the build specification.

- [x] Phase 0 — Scaffold
- [x] Phase 1 — Venue gate resolved ([findings](docs/PHASE1-FINDINGS.md))
- [x] Phase 2 — Core contracts
- [x] Phase 3 — 178 tests, 10 invariants, fuzz
- [x] Phase 4 — Keeper
- [x] Phase 5 — Trader + LP frontend
- [x] Phase 6 — Envio indexer
- [x] Phase 7 — Deploy + seed
- [x] Phase 8 — Live breach demo

```
forge test    178 passed, 0 failed
coverage      RiskEngine 100% · MandateRegistry 100% · total 92.75% lines
```

## Sponsor integrations

Three, all load-bearing. No checkbox integrations.

| Sponsor | What it does here | Where | Why it is not decorative |
|---|---|---|---|
| **Perpl** — API / automation | The risk keeper is a production automation system built on Perpl's public API: runtime market discovery, live oracle relay, batched enforcement, reconnect and backoff. | [`keeper/src/index.ts`](keeper/src/index.ts), [`keeper/src/perpl.ts`](keeper/src/perpl.ts) | Mandates are marked, and breaches triggered, against Perpl's real oracle prices. Cut the feed and enforcement stops. |
| **Perpl** — Analytics / risk tool | Trader and LP risk dashboards over that feed: equity vs floor, distance-to-floor per block, per-mandate headroom for LPs. | [`web/`](web/) | It is the product surface, not a readout bolted on. |
| **Envio** — HyperIndex | Indexes the enforcement loop and serves the equity curve over GraphQL. | [`indexer/`](indexer/) | Monad's public RPC caps `eth_getLogs` at **100 blocks** — 40 seconds of history. The core trader screen is not buildable without an indexer. |

### A note on Perpl

Perpl **is** live on Monad testnet and we verified it end to end
([`scripts/spike-perpl.ts`](scripts/spike-perpl.ts) reproduces every claim). It is not the
settlement venue, and the reason is worth stating plainly rather than hiding:

Perpl authenticates with Ed25519 key pairs and places orders over an authenticated WebSocket.
It does not support EIP-1271 contract signatures. **A smart contract cannot close a Perpl
position.** Mandate's whole claim is that *the contract* flattens a breached position and
anyone can trigger it — routing that through an off-chain keyholder would rebuild the trusted
private risk server this project exists to remove.

So settlement happens in [`MiniPerp.sol`](contracts/src/venue/MiniPerp.sol), which mirrors
Perpl's live market configuration (same market ids, margin, 0.069% taker fee, 2580s funding
interval) and marks against Perpl's own oracle. Full reasoning in
[`docs/PHASE1-FINDINGS.md`](docs/PHASE1-FINDINGS.md).

## Testing

```bash
make test        # 178 tests
make coverage    # RiskEngine 100% lines, MandateRegistry 100% lines
```

The boundary cases are the point. A drawdown rule that fires one wei early confiscates an
account for nothing; one that fires late is a rule the pool cannot rely on. So the floor
comparison is asserted at exactly ±1 wei on both sides.

Ten invariants hold across ~16,000 random calls — no Active mandate below its floor at its
last mark, high-water marks are peaks, the registry never holds assets between transactions,
every asset unit is accounted for across all participants, settlement legs sum to the equity
that came back.

Two of those invariants are interesting for what they *rejected*. The position cap was first
written as a state invariant on mark-priced notional; the fuzzer broke it with two consecutive
up-moves, correctly — a position that grew because the trade went the trader's way is not a
violation. Rewritten against entry-priced notional, the fuzzer broke it again by adding to a
position after a price fall, also correctly. The cap constrains *orders*, not positions. Both
rejected versions are documented in
[`test/invariant/Mandate.invariant.t.sol`](contracts/test/invariant/Mandate.invariant.t.sol),
because the cap means something more specific than it first appears.

## Known limitations

Stated because a judge will find them anyway, and volunteering the weak case with a number
attached is most of the gap between third place and first.

- **A trader could dump the pool's capital into a deliberately losing trade.** Position caps,
  a per-block loss limit that fires before meaningful size can move, and a venue where the
  counterparty is not chosen. **Mitigated, not solved.**
- **Share price trails the market by one mark.** `totalAssets()` counts mandate equity at its
  last marked value. At 400ms blocks the window is small, but it is not zero. The withdrawal
  delay plus claim-time pricing is what stops it being farmed.
- **Breach losses socialise across LPs** pro rata. The 20% per-mandate allocation cap is what
  bounds them.
- **MiniPerp's solvency is an assumption, not a market outcome.** It has no order book and so
  no natural counterparty; winning positions are paid from a reserve. That is a property of a
  test venue, not of the risk engine.
- **Oracle dependence.** Equity marks are only as good as the price feed. Every settlement
  path calls `priceNoOlderThan`, and the deviation guard that protects against a compromised
  publisher can also stall marking in a genuine gap. Both directions are documented in
  [`PriceOracle.sol`](contracts/src/oracle/PriceOracle.sol).

## Answers to the obvious questions

**"Why can't a prop firm just do this off-chain?"**
They do — that is the entire status quo, and it requires trusting their server. The claim is
not that enforcement is novel; it is that *verifiable* enforcement just became affordable.

**"What if the keeper goes down?"**
`markAndEnforce` is permissionless. Any LP, any observer, any competing trader can call it.
[`DEPLOY.md`](DEPLOY.md) has the command to prove it rather than assert it.

**"Isn't this just a vault with extra steps?"**
A vault allocates capital. A mandate allocates capital *plus enforceable constraints on how it
is used*, legible to both sides before either commits. That is the primitive.

## License

MIT
