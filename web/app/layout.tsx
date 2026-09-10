import type {Metadata} from "next";
import "./globals.css";
import {Nav} from "@/components/Nav";
import {NetworkGuard} from "@/components/NetworkGuard";

export const metadata: Metadata = {
  title: "Mandate — the rules are the contract",
  description:
    "An onchain prop firm on Monad. LPs deposit, traders get an allocation with encoded terms, and a keeper marks equity every block. Breach the drawdown and the contract flattens the position in the same block.",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950">
        <Nav />
        <main className="mx-auto max-w-[1500px] px-4 py-5">
          <NetworkGuard>{children}</NetworkGuard>
        </main>
        <footer className="mx-auto max-w-[1500px] px-4 pb-8 pt-4 text-2xs text-txt-lo">
          Monad testnet · markAndEnforce() is permissionless — the keeper is a convenience, not a
          trust assumption.
        </footer>
      </body>
    </html>
  );
}
