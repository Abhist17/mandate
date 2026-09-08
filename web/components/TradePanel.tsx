"use client";

import {useState} from "react";
import {ADDR, MARKETS, publicClient, explorerTx} from "@/lib/chain";
import {accountAbi, venueExtraAbi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {fmtPrice, fmtUsd} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * Order entry.
 *
 * Quotes the real fill through `MiniPerp.previewFill` before the trader signs, including
 * spread and size impact. Showing the mark price and calling it the fill would be a small
 * lie that costs the trader money, and this is a screen that is supposed to be trustworthy.
 */
export function TradePanel({mandate, onDone}: {mandate: Mandate; onDone: () => void}) {
  const {address, client, wrongChain} = useWallet();
  const [marketId, setMarketId] = useState<number>(MARKETS[0].id);
  const [size, setSize] = useState("1");
  const [quote, setQuote] = useState<{buy: bigint; sell: bigint} | undefined>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{kind: "ok" | "err"; text: string; hash?: string}>();

  const isTrader = address?.toLowerCase() === mandate.state.trader.toLowerCase();
  const active = mandate.state.status === 1;
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
    setMsg(undefined);
    try {
      const hash = await client.writeContract({
        account: address,
        chain: null,
        address: mandate.state.account,
        abi: accountAbi,
        functionName: "openPosition",
        args: [marketId, isLong, sizeWei, 0n],
      });
      await publicClient.waitForTransactionReceipt({hash});
      setMsg({kind: "ok", text: `${isLong ? "Long" : "Short"} filled`, hash});
      onDone();
    } catch (e) {
      setMsg({kind: "err", text: decodeError(e)});
    } finally {
      setBusy(false);
    }
  }

  async function close(id: number) {
    if (!client || !address) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const hash = await client.writeContract({
        account: address,
        chain: null,
        address: mandate.state.account,
        abi: accountAbi,
        functionName: "closePosition",
        args: [id, 0n],
      });
      await publicClient.waitForTransactionReceipt({hash});
      setMsg({kind: "ok", text: "Position closed", hash});
      onDone();
    } catch (e) {
      setMsg({kind: "err", text: decodeError(e)});
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
          disabled={!isTrader || busy || wrongChain || sizeWei === 0n}
          className="btn btn-up py-2"
        >
          {busy ? "…" : "Long"}
        </button>
        <button
          onClick={() => void submit(false)}
          disabled={!isTrader || busy || wrongChain || sizeWei === 0n}
          className="btn btn-down py-2"
        >
          {busy ? "…" : "Short"}
        </button>
      </div>

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

      {msg && (
        <div className={`text-2xs ${msg.kind === "ok" ? "text-up" : "text-down"}`}>
          {msg.text}
          {msg.hash && (
            <>
              {" · "}
              <a
                className="underline hover:text-txt-hi"
                href={explorerTx(msg.hash)}
                target="_blank"
                rel="noreferrer"
              >
                tx
              </a>
            </>
          )}
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
