import type {Metadata} from "next";
import {Instrument_Serif} from "next/font/google";
import "./globals.css";

/**
 * One display face, used only where the product speaks in its own voice.
 *
 * Every crypto product ships Inter, so Inter is invisible. A high-contrast serif on a
 * trading product is unusual enough to be remembered and, kept off the dashboard, costs
 * nothing in legibility — numbers stay tabular mono, which is what a terminal wants.
 */
const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
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

/**
 * Runs before first paint. Scroll reveals hide content until it is on screen, and doing
 * that from a React effect would paint everything, hide it, then reveal it — a flash on
 * every load. Setting the switch here means content is hidden from the first frame when
 * motion is wanted, and never hidden at all when it is not: no JS, reduced motion, or a
 * crawler all see the page in its final state.
 */
const MOTION_SWITCH =
  "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)" +
  "document.documentElement.setAttribute('data-motion','on')}catch(e){}";

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    // The attribute is set by the script before hydration, so the server's HTML and the
    // client's DOM legitimately differ on this one node.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html: MOTION_SWITCH}} />
      </head>
      <body className={`${display.variable} min-h-screen bg-ink-980`}>
        <ToastProvider>
          <Nav />
          <Frame>{children}</Frame>
        </ToastProvider>
      </body>
    </html>
  );
}
