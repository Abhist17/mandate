"use client";

import {StatusPill} from "@/components/ui";
import {explorerAddr, BREACH_KIND} from "@/lib/chain";
import {fmtUsd, fmtPct, fmtCountdown, shortAddr, timeAgo} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * The account card.
 *
 * Every funded-trading dashboard carries one of these in the right rail: status, account
 * number, size, split, and the parameters the account was opened under, as a flat list of
 * label-and-value rows. It is the panel a trader checks when they want to remember what
 * they agreed to.
 *
 * The line at the bottom is the part a prop firm cannot write. These terms were fixed when
 * the mandate was issued and there is no function anywhere in the system that edits them —
 * not for the trader, not for the backer, not for us.
 */

const MODE = ["Static", "Trailing", "Trailing to breakeven"];

export function MandateCard({mandate}: {mandate: Mandate}) {
  const {terms, state} = mandate;
  const active = state.status === 1;
  const split = terms.profitSplitBps / 100;

  return (
    <section className="panel rise rise-1">
      <header className="panel-head">
        <h2 className="panel-title">Mandate</h2>
        <StatusPill status={state.status} />
      </header>

      <div className="divide-y divide-edge px-4">
        <Row label="Mandate" value={`#${mandate.id.toString()}`} />
        <Row label="Issued" value={timeAgo(state.issuedAt)} />
        <Row label="Size" value={fmtUsd(terms.allocation)} />

        {/* The split gets a bar because it is the only row that is a ratio, and a ratio
            drawn is a ratio understood a beat faster than a ratio spelled. */}
        <div className="py-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-xs text-txt-mid">Profit split</span>
            <span className="num text-xs text-txt-hi">{split.toFixed(0)}:{(100 - split).toFixed(0)}</span>
          </div>
          <div className="mt-2 flex h-1 w-full overflow-hidden rounded-full bg-ink-800">
            <div className="h-full bg-acc" style={{width: `${split}%`}} />
          </div>
          <div className="mt-1.5 flex justify-between text-[0.6rem] text-txt-lo">
            <span>you</span>
            <span>backer</span>
          </div>
        </div>

        <Row label="Drawdown" value={`${fmtPct(terms.maxDrawdownBps)} · ${MODE[terms.drawdownMode]}`} />
        <Row label="Daily loss" value={fmtPct(terms.dailyLossBps)} />
        <Row label="Position cap" value={`${terms.maxPositionBps / 10_000}× allocation`} />
        <Row label="Daily reset" value={`${String(terms.resetHourUtc).padStart(2, "0")}:00 UTC`} />
        <Row label="Floor touch" value={terms.touchIsBreach ? "breaches" : "survives"} />
        <Row
          label={active ? "Expires" : "Ended"}
          value={active ? fmtCountdown(terms.expiry) : (BREACH_KIND[state.breachKind] ?? "—")}
        />
        <Row label="Trader" value={shortAddr(state.trader)} />
        <Row
          label="Account"
          value={
            <a
              className="underline decoration-ink-600 underline-offset-2 transition-colors hover:text-acc-hi"
              href={explorerAddr(state.account)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(state.account)}
            </a>
          }
        />
      </div>

      <div className="border-t border-edge px-4 py-3 text-2xs leading-relaxed text-txt-lo">
        Fixed at issuance. There is no function to change them — not for us either.
      </div>
    </section>
  );
}

function Row({label, value}: {label: string; value: React.ReactNode}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="text-xs text-txt-mid">{label}</span>
      <span className="num text-xs text-txt-hi">{value}</span>
    </div>
  );
}
