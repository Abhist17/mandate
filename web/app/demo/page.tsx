"use client";

import {useEffect, useState} from "react";
import Link from "next/link";
import {Replay} from "@/components/Replay";
import {CapitalEngine} from "@/components/landing/CapitalEngine";

/**
 * Presentation mode — built to be screen-recorded.
 *
 * The 3-minute demo video carries more of the score than any remaining feature, and recording
 * it off the live dashboard means fighting whatever the chain is doing that minute: a stale
 * feed, an empty wallet, a mandate that will not breach on cue. This runs to a script, hits
 * its marks every time, and needs nothing but a browser.
 *
 * It is not a mock-up. The breach it plays is a recording of a real one, transaction hash and
 * all — the same fixture the landing page uses. What is scripted is the *pacing*, not the
 * data.
 *
 * Press F for fullscreen, space to pause, R to restart.
 */

type Beat = {
  at: number; // seconds
  kicker: string;
  line: string;
  sub?: string;
};

const SCRIPT: Beat[] = [
  {
    at: 0,
    kicker: "The problem",
    line: "A prop firm gives you capital under a rulebook.",
    sub: "Then decides for itself whether you broke it — and whether you get paid.",
  },
  {
    at: 7,
    kicker: "The part nobody sees",
    line: "The risk engine is a private server.",
    sub: "You cannot check the drawdown maths. You cannot check the consistency score they denied you on.",
  },
  {
    at: 15,
    kicker: "Mandate",
    line: "The rules are the contract.",
    sub: "Drawdown, daily limit, position cap, payout conditions — all of it onchain, on Monad.",
  },
  {
    at: 22,
    kicker: "Watch",
    line: "$100,000 under enforced terms.",
    sub: "10% trailing drawdown. 5% daily. The floor is measured from the peak, and it does not move down.",
  },
  {
    at: 31,
    kicker: "The moment",
    line: "Equity crosses the floor.",
    sub: "The contract flattens the position and takes the capital back — in the same transaction.",
  },
  {
    at: 39,
    kicker: "Who did it",
    line: "A wallet with no role in the system.",
    sub: "markAndEnforce has no access control. Not the owner. Not the keeper. Anyone.",
  },
  {
    at: 47,
    kicker: "The enforcement market",
    line: "And whoever enforces a breach is paid for it.",
    sub: "0.25% of the allocation, out of the capital it protects — a liquidation bonus for a rulebook. Nobody has to run our keeper: searchers race for it.",
  },
  {
    at: 56,
    kicker: "Why Monad",
    line: "A mark costs about $0.0003.",
    sub: "Marking every open account every block is only affordable at 400ms and sub-cent gas. That is why the enforcement layer has not been built before.",
  },
  {
    at: 65,
    kicker: "The record",
    line: "Your track record is your application.",
    sub: "Settlement writes it, in the same transaction. Every backer's offer reads it and answers on its own — qualifies, or exactly why not.",
  },
  {
    at: 74,
    kicker: "What's new",
    line: "Not a better prop firm. The market that replaces one.",
    sub: "Enforcement anyone is paid to run. A record nobody can edit. Backers compete on terms. No challenge fees — nobody earns anything when you fail.",
  },
];

const RUNTIME = 84;

export default function DemoPage() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((n) => (n >= RUNTIME ? 0 : n + 0.1)), 100);
    return () => clearInterval(id);
  }, [playing]);

  // `main` carries position:relative + z-index:1, which makes it a stacking context — so a
  // fixed overlay inside it cannot rise above the nav no matter how high its z-index. Hiding
  // the chrome from the body is the fix; raising z-index is not.
  useEffect(() => {
    document.body.classList.add("presenting");
    return () => document.body.classList.remove("presenting");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key.toLowerCase() === "r") setT(0);
      if (e.key.toLowerCase() === "f") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const beat = [...SCRIPT].reverse().find((b) => t >= b.at) ?? SCRIPT[0]!;
  const idx = SCRIPT.indexOf(beat);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-980">
      {/* progress */}
      <div className="h-0.5 w-full bg-ink-800">
        <div
          className="h-full bg-up transition-all duration-100 ease-linear"
          style={{width: `${(t / RUNTIME) * 100}%`}}
        />
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="w-full max-w-4xl space-y-8">
          {/* the line */}
          <div key={idx} className="rise space-y-3 text-center">
            <div className="text-2xs uppercase tracking-[0.22em] text-up">{beat.kicker}</div>
            <h1 className="text-balance text-2xl font-semibold leading-tight tracking-tight text-txt-hi sm:text-4xl">
              {beat.line}
            </h1>
            {beat.sub && (
              <p className="mx-auto max-w-2xl text-balance text-sm leading-relaxed text-txt-mid">
                {beat.sub}
              </p>
            )}
          </div>

          {/* the evidence — starts once the setup has landed, and changes with the argument */}
          <div className={`transition-opacity duration-700 ${t >= 20 ? "opacity-100" : "opacity-0"}`}>
            {t < 47 ? (
              <Replay autoPlay={t >= 20} loop={false} />
            ) : t < 56 ? (
              <BountyBeat key="bounty" />
            ) : t < 65 || t >= 74 ? (
              <div className="rise">
                <CapitalEngine />
              </div>
            ) : (
              <PassportBeat key="passport" />
            )}
          </div>
        </div>
      </div>

      {/* chrome — deliberately quiet, and out of frame at the bottom */}
      <div className="flex items-center justify-between px-5 py-3 text-2xs text-txt-lo">
        <span className="num">
          {String(Math.floor(t / 60)).padStart(2, "0")}:
          {String(Math.floor(t % 60)).padStart(2, "0")} / {String(Math.floor(RUNTIME / 60)).padStart(2, "0")}:
          {String(RUNTIME % 60).padStart(2, "0")}
        </span>
        <span className="hidden sm:inline">space pause · R restart · F fullscreen</span>
        <Link href="/" className="transition-colors hover:text-txt-hi">
          exit
        </Link>
      </div>
    </div>
  );
}

