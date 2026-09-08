# Mandate — Build Specification

> **How to use this file**
> Claude Code reads it for context on every session.
> Work one phase at a time. Complete a phase, commit, then move to the next.

---

## 0. What we're building

**Mandate** — an onchain prop firm. *"The rules are the contract."*

LPs deposit capital into a pool. Traders receive a **mandate**: an allocation of that
capital with encoded terms — max drawdown, daily loss limit, position cap, profit split,
expiry. The trader trades perps with it. A keeper marks their equity **every block**.
Breach the drawdown and the contract flattens the position and revokes the mandate in
the same block. Profit split executes automatically on close.

No payout desk. No discretion. No "we reviewed your trading and found a violation" email.

### Why this needs Monad

The product is a continuous risk loop: mark every open mandate against live prices,
recompute trailing equity peaks, enforce. On a 12-second chain at real gas prices,
monitoring a few hundred accounts costs more than the fees earn — which is exactly why
every existing prop firm runs its risk engine on a private server you have to trust. At
400ms blocks and sub-cent gas, trust-minimised enforcement becomes affordable for the
first time.

Do **not** claim "Monad is faster so it's better." The argument is specifically: *the
enforcement loop is only economically viable at this block time and gas cost.*

### Hackathon context

- **Event:** Monad Metropolis
- **Track:** Onchain Finance & Trading ($30k, split 3 ways — $10k each)
- **Deadline:** Oct 14 2026, 09:29 GMT+5:30
- **Deploy target:** Monad **testnet** (explicitly allowed — do not use mainnet)
- **Team:** solo

### Judging weights — build against these, not against your instincts

| Weight | Criterion | What it means here |
|---|---|---|
| 25% | Founder & Market Readiness | Name the exact first user. Say why this market doesn't exist yet. |
| 20% | Traction | ~15 real testers running mandates on testnet. Evidence, screenshots, quotes. |
| 20% | Technical Execution | Real settlement and enforcement onchain. Not a UI over static data. |
| 20% | Design & Craft | "An interface a trader would actually trust with capital." |
| 15% | Originality | A new market structure, not a faster clone. |

**Technical execution is only 20%.** Most teams will spend all five weeks on code and get
gutted on the 45% that is founder-readiness plus traction. Budget accordingly.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Contracts | Solidity + **Foundry** | Forge tests, including invariant tests |
| Chain | Monad testnet | Faucet MON, zero cost |
| Perp venue | **Perpl** | See §2 — verify testnet availability FIRST |
| Prices | Oracle on Monad testnet | Pyth or Chainlink, whichever is live |
| Keeper | TypeScript + viem | Long-running block subscriber |
| Indexer | **Envio HyperIndex** | Powers equity curves + fill history |
| Accounts | **Mera** (passkey) | Per-mandate derived signing keys |
| Frontend | Next.js + Tailwind + Recharts | Two views: trader, LP |

### Sponsor bounties this stacks (tag at submission)

- **Perpl — API / automation** ($5,000) — the risk keeper is a production automation system
- **Perpl — Analytics / Risk Tool** ($3,000) — the dashboards
- **Envio** ($1,000) — HyperIndex driving a core feature
- **Chainlink CRE** ($3,000) — *only if ahead of schedule*
- **Community bounty** ($5,000) — just select the campus group in the hackathon profile

Three load-bearing integrations. Do not checkbox-integrate more; judges can smell it.

---

## 2. CRITICAL UNKNOWNS — verify before writing any contract

Treat every line as a claim to check against live documentation, not as fact.

1. **Does Perpl support Monad testnet?** ← blocking, resolve in week 1
2. Perpl's actual API surface — order placement, position queries, programmatic auth
3. Which oracle is live on Monad testnet and its feed addresses
4. Monad's P256 precompile address (needed only if Mera integration goes deep)
5. Envio HyperIndex setup for Monad testnet
6. Mera SDK surface for PRF-derived keys
7. Whether Metropolis allows shared code across two submissions

**If Perpl is mainnet-only:** fall back to `MiniPerp.sol` — a minimal internal perp
venue: single market, oracle-priced, linear funding, isolated margin, no order book.
More work, but every other component stays identical. Do not let this block the build.

---

## 3. Architecture

```
LP deposits ──► CapitalPool ──► allocates ──► MandateAccount (one per mandate)
                    ▲                              │
                    │                              ▼
              profit split                    Perpl (perps)
                    │                              │
                    └────── RiskEngine ◄───────────┘
                                 ▲
                          Keeper (every block)
```

### 3.1 `CapitalPool.sol`

ERC-4626-style vault.

