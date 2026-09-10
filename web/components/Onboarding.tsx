"use client";

import {useEffect, useState} from "react";
import Link from "next/link";
import {formatEther} from "viem";
import {publicClient, ADDR, hasDemoIssuer} from "@/lib/chain";
import {useSession} from "@/lib/useSession";
import {usePolled, type Mandate} from "@/lib/data";

/**
 * The guided path for someone who just opened a link and has no idea what this is.
 *
 * Written for a specific reader: a funded trader who arrived from a Discord message, has a
 * wallet, has never heard of Monad, and will close the tab in about fifteen seconds if the
 * page does not tell them what to do. Every step is a single action with a button that
 * performs it, and each one detects its own completion from chain state rather than asking
 * the reader to tick anything.
 *
 * It disappears once the last step is done, and can be dismissed before that. Onboarding that
 * will not go away is a nag.
 */

const FAUCET = "https://faucet.monad.xyz";
const DISMISS_KEY = "mandate.onboarding.dismissed";

type Step = {
  n: number;
  title: string;
  body: string;
  done: boolean;
  action?: {label: string; onClick?: () => void; href?: string; external?: boolean};
};

export function Onboarding({mandates}: {mandates: Mandate[]}) {
  const {address, signedIn, signIn, signingIn} = useSession();
  const [dismissed, setDismissed] = useState(true); // assume hidden until localStorage says otherwise

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const {data: gas} = usePolled(async () => {
    if (!address) return 0n;
    return publicClient.getBalance({address});
  }, 10_000, [address]);

  const mine = address
    ? mandates.filter((m) => m.state.trader.toLowerCase() === address.toLowerCase())
    : [];
  const active = mine.find((m) => m.state.status === 1);

  const hasGas = (gas ?? 0n) > 0n;
  const hasMandate = mine.length > 0;
  const hasPosition = Boolean(active && active.positions.length > 0);

  const steps: Step[] = [
    {
      n: 1,
      title: "Sign in",
      body: "Connect a wallet on Monad testnet and sign one message. It costs nothing and moves no funds — it just proves the address is yours.",
      done: signedIn,
      action: signedIn ? undefined : {label: signingIn ? "Check your wallet…" : "Sign in", onClick: signIn},
    },
    {
      n: 2,
      title: "Get testnet MON for gas",
      body: "Monad testnet gas is free from the faucet. You need a little to send transactions. This is play money — there is no real value anywhere in this app.",
      done: hasGas,
      action: hasGas ? undefined : {label: "Open the faucet", href: FAUCET, external: true},
    },
    {
      n: 3,
      title: "Get funded",
      body: "Take an offer from the market, or claim a demo mandate. You receive trading capital with the risk limits written into the contract — max drawdown, daily loss, position cap, profit split.",
      done: hasMandate,
      action: hasMandate ? undefined : {label: "Browse offers", href: "/market"},
    },
    {
      n: 4,
      title: "Place a trade",
      body: "Long or short BTC, ETH or SOL with the capital. The contract checks every order against your position cap before it fills, and refuses anything that breaks your terms.",
      done: hasPosition,
    },
    {
      n: 5,
      title: "Watch your floor",
      body: "The big red number is how far you are from being shut down. It updates every block. Cross it and the contract closes your position and takes the capital back — automatically, and anyone can trigger it.",
      done: hasPosition && Boolean(active && active.headroomBps > 0n),
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const complete = doneCount === steps.length;

  if (dismissed || complete) return null;

  const current = steps.find((s) => !s.done);

  return (
    <div className="relative overflow-hidden rounded-xl border border-edge bg-gradient-to-b from-ink-850 to-ink-900 shadow-panel-lg">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-txt-hi">
            Start here
          </h2>
          <span className="num text-2xs text-txt-lo">
            {doneCount} of {steps.length}
          </span>
        </div>
        <button
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* private window — dismissal just won't persist */
            }
          }}
          className="text-2xs text-txt-lo transition-colors hover:text-txt-hi"
        >
          dismiss
        </button>
      </div>

      {/* Progress rail */}
      <div className="h-0.5 w-full bg-ink-800">
        <div
          className="h-full bg-up transition-all duration-700 ease-out"
          style={{width: `${(doneCount / steps.length) * 100}%`}}
        />
      </div>

      <ol className="divide-y divide-edge">
        {steps.map((s) => {
          const isCurrent = current?.n === s.n;
          return (
            <li
              key={s.n}
              className={`flex gap-4 px-5 transition-colors ${
                isCurrent ? "bg-white/[0.02] py-3.5" : "py-2.5"
              }`}
            >
              <div
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold ${
                  s.done
                    ? "border-up/40 bg-up/15 text-up"
                    : isCurrent
                      ? "border-edge-hi bg-ink-800 text-txt-hi"
                      : "border-edge bg-ink-950 text-txt-lo"
                }`}
              >
                {s.done ? "✓" : s.n}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className={`text-xs font-medium ${
                    s.done
                      ? "text-txt-mid line-through decoration-txt-lo/50"
                      : isCurrent
                        ? "text-txt-hi"
                        : "text-txt-mid"
                  }`}
                >
                  {s.title}
                </div>
                {/* Only the step you are on explains itself. Showing all five at once buried
                    the rest of the page below the fold and gave a reader five things to
                    read when they need one. */}
                {isCurrent && (
                  <p className="mt-1 text-2xs leading-relaxed text-txt-mid">{s.body}</p>
                )}
              </div>

              {s.action && isCurrent && (
                <div className="shrink-0 self-center">
                  {s.action.href ? (
                    s.action.external ? (
                      <a
                        href={s.action.href}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-up whitespace-nowrap"
                      >
                        {s.action.label}
                      </a>
                    ) : (
                      <Link href={s.action.href} className="btn btn-up whitespace-nowrap">
                        {s.action.label}
                      </Link>
                    )
                  ) : (
                    <button onClick={s.action.onClick} className="btn btn-up whitespace-nowrap">
                      {s.action.label}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!hasDemoIssuer && (
        <div className="border-t border-edge px-5 py-2.5 text-2xs text-txt-lo">
          Demo mandates are not available on this deployment — take an offer from the market
          instead.
        </div>
      )}
    </div>
  );
}
