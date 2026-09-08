# Research findings — competitive landscape, domain rules, and stack corrections

**Date:** 2026-09-09
**Purpose:** Establish what is actually true before building further. Three of these findings
change the product; one of them contradicts a claim we were already making.

---

## 1. ⚠️ The onchain prop firm category already exists

**This is the finding that matters most, and it invalidates our previous positioning.**

The category is roughly six months old and has real, funded competitors:

| Firm | Backing | Notes |
|---|---|---|
| **Propr.xyz** | XBorg, backed by SwissBorg | Live early 2026. Up to $100K, 80/20 split, perps + prediction markets. Open-sourced their A/B booking classifier. |
| **Hypernova** | — | Public 14 Aug 2026. Smart-contract payouts averaging ~6.2s. Payout reserve queryable on Arbitrum. |
| **Vanta Trading** | Taoshi (Bittensor subnet) | Feb 2026. Hyperliquid infrastructure. Up to 100% profit splits. |
| GT Funded, Carrot Funding, Solana Funded, Foxify | — | Various splits, 80–92%. |

Any claim that "this market doesn't exist yet" is false and a judge who follows the space will
know it immediately. We do not make that claim.

### What they actually put onchain

This is the important part, and it is narrower than the marketing suggests:

- ✅ **Rule definitions** — "drawdown limits, profit targets, and breach conditions are coded
  and immutable"
- ✅ **Payout settlement** — USDC onchain, reserves queryable on a block explorer
- ❌ **Breach detection and enforcement** — not documented as onchain for any of them. Per
  DeFiPrime's survey, "the actual computational layer that detects and enforces breaches
  appears to remain a black box."

DeFiPrime's own summary of the state of the art:

> "Disclosing the engine in plain language is a real step past MyForexFunds, but *'trust our
> classifier' is not the same as 'verify.'*"

### Where that leaves Mandate

The wedge is specific, technical, and true:

> The category has made the **rules** onchain and the **payout** onchain. The **risk engine
> that decides whether you breached** is still a private server. Mandate puts the enforcement
> loop itself onchain and makes it permissionless — anyone can call `markAndEnforce`, and the
> verdict is arithmetic anybody can re-run.

This also sharpens why Monad specifically: an enforcement loop that must mark every open
account every block is *only affordable* at 400ms blocks and sub-cent gas. That is not a
"faster is better" claim — it is the reason nobody else has done the enforcement layer.

**Positioning consequence:** we are not first to onchain prop firms. We are first to onchain
*enforcement*. Say that, with the competitors named, and it reads as market knowledge instead
of naivety.

---

## 2. Real prop firm rules we had not modelled

Sourced from FundingPips' published 2026 rulebook (the firm the founder trades with).

### 2.1 The consistency rule — the actual payout-denial mechanism

```
Consistency Score = (Biggest Winning Day / Total Account Profit) × 100%
```

| Model | Threshold | When checked |
|---|---|---|
| FundingPips Zero | ≤ 15% | Every reward request |
| 2 Step Standard (On Demand) | ≤ 35% | Every reward request |
| 2 Step Flex, 1 Step Flex, 2 Step Pro | none | — |

Breaking it is a **soft breach**: the account stays open, but the payout is blocked until the
score improves.

**Why this is the single most important thing we were missing.** Our product enforces *risk
limits* and then pays out unconditionally. Real firms rarely deny a payout by disputing a
drawdown — that number is unambiguous. They deny it on the consistency rule, because it is
computed on their server from their trade records, and the trader cannot check the arithmetic.
It is precisely the "somebody's decision" the pitch is about, and we had modelled the easy
half of the problem.

Encoding it makes the thesis complete: *the conditions on the payout are as verifiable as the
conditions on the risk.*

### 2.2 Other mechanics we get wrong or omit

