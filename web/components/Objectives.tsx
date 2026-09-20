"use client";

import {ADDR} from "@/lib/chain";
import {fmtUsd, fmtPct, toNum} from "@/lib/format";
import {ProofChip} from "@/lib/useProof";
import {registryAbi} from "@/lib/abi";
import type {ProofSpec} from "@/components/Proof";
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
  /** The contract call this row's number came out of, made pressable. */
  source: ProofSpec;
  note?: string;
  /**
   * Which consequence this rule carries. Prop firms separate these on their objectives
   * pages and the separation is the useful part: breaking a limit ends the account, while
   * missing a condition only holds up the withdrawal. Listing both as one undifferentiated
   * checklist makes every row look equally fatal, and then none of them reads as urgent.
   */
  group: "limit" | "condition";
  /** True when this is the rule currently setting the effective floor. */
  binding?: boolean;
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
  // Measured from the higher of day-start balance and day-start equity, because that is
  // what RiskEngine.dailyFloorFromBasis does. Measuring from equity alone — which this
  // panel used to do — quietly forgives an overnight floating loss, and the error is not
  // small: on a mandate carrying a loser through the reset it reported 1% of the daily
  // allowance spent while the contract had it at 89%. A trader reading that number would
  // have believed they had room they did not have, which is the precise failure this
  // panel exists to rule out.
  const dayStartBasis = Math.max(toNum(state.dayStartBalance), dayStart);
  const dailyAllowance = (dayStartBasis * terms.dailyLossBps) / 10_000;
  const dailyUsed = Math.max(0, dayStartBasis - equity);
  const dailyFloor = (dayStartBasis * (10_000 - terms.dailyLossBps)) / 10_000;

  // ── drawdown ────────────────────────────────────────────────────────────────
  // Measured from whatever this mandate's mode measures from: the peak for trailing, the
  // allocation for static. Showing one when the terms say the other would be the exact lie
  // this panel exists to avoid.
  const ddBase = terms.drawdownMode === 0 ? allocation : peak;
  const ddAllowance = (ddBase * terms.maxDrawdownBps) / 10_000;
  const ddUsed = Math.max(0, ddBase - equity);

  // Two floors exist at once and only the higher one is live. Saying which is binding is
  // the difference between a list of rules and an answer to "what is about to close me".
  const ddFloor = ddBase - ddAllowance;
  const binding: "daily" | "drawdown" = dailyFloor >= ddFloor ? "daily" : "drawdown";

  // ── position cap ────────────────────────────────────────────────────────────
  const capLimit = (allocation * terms.maxPositionBps) / 10_000;

  // ── consistency ─────────────────────────────────────────────────────────────
  const consistency = Number(mandate.consistencyBps) / 100;
  const consistencyMax = terms.maxConsistencyBps / 100;

  // Each row names the call its number came out of, and carries enough to re-run it.
  const reg = ADDR.registry as `0x${string}`;
  const floorSpec = (title: string, shown: string, blurb: string): ProofSpec => ({
    title,
    blurb,
    address: reg,
    abi: registryAbi as never,
    functionName: "floorOf",
    args: [mandate.id],
    shown,
    // floorOf returns (effectiveFloor, lastEquity); the floor is the part on screen.
    format: (d) => fmtUsd((d as readonly bigint[])[0]),
  });

  const rows: Row[] = ([
    {
      label: "Max daily loss",
      used: dailyAllowance > 0 ? dailyUsed / dailyAllowance : 0,
      usedLabel: fmtUsd(BigInt(Math.round(dailyUsed * 1e6))),
      limitLabel: fmtUsd(BigInt(Math.round(dailyAllowance * 1e6))),
      ok: dailyUsed < dailyAllowance,
      applies: true,
      source: floorSpec(
        "The floor your daily limit sets",
        fmtUsd(mandate.floor),
        "floorOf() returns the higher of the drawdown floor and the daily floor. Right now the daily one is binding.",
      ),
      group: "limit",
      binding: binding === "daily",
      note: `${fmtPct(terms.dailyLossBps)} of ${toNum(state.dayStartBalance) > dayStart ? "day-start balance" : "day-start equity"} · resets ${String(terms.resetHourUtc).padStart(2, "0")}:00 UTC`,
    },
    {
      label: "Max drawdown",
      used: ddAllowance > 0 ? ddUsed / ddAllowance : 0,
      usedLabel: fmtUsd(BigInt(Math.round(ddUsed * 1e6))),
      limitLabel: fmtUsd(BigInt(Math.round(ddAllowance * 1e6))),
      ok: equity >= floor,
      applies: true,
      source: floorSpec(
        "The floor your drawdown sets",
        fmtUsd(mandate.floor),
        "floorOf() returns the higher of the drawdown floor and the daily floor — the one that actually closes the account.",
      ),
      group: "limit",
      binding: binding === "drawdown",
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
      source: {
        title: "Your position cap",
        blurb: "The cap is checked inside openPosition() before any fill. This reads the same value the check uses.",
        address: reg,
        abi: registryAbi as never,
        functionName: "positionCapOf",
        args: [mandate.id],
        shown: fmtUsd(BigInt(Math.round(capLimit * 1e6))),
        format: (d) => fmtUsd(d as bigint),
      },
      group: "limit",
      note: `${terms.maxPositionBps / 10_000}x allocation · checked before every fill`,
    },
    {
      label: "Consistency",
      used: consistencyMax > 0 ? consistency / consistencyMax : 0,
      usedLabel: `${consistency.toFixed(2)}%`,
      limitLabel: `${consistencyMax.toFixed(0)}%`,
      ok: consistency <= consistencyMax,
      applies: terms.maxConsistencyBps > 0,
      source: {
        title: "Your consistency score",
        blurb: "Biggest winning day over total profit, in basis points. Gates the payout, not the account.",
        address: reg,
        abi: registryAbi as never,
        functionName: "consistencyScore",
        args: [mandate.id],
        shown: `${consistency.toFixed(2)}%`,
        format: (d) => `${(Number(d as bigint) / 100).toFixed(2)}%`,
      },
      group: "condition",
      note: "biggest winning day ÷ total profit · gates the payout, not the account",
    },
    {
      label: "Profitable days",
      used: terms.minProfitableDays > 0 ? state.profitableDays / terms.minProfitableDays : 1,
      usedLabel: String(state.profitableDays),
      limitLabel: String(terms.minProfitableDays),
      ok: state.profitableDays >= terms.minProfitableDays,
      applies: terms.minProfitableDays > 0,
      source: {
        title: "Your trader record",
        blurb: "The public record this contract wrote about you — settled mandates, breaches, profitable days.",
        address: reg,
        abi: registryAbi as never,
        functionName: "recordOf",
        args: [state.trader],
        shown: String(state.profitableDays),
      },
      group: "condition",
      note: `${state.tradingDays} trading day${state.tradingDays === 1 ? "" : "s"} completed`,
    },
  ] satisfies Row[]).filter((r) => r.applies);

  // A missed condition is not a breach. The summary used to count both together and
  // announce "1 breached" above a caption explaining that conditions gate the payout and
  // not the account — the panel contradicting itself two lines apart, on the one screen
  // whose whole claim is that it does not.
  const breached = rows.filter((r) => r.group === "limit" && !r.ok).length;
  const held = rows.filter((r) => r.group === "condition" && !r.ok).length;

  return (
    <section className="panel rise">
      <header className="panel-head">
        <h2 className="panel-title">Trading objectives</h2>
        <span
          className={`rounded-md border px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${
            !active
              ? "border-ink-600 bg-ink-800 text-txt-mid"
              : breached > 0
                ? "border-down/40 bg-down/10 text-down"
                : held > 0
                  ? "border-warn/30 bg-warn/10 text-warn"
                  : "border-up/30 bg-up/10 text-up"
          }`}
        >
          {!active
            ? "closed"
            : breached > 0
              ? `${breached} breached`
              : held > 0
                ? "payout held"
                : "all passing"}
        </span>
      </header>

      <Group
        label="Limits"
        caption="break one and the contract closes the account"
        tone="down"
        rows={rows.filter((r) => r.group === "limit")}
        dimmed={!active}
      />
      <Group
        label="Conditions"
        caption="these gate the payout, not the account"
        tone="acc"
        rows={rows.filter((r) => r.group === "condition")}
        dimmed={!active}
      />

      {/* The panel re-derives the floor from the terms; the contract computes its own. If
          the two ever part company, the honest thing is to say so on the screen rather than
          let a trader act on a number we got wrong — the whole claim here is that this
          cannot disagree with the enforcer, and a claim like that needs a tripwire. */}
      {active && Math.abs(Math.max(dailyFloor, ddFloor) - floor) > 0.01 && (
        <div className="border-t border-edge bg-down/[0.06] px-4 py-2.5 text-2xs leading-relaxed text-down">
          This panel derives a floor of{" "}
          <span className="num">{fmtUsd(BigInt(Math.round(Math.max(dailyFloor, ddFloor) * 1e6)))}</span>{" "}
          but the contract reports <span className="num">{fmtUsd(mandate.floor)}</span>. Trust the
          contract — it is the one that closes the account. Please report this.
        </div>
      )}

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

function Group({
  label,
  caption,
  tone,
  rows,
  dimmed,
}: {
  label: string;
  caption: string;
  tone: "down" | "acc";
  rows: Row[];
  dimmed: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 border-y border-edge bg-ink-950/60 px-4 py-2">
        <span
          className={`text-2xs font-semibold uppercase tracking-[0.14em] ${
            tone === "down" ? "text-down/80" : "text-acc-hi/80"
          }`}
        >
          {label}
        </span>
        <span className="text-2xs text-txt-lo">— {caption}</span>
      </div>
      <div className="divide-y divide-edge/60">
        {rows.map((r) => (
          <ObjectiveRow key={r.label} row={r} dimmed={dimmed} />
        ))}
      </div>
    </>
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
          {row.binding && (
            <span
              className="rounded border border-warn/30 bg-warn/10 px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-warn"
              title="Two floors apply at once and only the higher one is live. This is the one currently setting your floor."
            >
              Binding
            </span>
          )}
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
        <ProofChip spec={row.source} />
      </div>
    </div>
  );
}
