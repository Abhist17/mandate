# Mandate Indexer — Envio HyperIndex

Placeholder until Phase 6.

Indexes from the deployed Monad testnet contracts:

| Event | Powers |
|---|---|
| `MandateIssued` | Mandate list, terms display |
| `EquityMarked` | Equity curves — the core trader screen |
| `Breached` | Breach history, enforcement proof |
| `PositionOpened` / `PositionClosed` | Fill history |
| `Settled` | LP returns, trader payouts |

Exposes a GraphQL endpoint the frontend queries for historical equity curves and fill
history. **Load-bearing, not decorative** — the direct-RPC history calls in `web/` are
replaced by indexer queries.
