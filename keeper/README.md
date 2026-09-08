# Mandate Keeper

Subscribes to Monad testnet blocks, marks every open mandate against live oracle prices,
and calls `markAndEnforce` on any that breach.

The keeper is a **convenience, not a trust assumption** — `enforce()` on the registry is
permissionless. If this process dies, any LP or observer can enforce a breach themselves.

## What it does per block

1. Read open mandates from `MandateRegistry`
2. Fetch position data from the venue + the current oracle price
3. Compute equity: `allocation + realisedPnL + unrealisedPnL`
4. Batch every mandate needing a mark into a single transaction
5. Log block number, mandates marked, gas used, breaches triggered
6. Persist every mark to a local store for the demo and the gas benchmark

## Why the gas accounting matters

The pitch needs a number: *"we marked N mandates across M blocks for $X total gas."*
That number is the whole economic argument for why this runs on Monad and not elsewhere.
The store at `keeper/data/marks.json` is what produces it.

## Run

```bash
cp ../.env.example ../.env    # fill in KEEPER_PRIVATE_KEY + addresses
npm run start -w keeper
```
