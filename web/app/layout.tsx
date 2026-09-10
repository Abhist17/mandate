import type {Metadata} from "next";
import "./globals.css";
import {Nav} from "@/components/Nav";
import {NetworkGuard} from "@/components/NetworkGuard";
import {ToastProvider} from "@/components/Toast";

export const metadata: Metadata = {
  title: "Mandate — the rules are the contract",
  description:
    "An onchain prop firm on Monad. Funded capital with the risk limits written into the contract, enforced every block by a function anyone can call.",
  openGraph: {
    title: "Mandate — the rules are the contract",
    description:
      "Funded trading capital where the drawdown, the daily limit and the payout conditions are a smart contract, not a PDF. Testnet, free, no signup.",
    type: "website",
  },
};

// Tells mobile browsers to use the device width rather than emulating a 980px desktop, and
// keeps the dark ground behind the notch and the address bar.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#05060a",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-980">
        <ToastProvider>
          <Nav />
          <main className="mx-auto max-w-[1500px] px-3 py-4 sm:px-4 sm:py-5">
            <NetworkGuard>{children}</NetworkGuard>
          </main>
          <footer className="mx-auto max-w-[1500px] px-3 pb-8 pt-4 text-2xs leading-relaxed text-txt-lo sm:px-4">
            Monad testnet · markAndEnforce() is permissionless — the keeper is a convenience, not
            a trust assumption.
          </footer>
        </ToastProvider>
      </body>
    </html>
  );
}
