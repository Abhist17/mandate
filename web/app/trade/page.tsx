"use client";

import {useEffect, useState} from "react";
import {EquityChart} from "@/components/EquityChart";
import {ChartControls, type Unit} from "@/components/ChartControls";
import {TradePanel} from "@/components/TradePanel";
import {ClaimMandate} from "@/components/ClaimMandate";
import {PayoutPanel} from "@/components/PayoutPanel";
import {EnforceButton} from "@/components/EnforceButton";
import {AccountHeader} from "@/components/AccountHeader";
import {MandateCard} from "@/components/MandateCard";
import {Objectives} from "@/components/Objectives";
import {Onboarding} from "@/components/Onboarding";
import {Crumb} from "@/components/Crumb";
import {TradeHistory} from "@/components/TradeHistory";
import {Panel, Empty, Skeleton} from "@/components/ui";
import {useMandates} from "@/lib/useMandates";
import {fetchEquityCurve, type EquityPoint} from "@/lib/history";
import {isConfigured} from "@/lib/chain";
import {useSession} from "@/lib/useSession";
import {toNum, fmtUsd, fmtSigned, fmtSize, fmtPrice} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * The client area.
 *
 * Laid out the way funded traders already expect: account rail on the left, where you are
 * and what you can do at the top, current results, the equity curve with the rules drawn on
 * it, then the objectives and the open book. That shape is not a style choice — it is the
 * order the questions get asked in, and a trader should not have to learn a new one to read
 * an account they already understand.
 */
export default function TraderPage() {
  const {mandates, current, select} = useMandates();

  if (!isConfigured) return <NotConfigured />;
  if (!mandates) return <Loading />;

  if (mandates.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <ClaimMandate onClaimed={select} />
        <Panel title="No mandates yet">
          <Empty>
            Nothing has been issued. Claim one above, or run{" "}
            <span className="num text-txt-mid">npm run seed</span>.
          </Empty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ClaimBanner mandates={mandates} onClaimed={select} />
      <Onboarding mandates={mandates} />
      {current && <Detail mandate={current} />}
    </div>
  );
}

