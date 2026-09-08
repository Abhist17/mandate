# Phase 1 — Venue & Oracle Gate: Findings

**Date:** 2026-09-08
**Status:** ✅ Gate resolved. Proceeding to Phase 2 with `MiniPerp.sol` as the settlement
venue and Perpl as a load-bearing live price + market-config source.

Everything below was verified against live endpoints and live chain state, not training
data. Reproduction commands are included so any judge can re-run them.

---

## 1. Is Perpl on Monad testnet?

**Yes.** Perpl runs on both Monad mainnet (chain 143) and Monad testnet (chain 10143).

| | Monad Testnet |
|---|---|
| Chain ID | `10143` |
| RPC | `https://testnet-rpc.monad.xyz` |
| REST API | `https://testnet.perpl.xyz/api` |
| WebSocket | `wss://testnet.perpl.xyz` |
| Exchange contract | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |
| Collateral token | AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (6 decimals) |

Verified live:

```bash
curl -s https://testnet.perpl.xyz/api/v1/pub/context | jq '.chain, .instances, .tokens'
curl -s -X POST https://testnet-rpc.monad.xyz -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x279f"}   (0x279f = 10143)
```

Live markets on testnet at time of writing:

| Market | ID | Price decimals | Size decimals | `initial_margin` | `maintenance_margin` | maker / taker |
|---|---|---|---|---|---|---|
| BTC Perp | 16 | 1 | 5 | 1500 | 2500 | 90 / 690 |
| ETH Perp | 32 | 2 | 3 | 1200 | 2000 | 90 / 690 |
| SOL Perp | 48 | 2 | 2 | 1000 | 2000 | 90 / 690 |

**Fees** are millionths of notional: `690` → **0.069%**, a realistic taker fee. (Reading them
as basis points would give 6.9%, which no perp venue charges.) `MiniPerp` uses the same scale.

**Margin integers are quoted raw, on purpose.** Perpl's public docs do not state their units,
and the live values contradict the obvious reading: BTC reports `initial_margin: 1500` and
`maintenance_margin: 2500`, and a maintenance requirement *above* the initial one would make
every position liquidatable the instant it opened. Rather than guess, `MiniPerp` defines its
own margin model explicitly in bps of notional (BTC 15% initial / 7.5% maintenance) and the
divergence is recorded here instead of being papered over.

Market IDs are network-specific and the docs explicitly say to discover them at runtime
via `GET /api/v1/pub/context` rather than hard-coding. The keeper does exactly that.

---

## 2. ⚠️ The blocking discovery: Perpl orders cannot be placed by a contract

This is the finding that shapes the whole architecture, so it is stated plainly.

Perpl authenticates programmatic access with **Ed25519 key pairs**, not EIP-712 wallet
signatures on the order itself:

- API key enrolment needs two signatures — an EIP-712 secp256k1 wallet signature proving
  account ownership, and an Ed25519 proof-of-possession over that digest.
- Every subsequent request is signed with the Ed25519 private key over a canonical string
  (chain ID, method, target, timestamp, nonce, body hash), base64url-encoded.
- Order placement and position closing happen over the **WebSocket API**, not REST, and
  not onchain.
- Perpl **does not support EIP-1271 contract signatures for order placement.**

### Why that is disqualifying for the venue role

Mandate's entire trust property is this sentence:

> Breach the drawdown and *the contract* flattens the position and revokes the mandate in
> the same block, and anyone can trigger it.

A Solidity contract cannot hold an Ed25519 key and cannot sign a WebSocket frame. If Perpl
were the venue, flattening a breached position would require an off-chain, authenticated
API call from a keyholder — which is precisely the trusted private risk server that every
incumbent prop firm already runs, and precisely the thing this project exists to remove.

Using Perpl as the venue would mean shipping a product whose central claim is false. So we
don't.

---

## 3. Decision

### Venue: `MiniPerp.sol` (the SPEC §2 fallback)

A minimal internal perp venue, exactly as the spec anticipated: single collateral, several
oracle-priced markets, isolated margin, linear funding, no order book. Positions open and
close through contract calls, so `MandateRegistry.markAndEnforce()` can genuinely flatten a
position and revoke a mandate atomically, and `enforce()` stays permissionless.

`MiniPerp` is not a toy chosen for convenience — it is the only construction under which
the product's claim holds. That is a better answer to a judge than a checkbox integration.

To keep it honest rather than self-serving, `MiniPerp` mirrors Perpl's **real** testnet
market configuration, read live from `/pub/context`:

