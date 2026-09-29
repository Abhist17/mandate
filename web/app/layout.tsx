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
import {Intro} from "@/components/Intro";

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
 * Runs before first paint. It also decides the opening sequence: once a session, never under
 * reduced motion, never for a shared mandate link or presentation mode — and it schedules the
 * sequence's own end, so the page is never left behind the intro if the app fails to load.
 *
 * Scroll reveals hide content until it is on screen, and doing
 * that from a React effect would paint everything, hide it, then reveal it — a flash on
 * every load. Setting the switch here means content is hidden from the first frame when
 * motion is wanted, and never hidden at all when it is not: no JS, reduced motion, or a
 * crawler all see the page in its final state.
 */
const MOTION_SWITCH = `try{
  var d=document.documentElement;
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
    d.setAttribute('data-motion','on');
    var p=location.pathname;
    if(!sessionStorage.getItem('mandate.intro')&&p.indexOf('/m/')!==0&&p.indexOf('/demo')!==0){
      sessionStorage.setItem('mandate.intro','1');
      d.setAttribute('data-intro','on');
      window.__introEnd=setTimeout(function(){d.removeAttribute('data-intro')},2450);
    }
  }
}catch(e){}`;

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    // The attribute is set by the script before hydration, so the server's HTML and the
    // client's DOM legitimately differ on this one node.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html: MOTION_SWITCH}} />
      </head>
      <body className={`${display.variable} min-h-screen bg-ink-980`}>
        <Intro />
        <ToastProvider>
          <Nav />
          <Frame>{children}</Frame>
        </ToastProvider>
      </body>
    </html>
  );
}
