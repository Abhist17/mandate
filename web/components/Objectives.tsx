"use client";

import {ADDR} from "@/lib/chain";
import {fmtUsd, fmtPct, toNum} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * Trading Objectives.
 *
 * Every prop firm dashboard has this panel and traders read it constantly, so it is the shape
 * they already know: one row per rule, how much of the allowance is spent, and whether you
 * are still inside it.
 *
 * The difference is what the numbers are. FundingPips' own help page says their dashboard
 * "is for informational purposes only and is not a live representation of performance" —
 * which means the screen you check to see whether you are about to breach is not the thing
 * that decides whether you breached. You can be closed out by a number you were never shown.
 *
 * Every figure below is read from the contract that does the enforcing. Not a mirror of it,
 * not a delayed copy — the same values, from the same functions `markAndEnforce` calls. Each
 * row names the function that produced it so it can be checked independently.
 */

type Row = {
  label: string;
  /** How much of the allowance is used, 0..1. */
  used: number;
  usedLabel: string;
  limitLabel: string;
  ok: boolean;
  /** Null when the rule is not part of these terms. */
  applies: boolean;
  source: string;
  note?: string;
};

export function Objectives({mandate}: {mandate: Mandate}) {
  const {terms, state} = mandate;
  const active = state.status === 1;

  const equity = toNum(mandate.liveEquity);
  const allocation = toNum(terms.allocation);
  const peak = toNum(state.highWaterMark);
  const dayStart = toNum(state.dayStartEquity);
  const floor = toNum(mandate.floor);
  const notional = toNum(mandate.notional);

  // ── daily loss ──────────────────────────────────────────────────────────────
  const dailyAllowance = (dayStart * terms.dailyLossBps) / 10_000;
  const dailyUsed = Math.max(0, dayStart - equity);

  // ── drawdown ────────────────────────────────────────────────────────────────
  // Measured from whatever this mandate's mode measures from: the peak for trailing, the
  // allocation for static. Showing one when the terms say the other would be the exact lie
  // this panel exists to avoid.
  const ddBase = terms.drawdownMode === 0 ? allocation : peak;
  const ddAllowance = (ddBase * terms.maxDrawdownBps) / 10_000;
  const ddUsed = Math.max(0, ddBase - equity);

  // ── position cap ────────────────────────────────────────────────────────────
  const capLimit = (allocation * terms.maxPositionBps) / 10_000;

  // ── consistency ─────────────────────────────────────────────────────────────
  const consistency = Number(mandate.consistencyBps) / 100;
  const consistencyMax = terms.maxConsistencyBps / 100;

  const rows: Row[] = [
    {
      label: "Max daily loss",
      used: dailyAllowance > 0 ? dailyUsed / dailyAllowance : 0,
      usedLabel: fmtUsd(BigInt(Math.round(dailyUsed * 1e6))),
      limitLabel: fmtUsd(BigInt(Math.round(dailyAllowance * 1e6))),
      ok: dailyUsed < dailyAllowance,
      applies: true,
      source: "floorOf()",
      note: `${fmtPct(terms.dailyLossBps)} of day-start equity · resets ${String(terms.resetHourUtc).padStart(2, "0")}:00 UTC`,
    },
    {
      label: "Max drawdown",
      used: ddAllowance > 0 ? ddUsed / ddAllowance : 0,
      usedLabel: fmtUsd(BigInt(Math.round(ddUsed * 1e6))),
      limitLabel: fmtUsd(BigInt(Math.round(ddAllowance * 1e6))),
      ok: equity >= floor,
      applies: true,
      source: "floorOf()",
      note:
        terms.drawdownMode === 0
          ? `${fmtPct(terms.maxDrawdownBps)} static — measured from the allocation, never moves`
          : terms.drawdownMode === 2
            ? `${fmtPct(terms.maxDrawdownBps)} trailing, locks at breakeven — floor ${fmtUsd(mandate.floor)}`
            : `${fmtPct(terms.maxDrawdownBps)} trailing from the peak of ${fmtUsd(state.highWaterMark)}`,
    },
    {
      label: "Position cap",
      used: capLimit > 0 ? notional / capLimit : 0,
      usedLabel: fmtUsd(mandate.notional),
      limitLabel: fmtUsd(BigInt(Math.round(capLimit * 1e6))),
      ok: notional <= capLimit * 1.01,
      applies: true,
      source: "openPosition()",
      note: `${terms.maxPositionBps / 10_000}x allocation · checked before every fill`,
    },
    {
      label: "Consistency",
      used: consistencyMax > 0 ? consistency / consistencyMax : 0,
      usedLabel: `${consistency.toFixed(2)}%`,
      limitLabel: `${consistencyMax.toFixed(0)}%`,
      ok: consistency <= consistencyMax,
      applies: terms.maxConsistencyBps > 0,
      source: "consistencyScore()",
      note: "biggest winning day ÷ total profit · gates the payout, not the account",
    },
    {
      label: "Profitable days",
      used: terms.minProfitableDays > 0 ? state.profitableDays / terms.minProfitableDays : 1,
      usedLabel: String(state.profitableDays),
      limitLabel: String(terms.minProfitableDays),
      ok: state.profitableDays >= terms.minProfitableDays,
      applies: terms.minProfitableDays > 0,
      source: "recordOf()",
      note: `${state.tradingDays} trading day${state.tradingDays === 1 ? "" : "s"} completed`,
    },
  ].filter((r) => r.applies);

  const failing = rows.filter((r) => !r.ok).length;

  return (
    <section className="panel rise">
      <header className="panel-head">
        <h2 className="panel-title">Trading objectives</h2>
        <span
          className={`rounded-md border px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${
            !active
              ? "border-ink-600 bg-ink-800 text-txt-mid"
              : failing === 0
                ? "border-up/30 bg-up/10 text-up"
                : "border-down/40 bg-down/10 text-down"
          }`}
        >
          {!active ? "closed" : failing === 0 ? "all passing" : `${failing} breached`}
        </span>
      </header>

      <div className="divide-y divide-edge/60">
        {rows.map((r) => (
          <ObjectiveRow key={r.label} row={r} dimmed={!active} />
        ))}
      </div>

      <footer className="border-t border-edge px-4 py-2.5">
        <p className="text-2xs leading-relaxed text-txt-lo">
          Every figure here is read from the contract that enforces it — the same functions{" "}
          <span className="num text-txt-mid">markAndEnforce</span> calls, at{" "}
          <a
            href={`https://testnet.monadscan.com/address/${ADDR.registry}`}
            target="_blank"
            rel="noreferrer"
            className="num underline decoration-txt-lo/40 hover:text-txt-hi"
          >
            {ADDR.registry.slice(0, 10)}…
          </a>
          . Not a mirror of it and not a delayed copy. A prop firm&rsquo;s dashboard is
          explicitly &ldquo;not a live representation of performance&rdquo; — this one cannot
          disagree with the thing that closes your account.
        </p>
      </footer>
    </section>
  );
}

