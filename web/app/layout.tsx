import type {Metadata} from "next";
import "./globals.css";
import {Nav} from "@/components/Nav";
import {Frame} from "@/components/Frame";
import {ToastProvider} from "@/components/Toast";

export const metadata: Metadata = {
  // Absolute URLs for share cards. Without it Next falls back to localhost and every
  // unfurled link points at the machine that rendered it.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
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
          <Frame>{children}</Frame>
        </ToastProvider>
      </body>
    </html>
  );
}
