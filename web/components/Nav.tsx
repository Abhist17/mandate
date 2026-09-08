"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useWallet} from "@/lib/useWallet";
import {shortAddr} from "@/lib/format";
import {CHAIN_ID} from "@/lib/chain";

export function Nav() {
  const path = usePathname();
  const {address, wrongChain, available, connecting, connect, switchChain} = useWallet();

  const tabs = [
    {href: "/", label: "Trader"},
    {href: "/lp", label: "Liquidity"},
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-edge bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] items-center gap-6 px-4 py-2.5">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight text-txt-hi">MANDATE</span>
          <span className="hidden text-2xs text-txt-lo sm:inline">the rules are the contract</span>
        </Link>

        <div className="flex gap-1">
          {tabs.map((t) => {
            const active = path === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  active ? "bg-ink-800 text-txt-hi" : "text-txt-mid hover:text-txt-hi"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {wrongChain && (
            <button onClick={() => void switchChain()} className="btn btn-down">
              Switch to Monad testnet
            </button>
          )}
          {!available ? (
            <span className="text-2xs text-txt-lo">No wallet detected</span>
          ) : address ? (
            <span className="num rounded border border-edge bg-ink-900 px-2.5 py-1 text-xs text-txt-mid">
              {shortAddr(address)}
            </span>
          ) : (
            <button onClick={() => void connect()} disabled={connecting} className="btn">
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          <span className="hidden text-2xs text-txt-lo md:inline">chain {CHAIN_ID}</span>
        </div>
      </div>
    </nav>
  );
}