- LPs deposit the pool asset (USDC or AUSD — whichever is live on testnet), receive shares
- `totalAssets() = idleBalance + Σ(allocated capital) + Σ(unrealised mandate PnL)`
- Withdrawals only from idle balance; allocated capital is locked until mandate close
- Receives the LP share of profit on mandate settlement
- Absorbs losses on mandate breach (capped at allocation — that's the point of the cap)

**Watch:** share price must not be manipulable by a trader opening a position immediately
before an LP deposit or withdrawal. Simplest defence for a hackathon: withdrawal request
queue with a one-block (or short) delay. Document the limitation honestly rather than
pretending it's solved.

### 3.2 `MandateRegistry.sol`

Issues and tracks mandates.

```solidity
struct Terms {
    uint256 allocation;           // capital granted
    uint16  maxDrawdownBps;       // e.g. 1000 = 10% trailing from high-water mark
    uint16  dailyLossBps;         // e.g. 500 = 5% from day-start equity
    uint16  profitSplitBps;       // e.g. 8000 = 80% to trader
    uint16  maxPositionBps;       // notional cap as bps of allocation, e.g. 30000 = 3x
    uint64  expiry;
}

struct MandateState {
    address trader;
    address account;              // MandateAccount clone
    uint256 highWaterMark;        // peak equity seen
    uint256 dayStartEquity;
    uint64  dayStartTime;
    uint256 lastMarkedEquity;
    Status  status;               // Active | Breached | Expired | Closed
}
```

Deploy `MandateAccount` as a minimal-proxy clone per mandate — cheap, isolates state.

### 3.3 `MandateAccount.sol`

Holds the allocated capital. The **only** address authorised to place orders for that
mandate. The trader signs; the account checks constraints *before* forwarding to Perpl.

Pre-trade checks:
- mandate status is `Active`
- resulting notional ≤ `allocation * maxPositionBps / 10000`
- projected equity after worst-case slippage stays above both floors
- not past expiry

Two enforcement points matter: **pre-trade** (block the obviously bad order) and
**post-trade / per-block** (catch what moved against you). Both are needed. Pre-trade
alone is insufficient because price moves after you're filled.

### 3.4 `RiskEngine.sol`

Pure/view logic, no state. Called by both the account and the keeper.

```
equity          = allocation + realisedPnL + unrealisedPnL
highWaterMark   = max(highWaterMark, equity)          // updated on each mark
trailingFloor   = highWaterMark * (10000 - maxDrawdownBps) / 10000
dailyFloor      = dayStartEquity * (10000 - dailyLossBps) / 10000

breached        = equity < trailingFloor || equity < dailyFloor
```

`dayStartEquity` resets at 00:00 UTC (make the reset hour a parameter — real prop firms
use broker server time, and saying so in the demo shows domain knowledge).

`enforce(mandateId)` must be **permissionless** — anyone can call it, not just your
keeper. That's the trust property that distinguishes this from a prop firm's private
server, and it's a one-line design decision that judges will notice. Say it out loud in
the demo.

### 3.5 `Settlement`

On close, expiry, or breach:

```
profit = equity > allocation ? equity - allocation : 0
traderPayout = profit * profitSplitBps / 10000
poolReturn   = equity - traderPayout
```

On breach: flatten the position first, *then* settle whatever equity remains. Loss stays
with the pool, capped at the allocation.

### 3.6 Keeper (`keeper/`)

TypeScript service:

1. Subscribe to new blocks
2. Read open mandates from the registry
3. Fetch position data from Perpl + current oracle price
4. Compute equity per mandate
5. Call `markAndEnforce(mandateId)` for any breach
6. Batch multiple mandates into a single call — this is where the cheap-gas argument lives

Log every mark to a local store for the demo. Being able to say "we marked N mandates
across M blocks for $X total gas" is exactly the benchmark number the pitch needs.

### 3.7 Frontend

**Trader view** — the money screen:
- Live equity curve with the **trailing drawdown floor drawn as a line beneath it**
- Distance to floor, in currency and percent, updating per block
- Mandate terms, plainly stated
- Open position, PnL, trade panel

**LP view:**
- Pool TVL, idle vs allocated
- Active mandates: trader, allocation, current equity, distance to floor
- Historical: mandates closed, breached, aggregate return

Design & Craft is 20% and the stated bar is "an interface a trader would actually trust
with capital." One screen done properly beats five half-built ones. The equity curve with
the floor on it is the screen.

---

## 4. Build phases

- **Phase 0** — Scaffold: monorepo, Foundry config, Makefile, .env.example, README skeleton
- **Phase 1** — Perpl spike ⚠️ GATE. Verify Monad testnet availability. Fall back to `MiniPerp.sol`.
- **Phase 2** — Core contracts: RiskEngine → MandateAccount → MandateRegistry → CapitalPool
- **Phase 3** — Tests: unit + invariant + fuzz, >90% coverage on RiskEngine/MandateRegistry
- **Phase 4** — Keeper: block subscriber, batched markAndEnforce, structured logs, local store
- **Phase 5** — Frontend: trader view first (equity curve + floor), then LP view
- **Phase 6** — Envio indexer: load-bearing, replaces direct-RPC history
- **Phase 7** — Deploy + seed: Deploy.s.sol, seed.ts, DEPLOY.md with judge access
- **Phase 8** — Demo: scripts/demo.ts, deterministic 90s breach, tx hash printed

### Contract requirements (all phases)

- ReentrancyGuard on anything moving funds
- Custom errors, not require strings
- Events on every state transition (the indexer depends on these)
- NatSpec on all public functions

---

## 5. Timeline

| Week | Dates | Work |
|---|---|---|
| 1 | Sep 8–14 | Phases 0–1. **Perpl gate resolved.** Write the mandate rules spec from the FundingPips rulebook. Sort the campus group. |
| 2 | Sep 15–21 | Phase 2. Contracts deployed to testnet. |
| 3 | Sep 22–28 | Phases 3–5. Tests, keeper, trader view. |
| 4 | Sep 29–Oct 5 | **Testers.** Phases 6–7 in the gaps. |
| 5 | Oct 6–14 | Phase 8, videos, README, logo, buffer. |

### Week 4 is the one people get wrong

You will want to keep adding features, because code is comfortable and asking strangers
to try your thing is not. Resist it. Fifteen real testers is worth more against this
rubric than any feature shipped that week.

Where they are: prop-firm Discords (FundingPips and competitors), the funded-trader side
of X, r/Daytrading, r/propfirms. The pitch writes itself — *"I built an onchain prop firm
where the rules are a smart contract and the payout can't be refused. Testnet, free, no
signup. Will you break it?"*

Collect: number of mandates run, number of breaches correctly enforced, and 3–4 direct
quotes. Screenshot everything.

---

## 6. Deliverables checklist

- [ ] Logo/graphic — JPG/PNG/WEBP, under 3MB
- [ ] Public GitHub repo, accessible to `metropolis@hackathon.monad.xyz`
- [ ] **Technical demo video, max 3 min** — live product, not slides, not a code walkthrough
- [ ] **Pitch video, max 2 min** — team, problem, why you're building it
- [ ] Live product link on Monad testnet + access instructions + funded test credentials
- [ ] 30s advertisement (optional, not judged)
- [ ] Bounty tags: Perpl ×2, Envio, community group
- [ ] README with a per-sponsor section: one line each, pointing at the actual file path

Budget a **full day per video**. They carry more of your score than the last feature you'd
otherwise ship, and everyone underestimates them.

### The pitch video is 45% of your rubric in two minutes

You trade a FundingPips Zero account. You blew two before this one. Say that on camera.
The rules were a PDF, the risk engine was a black box, and the payout was somebody's
decision. Then show a contract that can't do any of those things.

The criterion asks: *"can they name a specific first user beyond 'crypto traders'?"* You
can name yourself. Almost no other team can.

---

## 7. Questions judges will ask — have answers ready

**"What stops a trader dumping the pool's capital into a deliberately losing trade against
their own wallet?"**
Position caps, a per-block loss limit that fires before meaningful size can move, and a
public venue where the counterparty isn't chosen. Mitigated, not solved. Say the residual
out loud.

**"Why can't a prop firm just do this off-chain?"**
They do — that's the entire status quo, and it requires trusting their server. The claim
here isn't that enforcement is novel, it's that *verifiable* enforcement just became
affordable.

**"What if the keeper goes down?"**
`enforce()` is permissionless. Any LP, any observer, any competing trader can call it.
The keeper is a convenience, not a trust assumption.

**"Isn't this just a vault with extra steps?"**
A vault allocates capital. A mandate allocates capital *plus enforceable constraints on
how it's used*, with the constraints legible to both sides before either commits. That's
the primitive.

---

## 8. Cut order

You will fall behind. Cut in this order:

1. Extra sponsor integrations beyond Perpl and Envio
2. LP-side features beyond deposit, withdraw, and view
3. Historical analytics
4. Mera, if the SDK fights you (fall back to a standard wallet)
5. Anything that isn't the drawdown enforcement moment

**Never cut:** the equity curve with the floor on it, the live breach demo, or the pitch
video where you say you blew two prop accounts.
