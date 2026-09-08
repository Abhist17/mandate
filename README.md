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

## Status

Build in progress for **Monad Metropolis**, Onchain Finance & Trading track.
See [SPEC.md](SPEC.md) for the full build specification and phase plan.

- [x] Phase 0 — Scaffold
- [ ] Phase 1 — Perp venue gate
- [ ] Phase 2 — Core contracts
- [ ] Phase 3 — Tests (unit, invariant, fuzz)
- [ ] Phase 4 — Keeper
- [ ] Phase 5 — Frontend
- [ ] Phase 6 — Envio indexer
- [ ] Phase 7 — Deploy + seed
- [ ] Phase 8 — Demo

## Sponsor integrations

| Sponsor | What we built | Where |
|---|---|---|
| Perpl | Risk keeper as a production automation system | `keeper/` |
| Perpl | Trader + LP risk dashboards | `web/` |
| Envio | HyperIndex powering equity curves and fill history | `indexer/` |

## Known limitations

Stated honestly rather than hidden:

- **Share-price manipulation around allocation.** A trader could open a position
  immediately before an LP deposit or withdrawal. Mitigated with a withdrawal delay, not
  eliminated.
- **Adversarial fills.** Position caps and a per-block loss limit fire before meaningful
  size can move, and the venue is public so the counterparty isn't chosen. Mitigated, not
  solved.
- **Oracle dependence.** Equity marks are only as good as the price feed.

## License

MIT