/**
 * The bounty, illustrated. Labelled as an illustration: the recorded breach above happened
 * before the enforcement market existed, so it paid no bounty, and this does not pretend
 * otherwise. The numbers are the deployed ones — 25 bps of a $100,000 allocation.
 */
function BountyBeat() {
  return (
    <div className="rise overflow-hidden rounded-xl border border-edge bg-ink-900 shadow-panel-lg">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-txt-hi">Bounty board</span>
        <span className="rounded border border-edge px-1.5 py-px text-[0.6rem] uppercase tracking-[0.12em] text-txt-lo">illustration</span>
      </div>
      <div className="space-y-4 p-5">
        <div className="num flex items-center gap-3 rounded-lg border border-down/30 bg-down/[0.06] px-4 py-3 text-sm">
          <span className="text-txt-hi">#6</span>
          <span className="text-txt-mid">$94,412.64</span>
          <span className="text-down">below $95,000 floor</span>
          <span className="ml-auto rounded-md border border-down/40 bg-down/10 px-2.5 py-1 text-xs font-semibold text-down">
            Enforce · earn $250.00
          </span>
        </div>
        <div className="num rise rise-3 rounded-lg border border-edge bg-ink-980 p-4 text-xs leading-relaxed text-txt-mid">
          <div>
            <span className="text-acc-hi">markAndEnforce</span>(6) <span className="text-txt-lo">from 0x9f2e…a41c — no role</span>
          </div>
          <div className="mt-1.5 text-txt-lo">→ position flattened, split settled</div>
          <div className="mt-1.5 text-up">→ EnforcementBountyPaid(6, 0x9f2e…a41c, $250.00)</div>
        </div>
        <p className="text-xs leading-relaxed text-txt-lo">
          Paid from the LP side — never the trader&rsquo;s share. The trader is never paid for their own breach.
        </p>
      </div>
    </div>
  );
}

/** The passport, illustrated with the seeded ladder's real rungs and the book's real reasons. */
function PassportBeat() {
  const offers: [string, string, boolean, string][] = [
    ["$25,000", "70%", true, "qualifies — claimable now"],
    ["$50,000", "80%", true, "qualifies — claimable now"],
    ["$100,000", "90%", false, "Not enough settled mandates"],
    ["$250,000", "92%", false, "Not enough settled mandates"],
  ];
  return (
    <div className="rise overflow-hidden rounded-xl border border-edge bg-ink-900 shadow-panel-lg">
      <div className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="num text-sm font-semibold text-txt-hi">0x4b2c…9b0f</span>
        <span className="rounded-md border border-up/30 bg-up/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-up">Clean record</span>
        <span className="ml-auto rounded border border-edge px-1.5 py-px text-[0.6rem] uppercase tracking-[0.12em] text-txt-lo">illustration</span>
      </div>
      <div className="num grid grid-cols-4 gap-3 border-b border-edge px-5 py-4 text-center">
        {[["Settled", "1"], ["Breaches", "0"], ["Profitable", "1"], ["Net", "+$3,520"]].map(([k, v]) => (
          <div key={k}>
            <div className="text-[0.6rem] uppercase tracking-[0.14em] text-txt-lo">{k}</div>
            <div className={`mt-1 text-lg ${k === "Breaches" || k === "Net" || k === "Profitable" ? "text-up" : "text-txt-hi"}`}>{v}</div>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-edge/60">
        {offers.map(([a, split, ok, why], i) => (
          <li key={a} className="rise flex items-center gap-4 px-5 py-2.5 text-xs" style={{animationDelay: `${200 + i * 160}ms`}}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.65rem] ${ok ? "border-up/50 bg-up/10 text-up" : "border-edge text-txt-lo"}`}>{ok ? "✓" : "·"}</span>
            <span className="num text-txt-hi">{a}</span>
            <span className="num text-txt-mid">{split} to trader</span>
            <span className={`ml-auto text-2xs ${ok ? "text-up" : "text-txt-lo"}`}>{why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
