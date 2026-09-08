"use client";

import {Panel} from "@/components/ui";
import {fmtUsd, fmtBps, fmtPct} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * Payout eligibility.
 *
 * This panel is the argument. A prop firm computes your consistency score on their server,
 * from their record of your trades, and tells you the answer — and the consistency rule, not
 * the drawdown, is what payouts actually get denied on. Here every input is public state and
 * every number is a view function anybody can call and re-derive from events.
 *
 * So the panel deliberately shows the *working*, not just the verdict: the biggest winning
 * day, the total profit, the division, and the threshold it is measured against. A green tick
 * with no arithmetic behind it would be the same black box with nicer colours.
 */

const BLOCK_LABEL: Record<number, string> = {
  1: "Consistency score too high",
  2: "Not enough profitable days",
  3: "Too close to the floor",
};

export function PayoutPanel({mandate}: {mandate: Mandate}) {
  const {terms, state} = mandate;
  const inProfit = mandate.liveEquity > terms.allocation;
  const profit = inProfit ? mandate.liveEquity - terms.allocation : 0n;

  const hasConditions =
    terms.maxConsistencyBps > 0 || terms.minProfitableDays > 0 || terms.payoutCushionBps > 0;

  if (!hasConditions) {
    return (
      <Panel title="Payout conditions">
        <div className="px-4 py-4 text-xs leading-relaxed text-txt-mid">
          This mandate has no payout conditions. Profit can be withdrawn at any time at the{" "}
          <span className="num text-txt-hi">{fmtPct(terms.profitSplitBps)}</span> split.
        </div>
      </Panel>
    );
  }

  const consistencyOk =
    terms.maxConsistencyBps === 0 || Number(mandate.consistencyBps) <= terms.maxConsistencyBps;
  const daysOk =
    terms.minProfitableDays === 0 || state.profitableDays >= terms.minProfitableDays;

  return (
    <Panel
      title="Payout conditions"
      right={
        <span
          className={`rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
            mandate.payoutOk
              ? "border-up/30 bg-up/10 text-up"
              : "border-warn/30 bg-warn/10 text-warn"
          }`}
        >
          {mandate.payoutOk ? "Eligible" : "Withheld"}
        </span>
      }
    >
      <div className="space-y-3 p-4">
        {!inProfit && (
          <p className="text-2xs leading-relaxed text-txt-lo">
            Not in profit, so there is nothing to withhold. Conditions apply only to a payout.
          </p>
        )}

        {terms.maxConsistencyBps > 0 && (
          <div>
            <Row
              label="Consistency score"
              value={fmtBps(mandate.consistencyBps)}
              limit={`max ${fmtPct(terms.maxConsistencyBps)}`}
              ok={consistencyOk}
            />
            {/* The working, shown. This is the whole point of the panel. */}
            <div className="mt-1.5 rounded border border-edge bg-ink-950 px-2.5 py-2 text-2xs text-txt-lo">
              <div className="flex justify-between">
                <span>biggest winning day</span>
                <span className="num text-txt-mid">{fmtUsd(state.largestDailyGain)}</span>
              </div>
              <div className="flex justify-between">
                <span>÷ total profit</span>
                <span className="num text-txt-mid">{fmtUsd(profit)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-edge pt-1">
                <span>= score</span>
                <span className={`num ${consistencyOk ? "text-up" : "text-warn"}`}>
                  {fmtBps(mandate.consistencyBps)}
                </span>
              </div>
            </div>
          </div>
        )}

        {terms.minProfitableDays > 0 && (
          <Row
            label="Profitable days"
            value={`${state.profitableDays} of ${state.tradingDays}`}
            limit={`min ${terms.minProfitableDays}`}
            ok={daysOk}
          />
        )}

        {terms.payoutCushionBps > 0 && (
          <Row
            label="Cushion above floor"
            value={fmtUsd(mandate.headroom)}
            limit={`min ${fmtPct(terms.payoutCushionBps)} of allocation`}
            ok={mandate.payoutOk || mandate.payoutBlock !== 3}
          />
        )}

        {!mandate.payoutOk && mandate.payoutBlock !== 0 && (
          <p className="text-2xs leading-relaxed text-warn">
            {BLOCK_LABEL[mandate.payoutBlock] ?? "A payout condition is unmet"}. The mandate
            stays open — keep trading and it clears. Nobody can override this, including the
            pool operator.
          </p>
        )}

        <p className="border-t border-edge pt-2.5 text-2xs leading-relaxed text-txt-lo">
          Every number here is a view function over public state. Re-derive it from the
          mandate&rsquo;s <span className="num">EquityMarked</span> events and check ours
          matches — that is the difference between this and a support ticket.
        </p>
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  limit,
  ok,
}: {
  label: string;
  value: string;
  limit: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-txt-mid">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className={`num text-xs ${ok ? "text-up" : "text-warn"}`}>{value}</span>
        <span className="text-2xs text-txt-lo">{limit}</span>
      </span>
    </div>
  );
}
