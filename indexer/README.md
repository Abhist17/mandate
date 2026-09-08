# Mandate Indexer — Envio HyperIndex

Indexes the enforcement loop on Monad testnet and serves it over GraphQL.

## Why this is load-bearing, not decorative

Monad's public RPC caps `eth_getLogs` at a **100-block range**:

```bash
curl -s -X POST https://testnet-rpc.monad.xyz -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"latest"}]}'
# -> "eth_getLogs is limited to a 100 range"
```

At ~400ms blocks that is **forty seconds of history**. The trader screen's central feature —
an equity curve with the drawdown floor drawn beneath it — is not buildable from raw RPC.

`web/lib/history.ts` queries this indexer first and only falls back to a degraded
recent-only RPC window when it is unavailable, labelling the chart accordingly. Remove the
indexer and the core screen degrades visibly.

## What it indexes

| Event | Entity | Powers |
|---|---|---|
| `MandateIssued` | `Mandate` | Mandate list, terms, lifecycle |
| `EquityMarked` | `EquityMark` | **The equity curve** — every point is a row |
| `DayRolled` | `PoolEvent` | Explains steps in the daily floor line |
| `Breached` | `Breach` | Enforcement record, including *who* enforced it |
| `Settled` | `Settlement` | Payouts, pool result |
| `PositionOpened` / `PositionClosed` / `Liquidated` | `Fill` | Fill history |
| `Flattened` | `PoolEvent` | The enforcement action itself |
| `Deposited` / `WithdrawalClaimed` / `Allocated` / `MandateSettled` | `PoolEvent` | LP flows |
| — | `ProtocolStats` | Running totals for the LP dashboard |

`effectiveFloor` and `headroom` are computed at index time. They are pure functions of values
the event already carries, and computing them here means the chart does not have to.

`Breach.enforcedBy` is worth calling out: it records which address called `markAndEnforce`.
Because that function is permissionless, this column is the evidence that enforcement is not
ours to withhold.

## Version

HyperIndex **V3** (`envio@3.10`). The V2 → V3 differences that matter here, all verified
against the installed package's type definitions rather than against docs:

| | V2 | V3 |
|---|---|---|
| Networks | `networks:` | `chains:` |
| Registration | `Contract.Event.handler(fn)` | `indexer.onEvent({contract, event}, fn)` |
| Codegen output | `generated/` | `.envio/` + `envio-env.d.ts` |
| Transaction fields | included | opt-in via `field_selection.transaction_fields` |

One correction worth recording: the migration guide suggests entities move to
`context.chain.Entity.set`. They do not — `chain` is only `{id, isRealtime}`, and entities
stay on `context` directly. The generated types are the authority.

## Run

```bash
cd indexer
npm install
npm run codegen    # writes .envio/ types from config.yaml + schema.graphql
npm run dev        # syncs addresses from ../.env, then starts Envio
```

`npm run codegen` passing is a real check: it validates the config, the schema, and every
event signature against the ABI shape.

GraphQL lands on `http://localhost:8080/v1/graphql`. Point the frontend at it with:

```
NEXT_PUBLIC_ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql
```

`npm run sync` writes the deployed addresses from `../.env` into `config.yaml`, so `.env`
stays the single source of truth rather than requiring hand-edits in three places.

Set `INDEXER_START_BLOCK` in `.env` to the deployment block — indexing Monad testnet from
block 0 is slow and pointless.

## Example query — the equity curve

```graphql
query Curve($id: String!) {
  EquityMark(where: {mandateId: {_eq: $id}}, order_by: {markedAt: asc}) {
    markedAt
    equity
    highWaterMark
    effectiveFloor
    headroom
    markedBy
  }
}
```
