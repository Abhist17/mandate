"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {AuthButton} from "@/components/AuthButton";
import {CHAIN_ID} from "@/lib/chain";

export function Nav() {
  const path = usePathname();

  // The public mandate page is a standalone document with its own header and its own
  // call to action. App chrome on it just offers a stranger three places to get lost.
  if (path.startsWith("/m/") || path.startsWith("/trader/")) return null;

  const tabs = [
    {href: "/trade", label: "Trade"},
    {href: "/enforce", label: "Bounties"},
    {href: "/market", label: "Market"},
    {href: "/lp", label: "Liquidity"},
    {href: "/traders", label: "Traders"},
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-edge bg-ink-980/85 backdrop-blur-md">
      {/* Phones get two rows: logo and wallet on top, tabs underneath in a row that scrolls.
          Crammed onto one line, five destinations and a wallet control wrapped the wallet
          into a clipped column. */}
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:gap-6 sm:px-4 sm:py-3">
        <Link href="/" className="flex items-baseline gap-2.5 transition-opacity hover:opacity-80">
          <span className="text-sm font-semibold tracking-[0.08em] text-txt-hi">MANDATE</span>
          <span className="hidden text-2xs text-txt-lo lg:inline">the rules are the contract</span>
        </Link>

        <div className="ml-auto flex items-center gap-3 sm:order-last">
          <AuthButton />
          <span className="hidden text-2xs text-txt-lo lg:inline">chain {CHAIN_ID}</span>
        </div>

        {/* On a wide screen these live in the sidebar; below lg there is no sidebar, so they
            come back. */}
        <div className="-mx-1 flex w-full gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:w-auto sm:px-0 lg:hidden [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => {
            const active = path === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-all duration-150 sm:px-3 ${
                  active
                    ? "bg-ink-800 text-txt-hi shadow-panel"
                    : "text-txt-mid hover:bg-white/[0.03] hover:text-txt-hi"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
