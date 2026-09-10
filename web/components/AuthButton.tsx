"use client";

import {useState} from "react";
import {useSession} from "@/lib/useSession";
import {shortAddr} from "@/lib/format";
import {CHAIN_ID} from "@/lib/chain";

/**
 * Connect → sign in → signed in.
 *
 * Kept as three visible steps rather than collapsed into one button, because they are three
 * different consents: exposing an address, proving control of it, and staying signed in. A
 * wallet prompt that appears without the user asking is how people learn to click through
 * prompts without reading them, and this app asks them to sign transactions that move money.
 */
export function AuthButton() {
  const {
    address, session, signedIn, signingIn, loading, error,
    available, connecting, wrongChain, connect, switchChain, signIn, signOut,
  } = useSession();
  const [menu, setMenu] = useState(false);

  if (wrongChain) {
    return (
      <button onClick={() => void switchChain()} className="btn btn-down">
        Switch to Monad testnet
      </button>
    );
  }

  if (!available) {
    return (
      <a
        href="https://ethereum.org/en/wallets/find-wallet/"
        target="_blank"
        rel="noreferrer"
        className="text-2xs text-txt-lo underline hover:text-txt-mid"
      >
        No wallet detected
      </a>
    );
  }

  if (loading) {
    return <span className="text-2xs text-txt-lo">…</span>;
  }

  if (!address) {
    return (
      <button onClick={() => void connect()} disabled={connecting} className="btn">
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  if (!signedIn) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="hidden text-2xs text-down sm:inline">{error}</span>}
        <span className="num hidden text-2xs text-txt-lo md:inline">{shortAddr(address)}</span>
        <button onClick={() => void signIn()} disabled={signingIn} className="btn btn-up font-medium">
          {signingIn ? "Check your wallet…" : "Sign in"}
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setMenu((m) => !m)}
        className="num flex items-center gap-2 rounded-lg border border-edge bg-ink-900 px-3 py-1.5 text-xs text-txt-mid transition-colors hover:border-edge-hi"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-up shadow-glow" />
        {shortAddr(session!.address)}
      </button>

      {menu && (
        <>
          {/* Click-away layer, so the menu closes without a document listener. */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute right-0 z-50 mt-2 w-60 rounded-xl border border-edge bg-ink-900 p-3 shadow-panel-lg">
            <div className="text-2xs uppercase tracking-[0.12em] text-txt-lo">Signed in</div>
            <div className="num mt-1 break-all text-2xs text-txt-hi">{session!.address}</div>
            <div className="mt-2 space-y-1 border-t border-edge pt-2 text-2xs text-txt-lo">
              <div className="flex justify-between">
                <span>Network</span>
                <span className="num">chain {CHAIN_ID}</span>
              </div>
              <div className="flex justify-between">
                <span>Session ends</span>
                <span className="num">
                  {new Date(session!.expiresAt * 1000).toLocaleDateString("en-GB")}
                </span>
              </div>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-txt-lo">
              Signing in is a signature, not a transaction. It never moves funds.
            </p>
            <button
              onClick={() => {
                setMenu(false);
                void signOut();
              }}
              className="btn mt-3 w-full"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