function ObjectiveRow({row, dimmed}: {row: Row; dimmed: boolean}) {
  const pct = Math.max(0, Math.min(100, row.used * 100));
  // Amber from 70% of the allowance: a rule you are three-quarters through is worth seeing
  // before it fails, not at the moment it does.
  const tone = !row.ok ? "bg-down" : pct >= 70 ? "bg-warn" : "bg-up";
  const textTone = !row.ok ? "text-down" : pct >= 70 ? "text-warn" : "text-txt-hi";

  return (
    <div className={`px-4 py-3 ${dimmed ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-2xs ${row.ok ? "text-up" : "text-down"}`}
            aria-label={row.ok ? "passing" : "breached"}
          >
            {row.ok ? "✓" : "✕"}
          </span>
          <span className="text-xs font-medium text-txt-hi">{row.label}</span>
        </div>
        <div className="num flex items-baseline gap-1.5 text-xs">
          <span className={textTone}>{row.usedLabel}</span>
          <span className="text-txt-lo">/ {row.limitLabel}</span>
          <span className="w-10 text-right text-2xs text-txt-lo">{pct.toFixed(0)}%</span>
        </div>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-800 ring-1 ring-inset ring-white/[0.04]">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${tone}`}
          style={{width: `${pct}%`}}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-2xs text-txt-lo">{row.note}</span>
        <span className="num text-2xs text-txt-lo/70">{row.source}</span>
      </div>
    </div>
  );
}
