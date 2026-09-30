"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import {Replay} from "@/components/Replay";
import {WordReveal} from "@/components/motion";
import {CapitalEngine} from "@/components/landing/CapitalEngine";
import {HeroBackdrop} from "@/components/landing/HeroBackdrop";
import {MandateSim} from "@/components/landing/MandateSim";
import {FundingPath} from "@/components/landing/FundingPath";

/**
 * The tape is the only part of this page that talks to the chain, and it brings viem with
 * it — about a hundred kilobytes the hero does not need to paint. Loading it as its own
 * chunk after hydration keeps the first paint on the light bundle; the placeholder holds
 * its exact height, so nothing moves when it lands.
 */
const LiveTape = dynamic(() => import("@/components/landing/LiveTape").then((m) => m.LiveTape), {
  ssr: false,
  loading: () => (
    <div className="h-[178px] rounded-xl border border-edge bg-ink-950/70 sm:h-[62px]" aria-hidden="true" />
  ),
});

const EnforcementPreview = dynamic(
  () => import("@/components/landing/EnforcementPreview").then((m) => m.EnforcementPreview),
  {ssr: false, loading: () => <div className="h-[252px] rounded-xl border border-edge bg-ink-900" aria-hidden="true" />},
);

/**
 * The front door, told as one loop.
 *
 *   01  capital in       — the engine: vault to mandate to trader, and the split back
 *   02  enforced         — living under the rules: the floor ratchets, lights, holds
 *   03  closed           — a real breach, recorded on chain: what crossing it does
 *   04  paid             — the enforcement market: whoever enforces is paid for it
 *   05  funded           — how a clean record turns into backed capital
 *   06  verify           — the claims, each one checkable
 *
 * Motion carries the argument rather than decorating it. Every animated element is a step
 * the protocol actually performs, and each section explains itself before it moves. The
 * brief behind it was "a settlement system, not a memecoin launch": nothing loops unless it
 * is a process, and nothing celebrates.
 */
