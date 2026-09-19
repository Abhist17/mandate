"use client";

import {useEffect, useState} from "react";
import Link from "next/link";
import {Replay} from "@/components/Replay";

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
    kicker: "Why Monad",
    line: "A mark costs about $0.0003.",
    sub: "Marking every open account every block is only affordable at 400ms and sub-cent gas. That is why the enforcement layer has not been built before.",
  },
  {
    at: 56,
    kicker: "What's new",
    line: "Not a better prop firm. The market that replaces one.",
    sub: "Your record is written by the contract that enforced it, so it travels. Backers compete on terms. No challenge fees — nobody earns anything when you fail.",
  },
];

const RUNTIME = 66;

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

          {/* the evidence — starts once the setup has landed */}
          <div
            className={`transition-opacity duration-700 ${t >= 20 ? "opacity-100" : "opacity-0"}`}
          >
            <Replay autoPlay={t >= 20} loop={false} />
          </div>
        </div>
      </div>

      {/* chrome — deliberately quiet, and out of frame at the bottom */}
      <div className="flex items-center justify-between px-5 py-3 text-2xs text-txt-lo">
        <span className="num">
          {String(Math.floor(t / 60)).padStart(2, "0")}:
          {String(Math.floor(t % 60)).padStart(2, "0")} / 01:06
        </span>
        <span className="hidden sm:inline">space pause · R restart · F fullscreen</span>
        <Link href="/" className="transition-colors hover:text-txt-hi">
          exit
        </Link>
      </div>
    </div>
  );
}
