"use client";

import Link from "next/link";
import {Replay} from "@/components/Replay";

/**
 * The front door.
 *
 * Before this, a link landed a stranger in a dashboard of numbers with no explanation, behind
 * a wallet, a network switch, a faucet and a keeper that had to be alive. The thing the whole
 * project is about — a contract closing somebody's position because they crossed a line —
 * was the one thing they could not see without doing all of that first.
 *
 * Now it plays on arrival, from a recording of a real breach, and the wallet is asked for only
 * by someone who has decided they want to try it.
 */
export default function Landing() {
  return (
    <div className="mx-auto max-w-5xl space-y-10 py-4 sm:py-8">
      {/* ── the claim ──────────────────────────────────────────────────────── */}
      <header className="rise space-y-5 text-center">
        <p className="text-2xs uppercase tracking-[0.2em] text-txt-lo">
          Onchain prop firm · Monad
        </p>
        <h1 className="text-balance text-3xl font-semibold leading-[1.15] tracking-tight text-txt-hi sm:text-5xl">
          The rules are the contract.
        </h1>
        <p className="mx-auto max-w-2xl text-balance text-sm leading-relaxed text-txt-mid sm:text-base">
          Prop firms give you capital under a rulebook, then decide for themselves whether you
          broke it — and whether you get paid. Here the drawdown, the daily limit and the
          payout conditions are a smart contract.{" "}
          <span className="text-txt-hi">
            Enforcement is a public function, so nobody has to be trusted to apply it.
          </span>
        </p>
      </header>

      {/* ── show, don't tell ───────────────────────────────────────────────── */}
      <section className="rise rise-1 space-y-2">
        <Replay />
        <p className="px-1 text-center text-2xs text-txt-lo">
          Recorded from a real mandate on chain — not a mock-up. The transaction that enforced
          it is linked above.
        </p>
      </section>

      {/* ── what to do next ────────────────────────────────────────────────── */}
      <section className="rise rise-2 grid gap-3 sm:grid-cols-2">
        <Link
          href="/trade"
          className="group rounded-xl border border-up/25 bg-up/[0.05] p-5 transition-all hover:border-up/45 hover:bg-up/[0.08]"
        >
          <div className="text-sm font-semibold text-up">Get funded and trade →</div>
          <p className="mt-1.5 text-2xs leading-relaxed text-txt-mid">
            Claim testnet capital under enforced terms and try to break it. Free, no signup, no
            challenge fee. Takes about two minutes.
          </p>
        </Link>
        <Link
          href="/market"
          className="group rounded-xl border border-edge bg-ink-900 p-5 transition-all hover:border-edge-hi hover:bg-ink-850"
        >
          <div className="text-sm font-semibold text-txt-hi">See what capital pays →</div>
          <p className="mt-1.5 text-2xs leading-relaxed text-txt-mid">
            Backers post offers against the track record they want. Terms get better as your
            record does — and your record travels with you.
          </p>
        </Link>
      </section>

      {/* ── the three claims, each checkable ───────────────────────────────── */}
      <section className="rise rise-3 grid gap-3 sm:grid-cols-3">
        <Claim
          k="Every block"
          t="Marked against live prices"
          d="Equity is re-checked roughly every 400ms against Perpl's oracle. A mark costs about $0.0003 — which is the only reason a loop like this can exist at all."
        />
        <Claim
          k="Anyone"
          t="Can enforce a breach"
          d="markAndEnforce has no access control. An LP, an observer, a rival trader — the rules do not depend on us choosing to apply them."
        />
        <Claim
          k="No discretion"
          t="Including on the payout"
          d="The consistency rule prop firms deny payouts on is a view function here. Read the number yourself and re-derive it from events."
        />
      </section>

      {/* ── the honest part ────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-edge bg-ink-950/60 p-5">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-txt-lo">
          What this is not
        </h2>
        <p className="mt-2 text-2xs leading-relaxed text-txt-mid">
          Testnet only — nothing here has value. Onchain prop firms already exist; Propr,
          Hypernova and Vanta all launched in 2026. What none of them documents is onchain{" "}
          <span className="text-txt-hi">enforcement</span>: they publish immutable rules and
          settle payouts on chain, while the engine that decides whether you breached stays on
          a private server. That engine is the part we built.
        </p>
      </section>
    </div>
  );
}

function Claim({k, t, d}: {k: string; t: string; d: string}) {
  return (
    <div className="rounded-xl border border-edge bg-ink-900 p-4">
      <div className="text-2xs uppercase tracking-[0.12em] text-up">{k}</div>
      <div className="mt-1 text-xs font-medium text-txt-hi">{t}</div>
      <p className="mt-1.5 text-2xs leading-relaxed text-txt-lo">{d}</p>
    </div>
  );
}
