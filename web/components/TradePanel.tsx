"use client";

import {useState} from "react";
import {ADDR, MARKETS, publicClient} from "@/lib/chain";
import {accountAbi, venueExtraAbi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {useToast} from "@/components/Toast";
import {fmtPrice, fmtUsd} from "@/lib/format";
import {useFeedAge, FEED_STALE_AT, type Mandate} from "@/lib/data";

/**
 * Order entry.
 *
 * Quotes the real fill through `MiniPerp.previewFill` before the trader signs, including
 * spread and size impact. Showing the mark price and calling it the fill would be a small
 * lie that costs the trader money, and this is a screen that is supposed to be trustworthy.
 */
export function TradePanel({mandate, onDone}: {mandate: Mandate; onDone: () => void}) {
  const {address, client, wrongChain} = useWallet();
  const toast = useToast();
  const [marketId, setMarketId] = useState<number>(MARKETS[0].id);
  const [size, setSize] = useState("1");
  const [quote, setQuote] = useState<{buy: bigint; sell: bigint} | undefined>();
  const [busy, setBusy] = useState(false);

  const isTrader = address?.toLowerCase() === mandate.state.trader.toLowerCase();
  const active = mandate.state.status === 1;
  const feedAge = useFeedAge();
  // Refuse to submit into a stale feed: the contract would revert, the user would pay gas for
  // nothing, and it would look like the app failed. Disable early, with the reason.
  const feedStale = feedAge !== undefined && feedAge >= FEED_STALE_AT - 30;
  const sizeWei = (() => {
    const n = Number(size);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e18)) : 0n;
  })();

  async function refreshQuote(nextSize = sizeWei, nextMarket = marketId) {
    if (nextSize === 0n) return setQuote(undefined);
    try {
      const [buy, sell] = await Promise.all([
        publicClient.readContract({
          address: ADDR.venue, abi: venueExtraAbi, functionName: "previewFill",
          args: [nextMarket, nextSize, true],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: ADDR.venue, abi: venueExtraAbi, functionName: "previewFill",
          args: [nextMarket, nextSize, false],
        }) as Promise<bigint>,
      ]);
      setQuote({buy, sell});
    } catch {
      setQuote(undefined);
    }
  }

  async function submit(isLong: boolean) {
    if (!client || !address || sizeWei === 0n) return;
    setBusy(true);
    const sym = MARKETS.find((m) => m.id === marketId)?.symbol ?? "";
    const t = toast.push({
      kind: "pending",
      title: `${isLong ? "Long" : "Short"} ${size} ${sym}`,
      body: "The contract checks this against your position cap before it fills.",
    });
    try {
      const hash = await client.writeContract({
        account: address,
        chain: null,
        address: mandate.state.account,
        abi: accountAbi,
        functionName: "openPosition",
        args: [marketId, isLong, sizeWei, 0n],
      });
      toast.update(t, {body: "Waiting for confirmation…", hash});
      await publicClient.waitForTransactionReceipt({hash});
      toast.update(t, {
        kind: "success",
        title: `${isLong ? "Long" : "Short"} ${size} ${sym} filled`,
        body: "Watch your distance to floor — it updates every block.",
        hash,
      });
      onDone();
    } catch (e) {
      toast.update(t, {kind: "error", title: "Order rejected", body: decodeError(e)});
    } finally {
      setBusy(false);
    }
  }

  async function close(id: number) {
    if (!client || !address) return;
    setBusy(true);
    const t = toast.push({kind: "pending", title: "Closing position", body: "Confirm in your wallet."});
    try {
      const hash = await client.writeContract({
        account: address,
        chain: null,
        address: mandate.state.account,
        abi: accountAbi,
        functionName: "closePosition",
        args: [id, 0n],
      });
      toast.update(t, {body: "Waiting for confirmation…", hash});
      await publicClient.waitForTransactionReceipt({hash});
      toast.update(t, {kind: "success", title: "Position closed", hash});
      onDone();
    } catch (e) {
      toast.update(t, {kind: "error", title: "Could not close", body: decodeError(e)});
    } finally {
      setBusy(false);
    }
  }

  if (!active) {
    return (
      <div className="px-4 py-6 text-center text-sm text-txt-lo">
        This mandate is no longer active. Trading is closed.
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-3 gap-1">
        {MARKETS.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMarketId(m.id);
              void refreshQuote(sizeWei, m.id);
            }}
            className={`rounded border px-2 py-1.5 text-xs transition-colors ${
              marketId === m.id
                ? "border-ink-500 bg-ink-800 text-txt-hi"
                : "border-edge bg-ink-950 text-txt-mid hover:text-txt-hi"
            }`}
          >
            {m.symbol}
          </button>
        ))}
      </div>

      <div>
        <label className="stat-label">Size</label>
        <input
          className="input num mt-1"
          value={size}
          inputMode="decimal"
          onChange={(e) => {
            setSize(e.target.value);
            const n = Number(e.target.value);
            void refreshQuote(Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e18)) : 0n);
          }}
          placeholder="0.00"
        />
      </div>

      {quote && (
        <div className="rounded border border-edge bg-ink-950 px-2.5 py-2 text-2xs">
          <div className="flex justify-between text-txt-lo">
            <span>Est. fill (incl. spread + impact)</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="num text-up">buy {fmtPrice(quote.buy)}</span>
            <span className="num text-down">sell {fmtPrice(quote.sell)}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => void submit(true)}
          disabled={!isTrader || busy || wrongChain || sizeWei === 0n || feedStale}
          className="btn btn-up py-2"
        >
          {busy ? "…" : "Long"}
        </button>
        <button
          onClick={() => void submit(false)}
          disabled={!isTrader || busy || wrongChain || sizeWei === 0n || feedStale}
          className="btn btn-down py-2"
        >
          {busy ? "…" : "Short"}
        </button>
      </div>

      {feedStale && (
        <p className="rounded-lg border border-down/30 bg-down/[0.07] px-2.5 py-2 text-2xs leading-relaxed text-down">
          Trading is paused — the price feed is {Math.floor((feedAge ?? 0) / 60)} minutes old and
          the contract refuses orders against a stale price. Not something you did; the keeper
          needs to refresh it.
        </p>
      )}

      {!isTrader && (
        <p className="text-2xs text-txt-lo">
          Connect as {mandate.state.trader.slice(0, 10)}… to trade this mandate.
        </p>
      )}

      {mandate.positions.length > 0 && (
        <div className="space-y-1.5 border-t border-edge pt-3">
          <div className="stat-label">Open positions</div>
          {mandate.positions.map((p) => (
            <div key={p.marketId} className="flex items-center justify-between gap-2 text-xs">
              <span className={p.isLong ? "text-up" : "text-down"}>
                {p.isLong ? "LONG" : "SHORT"} {p.symbol}
              </span>
              <span className="num text-txt-mid">{fmtUsd(p.unrealised)}</span>
              <button
                onClick={() => void close(p.marketId)}
                disabled={!isTrader || busy}
                className="btn px-2 py-0.5 text-2xs"
              >
                Close
              </button>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

/**
 * Surface the contract's own custom errors rather than a wall of viem trace.
 * A trader who hits the position cap should be told they hit the position cap.
 */
function decodeError(e: unknown): string {
  const s = String(e);
  if (s.includes("PositionCapExceeded")) return "Order exceeds this mandate's position cap.";
  if (s.includes("WouldBreachFloor")) return "Order would put equity under the drawdown floor.";
  if (s.includes("MandateNotActive")) return "This mandate is no longer active.";
  if (s.includes("MandateExpired")) return "This mandate has expired.";
  if (s.includes("StalePrice")) return "Price feed is stale — the keeper may be down.";
  if (s.includes("InsufficientMargin")) return "Not enough free collateral for that size.";
  if (s.includes("SizeTooSmall")) return "Size is below this market's minimum.";
  if (s.includes("NotMandateTrader")) return "Only this mandate's trader can place orders.";
  if (s.includes("User rejected") || s.includes("denied")) return "Rejected in wallet.";
  return "Transaction failed.";
}
