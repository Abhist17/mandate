"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useMandates} from "@/lib/useMandates";
import {useSession} from "@/lib/useSession";
import {fmtUsd} from "@/lib/format";
import {explorerAddr, ADDR} from "@/lib/chain";
import type {Mandate} from "@/lib/data";

/**
 * The account rail.
 *
 * Every funded-trading dashboard is built the same way — a persistent left rail holding the
 * one primary action, the sections of the product, and the list of accounts you can switch
 * between — and it is built that way because a trader runs several accounts at once and the
 * question "which one am I looking at" has to be answerable without leaving the screen.
 *
 * The switcher shows each mandate's live equity and how close it is to its floor, so the
 * account that needs attention is visible from whichever account you happen to be on.
 */

const NAV = [
  {href: "/trade", label: "Account overview", icon: GaugeIcon},
  {href: "/market", label: "Underwriting", icon: BookIcon},
  {href: "/lp", label: "Liquidity", icon: LayersIcon},
];

export function Sidebar() {
  const path = usePathname();
  const {mandates, selected, select} = useMandates();
  const {address} = useSession();

  const mine = address
    ? mandates?.filter((m) => m.state.trader.toLowerCase() === address.toLowerCase())
    : undefined;
  const others = mandates?.filter((m) => !mine?.some((x) => x.id === m.id)) ?? [];

  return (
    <aside className="hidden w-[248px] shrink-0 border-r border-edge bg-ink-950 lg:flex lg:flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
        <Link
          href="/#get-funded"
          className="flex items-center justify-center gap-2 rounded-lg bg-acc px-3 py-2.5 text-xs font-semibold
                     text-white shadow-[0_6px_20px_-8px_rgba(47,125,251,0.9)] transition-colors hover:bg-acc-hi"
        >
          <PlusIcon /> New mandate
        </Link>

        <Section label="Main menu">
          {NAV.map(({href, label, icon: Icon}) => {
            const active = path === href;
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs transition-colors ${
                  active
                    ? "bg-acc/10 font-medium text-acc-hi"
                    : "text-txt-mid hover:bg-white/[0.03] hover:text-txt-hi"
                }`}
              >
                {active && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-acc" />
                )}
                <Icon />
                {label}
              </Link>
            );
          })}
        </Section>

        {(mine?.length || others.length > 0) && (
          <Section label={mine?.length ? "Your mandates" : "Mandates"}>
            {mine?.map((m) => (
              <MandateRow key={m.id.toString()} m={m} on={selected === m.id} onClick={() => select(m.id)} />
            ))}
            {mine?.length && others.length > 0 ? (
              <div className="px-3 pb-1 pt-3 text-[0.6rem] uppercase tracking-[0.14em] text-txt-lo">
                Everyone else
              </div>
            ) : null}
            {others.slice(0, 8).map((m) => (
              <MandateRow key={m.id.toString()} m={m} on={selected === m.id} onClick={() => select(m.id)} />
            ))}
          </Section>
        )}
      </div>

      {/* Anchored to the bottom: the escape hatch out of our UI and into the chain itself.
          A dashboard that claims to be verifiable has to say where to go and check. */}
      <div className="border-t border-edge px-3 py-3">
        <a
          href={explorerAddr(ADDR.registry)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-2xs text-txt-lo transition-colors hover:bg-white/[0.03] hover:text-txt-hi"
        >
          <ChainIcon /> Registry on explorer
          <ExternalIcon />
        </a>
      </div>
    </aside>
  );
}

function Section({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div>
      <div className="px-3 pb-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-txt-lo">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function MandateRow({m, on, onClick}: {m: Mandate; on: boolean; onClick: () => void}) {
  const active = m.state.status === 1;
  const bps = Number(m.headroomBps);
  const dot = !active
    ? "bg-ink-500"
    : bps < 150
      ? "bg-down"
      : bps < 350
        ? "bg-warn"
        : "bg-up";
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
        on ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className={`num text-xs ${on ? "text-txt-hi" : "text-txt-mid"}`}>#{m.id.toString()}</span>
      <span className="num ml-auto text-2xs text-txt-lo">{fmtUsd(m.liveEquity)}</span>
    </button>
  );
}

/* ── icons ──────────────────────────────────────────────────────────────────
   Inline rather than a package: three of them, each a handful of paths, against
   a dependency whose tree-shaken bundle would still be larger than this file. */

const S = {width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const};

function GaugeIcon() {
  return (
    <svg {...S} className="shrink-0">
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      <path d="m13.4 10.6 3.6-3.6" />
      <path d="M4.2 18a9 9 0 1 1 15.6 0" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg {...S} className="shrink-0">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5Z" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg {...S} className="shrink-0">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...S} width={13} height={13} strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg {...S} width={13} height={13} className="shrink-0">
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg {...S} width={11} height={11} className="ml-auto shrink-0 opacity-60">
      <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
