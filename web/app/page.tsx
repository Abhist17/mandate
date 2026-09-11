"use client";

import {useEffect, useMemo, useState} from "react";
import {EquityChart} from "@/components/EquityChart";
import {TradePanel} from "@/components/TradePanel";
import {ClaimMandate} from "@/components/ClaimMandate";
import {PayoutPanel} from "@/components/PayoutPanel";
import {EnforceButton} from "@/components/EnforceButton";
import {Onboarding} from "@/components/Onboarding";
import {Panel, Stat, StatusPill, HeadroomBar, Field, LiveDot, Empty, Explainer, Skeleton} from "@/components/ui";
import {fetchRelevantIds, fetchMandate, usePolled, type Mandate} from "@/lib/data";
import {fetchEquityCurve, type EquityPoint} from "@/lib/history";
import {publicClient, ADDR, isConfigured, explorerAddr, BREACH_KIND} from "@/lib/chain";
import {useSession} from "@/lib/useSession";
import {registryAbi} from "@/lib/abi";
import {
  fmtUsd, fmtSigned, fmtBps, fmtPct, toNum, shortAddr, fmtCountdown, timeAgo, fmtSize, fmtPrice,
} from "@/lib/format";

/**
 * Trader view — the money screen.
 *
 * The whole page answers one question: how far am I from losing this mandate? Everything
 * above the fold is that answer, and the chart is the answer over time.
 */