export default function Landing() {
  return (
    <div className="relative mx-auto max-w-5xl space-y-24 py-4 sm:py-8">
      {/* ── 01 · the claim, and the loop behind it ─────────────────────────── */}
      <section className="relative pt-2 sm:pt-4">
        <HeroBackdrop />

        <header className="relative space-y-6 text-center">
          <p className="fade-late text-2xs uppercase tracking-[0.2em] text-txt-lo">Onchain prop firm · Monad</p>
          <h1 className="settle font-display text-balance text-[2.6rem] leading-[1.05] tracking-tight text-txt-hi sm:text-[4.5rem]">
            <WordReveal text="The rules are the contract." start={120} />
          </h1>
          {/* The line the whole product is about, drawn under the sentence that claims it. */}
          <div className="floor-rule floor-rule-draw mx-auto max-w-xl" />
          <p
            className="fade-late mx-auto max-w-2xl text-balance text-sm leading-relaxed text-txt-mid sm:text-base"
            style={{animationDelay: "620ms"}}
          >
            LPs fund traders. The drawdown, the daily limit and the profit split are a smart
            contract on Monad, checked on every mark.{" "}
            <span className="text-txt-hi">
              Enforcement is a public function, so nobody has to be trusted to apply it.
            </span>
          </p>
          <div className="fade-late flex flex-col items-center gap-2.5" style={{animationDelay: "760ms"}}>
            <div className="flex flex-wrap justify-center gap-2.5">
              <Link
                href="/trade"
                className="lift rounded-lg bg-acc px-5 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-10px_rgba(47,125,251,0.9)] hover:bg-acc-hi"
              >
                Get funded and trade
              </Link>
              <Link href="/lp" className="lift btn px-5 py-2.5 text-sm">
                Provide capital
              </Link>
            </div>
            <span className="text-2xs text-txt-lo">Testnet · free · no signup · no challenge fee</span>
          </div>
        </header>

        <div className="fade-late relative mt-8" style={{animationDelay: "900ms"}}>
          <CapitalEngine />
          <p className="mt-1 text-center text-2xs text-txt-lo">
            The loop as a diagram, on the Zero preset&rsquo;s terms. The tape below is live chain
            state.
          </p>
        </div>
        <div className="fade-late relative mt-5" style={{animationDelay: "1050ms"}}>
          <LiveTape />
        </div>
      </section>

      {/* ── 02 · living under the rules ──────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionHead
          index="02"
          kicker="Enforcement"
          title="The floor is a line, and it only moves up."
          body="A trailing drawdown ratchets behind every new peak and never comes back down. The contract checks equity against it on every mark — and when equity gets close, you see it here before it matters."
        />
        <MandateSim />
      </section>

      {/* ── 03 · crossing it ──────────────────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionHead
          index="03"
          kicker="A real breach"
          title="Cross it, and the account closes. In one transaction."
          body="Recorded from a real mandate on chain — not a simulation. The position was flattened and the capital returned to the pool by a wallet with no role in the system, because the function that does it has no access control."
        />
        <Replay still />
        <p className="px-1 text-center text-2xs text-txt-lo">
          <Link href="/demo" className="underline decoration-txt-lo/40 hover:text-txt-hi">
            Watch the full walkthrough →
          </Link>
        </p>
      </section>

      {/* ── 04 · the enforcement market ─────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionHead
          index="04"
          kicker="The enforcement market"
          title="And whoever enforced it was paid."
          body="Lending protocols never trusted a liquidator — they paid a bonus and let searchers race for it. Mandate does the same for a rulebook: the first wallet to enforce a breach earns a share of the allocation, out of the capital it protects. The rules are enforced by whoever gets there first, not by us."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <EnforcementPreview />
          <div className="h-full rounded-xl border border-edge bg-ink-950/60 p-4">
            <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-txt-lo">A searcher&rsquo;s whole job</div>
            <pre className="num mt-3 overflow-x-auto text-[0.68rem] leading-relaxed text-txt-mid">
{`for id in registry.activeMandates():
ok, rule, _, _, bounty =
  registry.previewEnforce(id)
if ok:
  registry.markAndEnforce(id)`}
            </pre>
            <p className="mt-3 text-2xs leading-relaxed text-txt-lo">
              One transaction flattens the book, settles the split and pays the enforcer. The
              trader can never be paid for their own breach, and the bounty never touches their
              share.
            </p>
          </div>
        </div>
      </section>

      {/* ── 05 · from record to capital ──────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionHead
          index="05"
          kicker="The path"
          title="A clean record is the application."
          body="No evaluator and no fee. Settle a starter mandate without breaching and the contract writes your record; a backer's standing offer accepts it on its own terms, and the capital moves."
        />
        <FundingPath />
      </section>

      {/* ── 05 · the claims ──────────────────────────────────────────────────── */}
      <section className="space-y-6">
        <SectionHead index="06" kicker="Checkable" title="Three claims. Each one is a function you can call." />
        <div className="grid gap-3 sm:grid-cols-3">
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
        </div>
      </section>

      {/* ── the honest part ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-edge bg-ink-950/60 p-5">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-txt-lo">What this is not</h2>
        <p className="mt-2 text-2xs leading-relaxed text-txt-mid">
          Testnet only — nothing here has value. Onchain prop firms already exist; Propr,
          Hypernova and Vanta all launched in 2026. What none of them documents is onchain{" "}
          <span className="text-txt-hi">enforcement</span>: they publish immutable rules and
          settle payouts on chain, while the engine that decides whether you breached stays
          on a private server. That engine is the part we built.
        </p>
      </section>
    </div>
  );
}

function SectionHead({index, kicker, title, body}: {index: string; kicker: string; title: string; body?: string}) {
  return (
    <header className="max-w-2xl space-y-2">
      <div className="num flex items-center gap-2 text-2xs uppercase tracking-[0.16em] text-txt-lo">
        <span className="text-acc-hi">{index}</span>
        <span className="h-px w-6 bg-edge-hi" />
        {kicker}
      </div>
      <h2 className="text-balance text-xl font-semibold tracking-tight text-txt-hi sm:text-2xl">{title}</h2>
      {body && <p className="text-sm leading-relaxed text-txt-mid">{body}</p>}
    </header>
  );
}

function Claim({k, t, d}: {k: string; t: string; d: string}) {
  return (
    <div className="lift h-full rounded-xl border border-edge bg-ink-900 p-4 hover:border-edge-hi">
      <div className="text-2xs uppercase tracking-[0.12em] text-up">{k}</div>
      <div className="mt-1 text-xs font-medium text-txt-hi">{t}</div>
      <p className="mt-1.5 text-2xs leading-relaxed text-txt-lo">{d}</p>
    </div>
  );
}
