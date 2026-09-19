"use client";

import {usePathname} from "next/navigation";
import {Sidebar} from "@/components/Sidebar";
import {NetworkGuard} from "@/components/NetworkGuard";
import {FeedStatus} from "@/components/FeedStatus";
import {MandatesProvider} from "@/lib/useMandates";
import {isConfigured} from "@/lib/chain";

/**
 * Two shapes of page, one shell.
 *
 * The landing page and the recorded demo are documents — centred, bounded, read top to
 * bottom. The dashboard is an application: a fixed rail, a fluid workspace, no page footer
 * competing with live numbers for the bottom of the screen. Trying to serve both from one
 * centred `max-w` container is what made the dashboard read as a long marketing page with
 * charts in it rather than as somewhere you work.
 */

/** Routes that are documents, not the application. */
const PLAIN = (path: string) => path === "/" || path.startsWith("/demo");

export function Frame({children}: {children: React.ReactNode}) {
  const path = usePathname();

  const inner = (
    <>
      <FeedStatus />
      <NetworkGuard>{children}</NetworkGuard>
    </>
  );

  if (PLAIN(path)) {
    return (
      <main className="mx-auto max-w-[1500px] space-y-4 px-3 py-4 sm:px-4 sm:py-5">{inner}</main>
    );
  }

  // The provider mounts unconditionally, including when no contract addresses are set and
  // during prerender. Making it conditional meant any page calling useMandates() above its
  // own isConfigured check threw at build time — and a hook that is only sometimes there is
  // a hook every caller has to defend against.
  return (
    <MandatesProvider>
      <div className="flex min-h-[calc(100vh-49px)]">
        {isConfigured && <Sidebar />}
        <main className="min-w-0 flex-1 px-3 py-4 sm:px-5 sm:py-5">
          <div className="mx-auto max-w-[1360px] space-y-4">
            {inner}
            <p className="pt-2 text-2xs leading-relaxed text-txt-lo">
              Monad testnet · markAndEnforce() is permissionless — the keeper is a convenience,
              not a trust assumption.
            </p>
          </div>
        </main>
      </div>
    </MandatesProvider>
  );
}