export default function TraderPage() {
  const [selected, setSelected] = useState<bigint>();
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [curveSource, setCurveSource] = useState<"envio" | "rpc">("rpc");

  const {address: sessionAddress} = useSession();

  // Active mandates, the viewer's own, and a short settled tail — one multicall, not a
  // guessed numeric range fetched one by one.
  const {data: mandates} = usePolled(async () => {
    const ids = await fetchRelevantIds(sessionAddress);
    const all = await Promise.all(ids.map((id) => fetchMandate(id).catch(() => undefined)));
    return all.filter((m): m is Mandate => m !== undefined);
  }, 4_000, [sessionAddress]);

  // Open on YOUR mandate if you have one; otherwise on whichever is closest to its floor,
  // because that is the one worth watching.
  useEffect(() => {
    if (selected !== undefined || !mandates || mandates.length === 0) return;
    const active = mandates.filter((m) => m.state.status === 1);

    const mine = sessionAddress
      ? active.find((m) => m.state.trader.toLowerCase() === sessionAddress.toLowerCase())
      : undefined;
    if (mine) {
      setSelected(mine.id);
      return;
    }

    const pick =
      active.length > 0
        ? active.reduce((a, b) => (a.headroomBps <= b.headroomBps ? a : b))
        : mandates[0]!;
    setSelected(pick.id);
  }, [mandates, selected, sessionAddress]);

  const mandate = useMemo(
    () => mandates?.find((m) => m.id === selected),
    [mandates, selected],
  );

  useEffect(() => {
    if (selected === undefined) return;
    let cancelled = false;
    const load = async () => {
      try {
        const {points, source} = await fetchEquityCurve(selected);
        if (!cancelled) {
          setCurve(points);
          setCurveSource(source);
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
  }, [selected]);

  if (!isConfigured) return <NotConfigured />;

  if (!mandates) {
    // Shaped like the real layout so nothing jumps when the data lands.
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <div className="flex gap-2 overflow-hidden">
          {Array.from({length: 4}).map((_, i) => (
            <Skeleton key={i} className="h-24 w-[205px] shrink-0 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-[380px] w-full rounded-xl" />
          </div>
          <Skeleton className="hidden h-[420px] w-full rounded-xl xl:block" />
        </div>
      </div>
    );
  }

  if (mandates.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8">
        <ClaimMandate onClaimed={setSelected} />
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
      <Hero />
      <Onboarding mandates={mandates} />
      <MandateStrip mandates={mandates} selected={selected} onSelect={setSelected} />
      <ClaimBanner mandates={mandates} onClaimed={setSelected} />
      {mandate && (
        <TraderDetail
          mandate={mandate}
          curve={curve}
          curveSource={curveSource}
          onDone={() => setSelected(mandate.id)}
        />
      )}
    </div>
  );
}

/**
 * Shown only to a connected visitor who does not already have a mandate of their own.
 * Someone already trading should not be nagged to claim another, and a disconnected visitor
 * sees the dashboards first — the product should be legible before it asks for a wallet.
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

  // The dismiss control sits ABOVE the panel, not on top of it: absolutely positioning it in
  // the corner put it straight through the panel header's own right-hand slot.
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

/**
 * What this page is, in the time someone gives it before deciding to leave.
 *
 * A trader arriving from a Discord link has no idea what a "mandate" is. Three sentences and
 * three terms, then the product.
 */
function Hero() {
  return (
    <Explainer>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-base font-semibold tracking-tight text-txt-hi">
            A prop firm where the rules are a smart contract
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-txt-mid">
            Traders get funded capital with the risk limits written into the contract. Every
            block, the contract checks each account against those limits. Break one and it
            closes your positions and takes the capital back — automatically, in the same
            block. Make money and it pays you out.{" "}
            <span className="text-txt-hi">Nobody can refuse the payout, and nobody has to
            be trusted to enforce the rules</span> — the enforcement function is public, so
            anyone can call it.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2.5">
          <HeroStat k="Every block" v="marked" />
          <HeroStat k="Enforcement" v="permissionless" />
          <HeroStat k="Payout" v="automatic" />
        </div>
      </div>
    </Explainer>
  );
}

function HeroStat({k, v}: {k: string; v: string}) {
  return (
    <div className="rounded-lg border border-edge bg-ink-950/60 px-3 py-2">
      <div className="text-2xs uppercase tracking-[0.12em] text-txt-lo">{k}</div>
      <div className="num mt-0.5 text-xs text-up">{v}</div>
    </div>
  );
}

function MandateStrip({
  mandates,
  selected,
  onSelect,
}: {
  mandates: Mandate[];
  selected: bigint | undefined;
  onSelect: (id: bigint) => void;
}) {
  const {address} = useSession();
  return (
    // Fades at the right edge so a row that continues past the viewport looks scrollable
    // rather than truncated.
    <div className="relative">
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
      {mandates.map((m) => {
        const active = m.state.status === 1;
        const bps = Number(m.headroomBps);
        const tone = !active ? "text-txt-lo" : bps < 150 ? "text-down" : bps < 350 ? "text-warn" : "text-up";
        // Under its floor but not yet marked: anyone can end it right now.
        const enforceable = active && m.liveEquity < m.floor;
        return (
          <button
            key={m.id.toString()}
            onClick={() => onSelect(m.id)}
            className={`group min-w-[205px] shrink-0 rounded-xl border px-3.5 py-3 text-left transition-all duration-150 ${
              selected === m.id
                ? "border-edge-hi bg-ink-850 shadow-panel-lg"
                : "border-edge bg-ink-900 hover:border-edge-hi hover:bg-ink-850"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-2xs tracking-[0.1em] text-txt-lo">
                MANDATE #{m.id.toString()}
                {address && m.state.trader.toLowerCase() === address.toLowerCase() && (
                  <span className="rounded bg-white/[0.07] px-1 py-px text-[0.6rem] text-txt-mid">
                    YOURS
                  </span>
                )}
              </span>
              {enforceable ? (
                <span className="rounded-md border border-down/40 bg-down/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-down">
                  Enforceable
                </span>
              ) : (
                <StatusPill status={m.state.status} />
              )}
            </div>
            <div className="figure font-mono mt-2 text-xl text-txt-hi">{fmtUsd(m.liveEquity)}</div>
            <div className={`num mt-0.5 text-2xs ${tone}`}>
              {active ? `${fmtUsd(m.headroom)} to floor` : BREACH_KIND[m.state.breachKind] ?? "—"}
            </div>
            {active && (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink-800">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    bps < 150 ? "bg-down" : bps < 350 ? "bg-warn" : "bg-up"
                  }`}
                  style={{width: `${Math.max(3, Math.min(100, bps / 50))}%`}}
                />
              </div>
            )}
          </button>
        );
      })}
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-ink-980 to-transparent" />
    </div>
  );
}

function TraderDetail({
  mandate,
  curve,
  curveSource,
  onDone,
}: {
  mandate: Mandate;
  curve: EquityPoint[];
  curveSource: "envio" | "rpc";
  onDone: () => void;
}) {
  const {terms, state} = mandate;
  const active = state.status === 1;
  const pnl = mandate.liveEquity - terms.allocation;
  const bps = Number(mandate.headroomBps);
  const tone = !active ? "neutral" : bps < 150 ? "down" : bps < 350 ? "warn" : "up";

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <EnforceButton mandate={mandate} onDone={onDone} />

        {/* ── the answer ──────────────────────────────────────────────────── */}
        <Panel>
          <div className="grid grid-cols-2 gap-6 p-5 md:grid-cols-4">
            <Stat label="Equity" value={fmtUsd(mandate.liveEquity)} size="xl" />
            {/* The one number this screen exists for. Sized and lit accordingly. */}
            <Stat
              label="Distance to floor"
              value={active ? fmtUsd(mandate.headroom) : "—"}
              sub={active ? `${fmtBps(mandate.headroomBps)} of equity` : BREACH_KIND[state.breachKind]}
              tone={tone as "up" | "down" | "warn" | "neutral"}
              size="hero"
              emphasis={active}
            />
            <Stat
              label="P&L vs allocation"
              value={fmtSigned(pnl)}
              tone={pnl >= 0n ? "up" : "down"}
              size="lg"
            />
            <Stat
              label="Floor"
              value={fmtUsd(mandate.floor)}
              sub={`peak ${fmtUsd(state.highWaterMark)}`}
              size="lg"
            />
          </div>
          <div className="border-t border-edge px-5 py-4">
            <HeadroomBar
              equity={toNum(mandate.liveEquity)}
              floor={toNum(mandate.floor)}
              peak={toNum(state.highWaterMark)}
            />
          </div>
        </Panel>

        {/* ── the screen ──────────────────────────────────────────────────── */}
        <Panel
          title={`Equity vs drawdown floor — mandate #${mandate.id}`}
          right={
            <div className="flex items-center gap-3">
              <Legend />
              <span
                className="text-2xs text-txt-lo"
                title={
                  curveSource === "envio"
                    ? "Full history, indexed by Envio HyperIndex"
                    : "Monad's public RPC caps eth_getLogs at a 100-block range, so this fallback shows only recent history. Run the Envio indexer for the full curve."
                }
              >
                {curve.length} marks ·{" "}
                {curveSource === "envio" ? (
                  <span className="text-up">Envio</span>
                ) : (
                  <span className="text-warn">RPC (recent only)</span>
                )}
              </span>
              <LiveDot on={active} />
            </div>
          }
        >
          <div className="p-3">
            <EquityChart
              points={curve}
              allocation={toNum(terms.allocation)}
              breached={state.status === 2}
            />
          </div>
        </Panel>

        {mandate.positions.length > 0 && <PositionsTable mandate={mandate} />}
      </div>

      {/* ── side rail ─────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <Panel title="Mandate terms" right={<StatusPill status={state.status} />}>
          <div className="divide-y divide-edge px-4 py-1">
            <Field label="Allocation" value={fmtUsd(terms.allocation)} />
            <Field
              label="Max drawdown"
              value={`${fmtPct(terms.maxDrawdownBps)} ${DRAWDOWN_MODE[terms.drawdownMode] ?? ""}`}
            />
            <Field label="Daily loss limit" value={fmtPct(terms.dailyLossBps)} />
            <Field label="Position cap" value={`${terms.maxPositionBps / 10000}x`} />
            <Field label="Profit split" value={`${fmtPct(terms.profitSplitBps)} to trader`} />
            {terms.maxConsistencyBps > 0 && (
              <Field label="Consistency rule" value={`max ${fmtPct(terms.maxConsistencyBps)}`} />
            )}
            {terms.minProfitableDays > 0 && (
              <Field label="Min profitable days" value={String(terms.minProfitableDays)} />
            )}
            <Field label="Daily reset" value={`${String(terms.resetHourUtc).padStart(2, "0")}:00 UTC`} />
            <Field label="Floor touch" value={terms.touchIsBreach ? "breaches" : "survives"} />
            <Field label="Expires" value={fmtCountdown(terms.expiry)} />
          </div>
          <div className="border-t border-edge px-4 py-2.5 text-2xs text-txt-lo">
            Fixed at issuance. There is no function to change them.
          </div>
        </Panel>

        <Panel title="Trade">
          <TradePanel mandate={mandate} onDone={onDone} />
        </Panel>

        <PayoutPanel mandate={mandate} />

        <Panel title="Account">
          <div className="divide-y divide-edge px-4 py-1">
            <Field label="Trader" value={shortAddr(state.trader)} />
            <Field
              label="Account"
              value={
                <a
                  className="underline decoration-ink-600 hover:text-txt-hi"
                  href={explorerAddr(state.account)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(state.account)}
                </a>
              }
            />
            <Field label="Open notional" value={fmtUsd(mandate.notional)} />
            <Field label="Last marked" value={timeAgo(state.lastMarkedAt)} />
            <Field label="Day-start equity" value={fmtUsd(state.dayStartEquity)} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PositionsTable({mandate}: {mandate: Mandate}) {
  return (
    <Panel title="Open positions">
      <table className="w-full text-xs">
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
                <span className={`font-semibold ${p.isLong ? "text-up" : "text-down"}`}>
                  {p.isLong ? "LONG" : "SHORT"}
                </span>
                <span className="ml-2 text-txt-hi">{p.symbol}</span>
              </td>
              <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtSize(p.size)}</td>
              <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtPrice(p.entryPrice)}</td>
              <td className="num px-4 py-2.5 text-right text-txt-hi">{fmtPrice(p.markPrice)}</td>
              <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtUsd(p.margin)}</td>
              <td
                className={`num px-4 py-2.5 text-right ${p.unrealised >= 0n ? "text-up" : "text-down"}`}
              >
                {fmtSigned(p.unrealised)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/** Matches Types.DrawdownMode. */
const DRAWDOWN_MODE: Record<number, string> = {
  0: "static",
  1: "trailing",
  2: "trailing to breakeven",
};

function Legend() {
  const items = [
    {c: "#2ee6a8", l: "equity"},
    {c: "#ff4d5e", l: "floor"},
    {c: "#3d4455", l: "peak"},
  ];
  return (
    <div className="hidden items-center gap-3 sm:flex">
      {items.map((i) => (
        <span key={i.l} className="flex items-center gap-1.5 text-2xs text-txt-lo">
          <span className="h-0.5 w-3 rounded" style={{background: i.c}} />
          {i.l}
        </span>
      ))}
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