| Rule | Reality | Our implementation |
|---|---|---|
| **Drawdown type** | Most models use **static** drawdown — floor fixed at account opening, never moves with profit | We only implement trailing |
| **Trailing lock** | Zero's trailing floor stops trailing and **locks permanently** once equity reaches 5% above the starting balance | We trail forever |
| **Daily limit basis** | `max(opening balance, opening equity for that day)` — whichever is **higher** | We use day-start equity only |
| **Breach sensitivity** | "Touch-sensitive" — touching the limit closes the account | We use strict `<` (at the floor survives) |
| **Daily reset** | 00:00 Platform Time (UTC+3), not UTC midnight | We parameterise the reset hour ✅ |
| **Minimum profitable days** | Zero: ≥7 profitable days in a rolling 30-day window before payout | Not modelled |
| **Safety cushion** | Zero: 3% cushion above the floor required at payout | Not modelled |
| **Loss/win symmetry** | Zero: biggest losing trade ≤ biggest winning trade at payout | Not modelled |
| **Profit target** | 1 Step 12%, 2 Step 8%+5%, Pro 6%+6% | Not modelled (we are instant-funded, like Zero) |

Split/frequency structure is also informative: the split *rises* with payout patience —
Weekly 60%, Bi-Weekly 80%, On Demand 90%, Monthly 100%. That is a real product lever we could
expose but do not need to.

### 2.3 What to implement, in priority order

1. **Consistency rule** as an encoded, checkable payout condition — highest value, directly
   completes the thesis
2. **Static drawdown mode** and the **trailing lock** — a mandate should be able to express the
   models that actually exist
3. **Daily floor basis** as `max(dayStartBalance, dayStartEquity)`
4. **Minimum profitable days** and **safety cushion** as payout conditions
5. Touch-sensitivity as a per-mandate flag rather than a hardcoded convention

---

## 3. Stack corrections

### 3.1 Envio HyperIndex — our integration is written for the wrong major version

`envio` is at **3.10.0** (3.11.0 published). Our `indexer/` was written against V2 and will not
run.

| | V2 (what we wrote) | V3 (current) |
|---|---|---|
| Networks | `networks:` | `chains:` |
| Handler registration | `Contract.Event.handler(...)` | `indexer.onEvent({contract, event}, ...)` |
| Entity writes | `context.Entity.set(...)` | `context.chain.Entity.set(...)` |
| Handler location | explicit `handler:` path | auto-discovered in `src/handlers/` |
| Reorg config | `confirmed_block_threshold` | `max_reorg_depth` |
| RPC | `rpc_config` (one URL) | `rpc` (list, with `for: sync\|realtime\|fallback`) |

Our `package.json` also pinned `^2.10.0`. All of this must be migrated.

### 3.2 Monad testnet IS supported by Envio HyperSync ✅

Verified live:

```bash
curl -s https://monad-testnet.hypersync.xyz/height
# -> {"height":60862673}   (matches chain head)
```

So the integration is viable — it was only ever a version problem.

---

## 4. Consolidated action list

| # | Action | Judging impact |
|---|---|---|
| 1 | Rewrite positioning: name the competitors, claim onchain *enforcement*, not onchain prop firms | Founder & Market Readiness (25%), Originality (15%) |
| 2 | Implement the consistency rule as an encoded payout condition | Originality (15%), Technical (20%), and it is the pitch |
| 3 | Add static drawdown, trailing lock, correct daily basis | Technical (20%), domain credibility |
| 4 | Add payout conditions: min profitable days, safety cushion | Originality, completeness |
| 5 | Migrate the indexer to Envio V3 | Envio bounty — currently broken |
| 6 | Preset mandate templates matching real models (Zero, 1-Step, 2-Step) | Design & Craft (20%), legibility |

---

## Sources

- [DeFiPrime — Onchain Prop Firms](https://defiprime.com/onchain-prop-firms)
- [OnchainProps comparison](https://onchainprops.xyz/compare.html)
- [FundingPips rules 2026 — PropTradingVibes](https://proptradingvibes.com/blog/fundingpips-rules)
- [Envio HyperIndex configuration file](https://docs.envio.dev/docs/HyperIndex/configuration-file)
- [Envio — migrate to V3](https://docs.envio.dev/docs/HyperIndex/migrate-to-v3)