- same markets (BTC / ETH / SOL) and same tick/size precision
- same initial margin (15% BTC, 12% ETH) and maintenance margin (25% / 20%)
- same maker/taker fee tiers (90 / 690 bps‱)
- same funding interval (2580s ≈ 8571 blocks) and linear funding accrual
- collateral denominated 6-decimal, matching AUSD

So a mandate run against `MiniPerp` faces the same margin and fee economics a trader would
face on Perpl proper.

### Perpl's role: live price + market spec source (load-bearing)

`GET /api/v1/pub/context` is **public and unauthenticated**, and returns per-market live
state including:

| Field | Meaning |
|---|---|
| `orl` | oracle price |
| `mrk` | mark price |
| `lst` / `mid` / `bid` / `ask` | last / mid / top of book |
| `oi` | open interest |
| `tvl` | market TVL |
| `funding.rate`, `funding.idx`, `funding.sum` | live funding state |

Prices are integers scaled by the market's `price_decimals` (BTC `price_decimals: 1`, so
`orl: 789262` → **$78,926.20**).

The keeper polls this endpoint every block and pushes Perpl's oracle price onchain as the
mark for `MiniPerp`. That makes Perpl **load-bearing**: mandates are marked, and breaches
are triggered, against Perpl's real live market prices. Kill the Perpl feed and the demo
stops marking.

This also satisfies both Perpl bounties honestly:
- *API / automation* — the keeper is a production automation system built on Perpl's public
  API with runtime market discovery, reconnect, and batching.
- *Analytics / Risk tool* — the trader and LP dashboards are risk analytics over that feed.

---

## 4. Which oracle is live on Monad testnet?

**Pyth is live and verified working.**

| | Value |
|---|---|
| Pyth contract (Monad testnet) | `0x2880aB155794e7179c9eE2e38200202908C17B43` |
| BTC/USD feed ID | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| Hermes (price update service) | `https://hermes.pyth.network` |

Verified with a live call:

```bash
cast call 0x2880aB155794e7179c9eE2e38200202908C17B43 \
  "getPriceUnsafe(bytes32)((int64,uint64,int32,uint256))" \
  0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43 \
  --rpc-url https://testnet-rpc.monad.xyz
# -> (7727730500000, 2849500000, -8, 1787559137)
#     price=7727730500000, expo=-8  =>  $77,277.305
```

Two other candidate addresses (`0x4305FB66…`, `0xad2B52D2…`) have no code on Monad testnet;
`0xDd24F84d…` has code but reverts on the Pyth interface. Use `0x2880aB15…`.

**Caveat, stated because it matters:** Pyth is a *pull* oracle. The `publishTime` above was
already stale relative to wall clock — the onchain price only advances when somebody
submits a Hermes update and pays for it. For a system that marks every mandate every block,
paying for a Pyth update every block is the wrong shape.

### Oracle design that follows from this

`PriceOracle.sol` is an adapter with two backends behind one interface:

1. **Perpl-fed (default for the demo).** Keeper pushes Perpl's `orl` per market. Fresh,
   free, and consistent with the venue whose market config we mirror.
2. **Pyth (verified, wired).** `getPriceNoOlderThan` against `0x2880aB15…` for anyone who
   wants a third-party feed, and as the staleness backstop.

Both paths enforce a max-staleness bound, and `MiniPerp` refuses to mark or settle on a
stale price. The limitation is documented rather than papered over.

---

## 5. Remaining unknowns (non-blocking)

| # | Question | Status |
|---|---|---|
| 4 | Monad P256 precompile address | Deferred — only needed if Mera goes deep. Cut order §8 item 4. |
| 5 | Envio HyperIndex on Monad testnet | Phase 6. Not blocking contracts. |
| 6 | Mera SDK surface for PRF-derived keys | Deferred. wagmi is the fallback per cut order. |
| 7 | Shared code across two submissions | Only matters if Warrant happens. Not now. |

---

## 6. What this unblocks

Phase 2 can start immediately, and every component in SPEC §3 stays identical — the only
change is that `MandateAccount` forwards orders to `MiniPerp` instead of Perpl, which is
the substitution the spec already planned for.

Gas note for the pitch: Monad testnet base fee reads `100000000000` (100 gwei) with p50 and
p95 both at `103000000000`, per Perpl's context payload. The keeper records real gas per
mark so the benchmark number in the pitch is measured, not estimated.