function Detail({mandate}: {mandate: Mandate}) {
  const {refresh} = useMandates();
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [source, setSource] = useState<"envio" | "rpc">("rpc");
  const [lines, setLines] = useState(true);
  const [unit, setUnit] = useState<Unit>("abs");

  const id = mandate.id;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const {points, source} = await fetchEquityCurve(id);
        if (!cancelled) {
          setCurve(points);
          setSource(source);
        }
      } catch {
        /* the chart falls back to empty rather than breaking the page */
      }
    };
    void load();
    const t = setInterval(() => void load(), 4_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  return (
    <div className="space-y-4">
      <Crumb mandate={mandate} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <EnforceButton mandate={mandate} onDone={refresh} />

          <AccountHeader mandate={mandate} />

          <section className="panel rise rise-2">
            <header className="panel-head">
              <h2 className="panel-title">Equity vs drawdown floor</h2>
              <span
                className="text-2xs text-txt-lo"
                title={
                  source === "envio"
                    ? "Full history, indexed by Envio HyperIndex"
                    : "Monad's public RPC caps eth_getLogs at a 100-block range, so this fallback shows only recent history. Run the Envio indexer for the full curve."
                }
              >
                {curve.length} marks ·{" "}
                {source === "envio" ? (
                  <span className="text-up">Envio</span>
                ) : (
                  <span className="text-warn">RPC (recent only)</span>
                )}
              </span>
            </header>

            <ChartControls lines={lines} onLines={setLines} unit={unit} onUnit={setUnit} />

            <div className="p-3">
              <EquityChart
                points={curve}
                allocation={toNum(mandate.terms.allocation)}
                breached={mandate.state.status === 2}
                objectiveLines={lines}
                unit={unit}
              />
            </div>
          </section>

          {/* Objectives sit under the chart, which is where a funded trader looks second —
              the curve says what happened, this says whether it was still allowed. */}
          <Objectives mandate={mandate} />

          <Positions mandate={mandate} />

          <TradeHistory account={mandate.state.account} />
        </div>

        {/* ── side rail ─────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Panel title="Trade">
            <TradePanel mandate={mandate} onDone={refresh} />
          </Panel>
          <PayoutPanel mandate={mandate} />
          <MandateCard mandate={mandate} />
        </div>
      </div>
    </div>
  );
}

/**
 * Open positions.
 *
 * Kept visible with an empty state rather than unmounted when flat, because a table that
 * disappears takes the page's whole lower half with it and everything below jumps.
 */
function Positions({mandate}: {mandate: Mandate}) {
  return (
    <Panel
      title="Open positions"
      right={
        <span className="num text-2xs text-txt-lo">
          {fmtUsd(mandate.notional)} notional
        </span>
      }
    >
      {mandate.positions.length === 0 ? (
        <Empty>Flat. Nothing is riding on the next tick.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-xs">
            <thead>
              <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
                <th className="px-4 py-2 text-left font-medium">Market</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">Entry</th>
                <th className="px-4 py-2 text-right font-medium">Mark</th>
                <th className="px-4 py-2 text-right font-medium">Margin</th>
                <th className="px-4 py-2 text-right font-medium">Unrealised</th>
              </tr>
            </thead>
            <tbody>
              {mandate.positions.map((p) => (
                <tr key={p.marketId} className="row-hover border-b border-edge/50 last:border-0">
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider ${
                        p.isLong ? "bg-up/10 text-up" : "bg-down/10 text-down"
                      }`}
                    >
                      {p.isLong ? "Long" : "Short"}
                    </span>
                    <span className="ml-2 text-txt-hi">{p.symbol}</span>
                  </td>
                  <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtSize(p.size)}</td>
                  <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtPrice(p.entryPrice)}</td>
                  <td className="num px-4 py-2.5 text-right text-txt-hi">{fmtPrice(p.markPrice)}</td>
                  <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtUsd(p.margin)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {/* The number that moves. Boxed so it reads as a live cell rather than
                        one more figure in a row of static ones. */}
                    <span
                      className={`num rounded px-2 py-1 ${
                        p.unrealised >= 0n ? "bg-up/[0.08] text-up" : "bg-down/[0.08] text-down"
                      }`}
                    >
                      {fmtSigned(p.unrealised)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Shown only to a connected visitor who does not already have a mandate of their own.
 * Someone already trading should not be nagged to claim another, and a disconnected visitor
 * sees the dashboard first — the product should be legible before it asks for a wallet.
 */
function ClaimBanner({
  mandates,
  onClaimed,
}: {
  mandates: Mandate[];
  onClaimed: (id: bigint) => void;
}) {
  const {address} = useSession();
  const [dismissed, setDismissed] = useState(false);
  if (!address || dismissed) return null;

  const owns = mandates.some(
    (m) => m.state.trader.toLowerCase() === address.toLowerCase() && m.state.status === 1,
  );
  if (owns) return null;

  return (
    <div className="mx-auto max-w-lg space-y-1.5">
      <div className="flex justify-end">
        <button
          onClick={() => setDismissed(true)}
          className="px-1 text-2xs text-txt-lo transition-colors hover:text-txt-hi"
        >
          dismiss
        </button>
      </div>
      <ClaimMandate onClaimed={onClaimed} />
    </div>
  );
}

/** Shaped like the real layout so nothing jumps when the data lands. */
function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-[440px] w-full rounded-xl" />
        </div>
        <Skeleton className="hidden h-[620px] w-full rounded-xl xl:block" />
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <Panel title="Not configured">
      <div className="space-y-2 px-4 py-8 text-sm text-txt-mid">
        <p>Contract addresses are missing.</p>
        <p className="text-txt-lo">
          Deploy with <span className="num">make deploy-testnet</span>, copy the printed addresses
          into <span className="num">.env</span>, then restart the dev server.
        </p>
      </div>
    </Panel>
  );
}
