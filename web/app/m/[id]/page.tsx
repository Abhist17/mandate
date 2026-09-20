import type {Metadata} from "next";
import Link from "next/link";
import {notFound} from "next/navigation";
import {readPublicMandate, usd, shortAddr} from "@/lib/public-mandate";
import {explorerAddr} from "@/lib/chain";

/**
 * The public face of one mandate.
 *
 * Rendered on the server, so the numbers are in the HTML: a crawler, a link unfurler, or
 * someone with scripting off all get the real figures rather than an empty shell. That is
 * the whole difference between this and a funded account at a prop firm — there is no
 * login here because there is nothing to log in to. The state is public, so the page is.
 *
 * It exists to be pasted into a Discord thread. The share card is the pitch.
 */

export const revalidate = 15;

const MODE = ["static", "trailing", "trailing to breakeven"];

type Params = {params: Promise<{id: string}>};

export async function generateMetadata({params}: Params): Promise<Metadata> {
  const {id} = await params;
  const m = await readPublicMandate(id);
  if (!m) return {title: "Mandate not found"};

  const live = m.statusCode === 1;
  const title = `Mandate #${m.id} — ${usd(m.allocation, 0)} funded, ${live ? `${usd(m.headroom)} from the floor` : m.status.toLowerCase()}`;
  const description = live
    ? `Equity ${usd(m.equity)} against a ${usd(m.floor)} floor. The drawdown, the daily limit and the payout split are a smart contract on Monad — anyone can verify them, and anyone can enforce them.`
    : `${m.status}${m.breach !== "None" ? ` — ${m.breach.toLowerCase()}` : ""}. Closed by the contract, not by a support ticket.`;

  return {
    title,
    description,
    openGraph: {title, description, type: "article"},
    twitter: {card: "summary_large_image", title, description},
  };
}

export default async function PublicMandatePage({params}: Params) {
  const {id} = await params;
  const m = await readPublicMandate(id);
  if (!m) notFound();

  const live = m.statusCode === 1;
  const pnl = m.equity - m.allocation;
  const tone = !live ? "txt-mid" : m.headroomBps < 150 ? "down" : m.headroomBps < 400 ? "warn" : "up";

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-sm font-semibold tracking-[0.08em] text-txt-hi">
          MANDATE
        </Link>
        <span className="text-2xs text-txt-lo">the rules are the contract</span>
      </header>

      {/* The floor line, as the page's own rule. */}
      <div className="floor-rule" />

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-5 py-4">
          <h1 className="num text-base font-semibold text-txt-hi">Mandate #{m.id}</h1>
          <span
            className={`rounded-md border px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${
              live
                ? "border-up/30 bg-up/10 text-up"
                : m.statusCode === 2
                  ? "border-down/40 bg-down/10 text-down"
                  : "border-ink-600 bg-ink-800 text-txt-mid"
            }`}
          >
            {m.status}
          </span>
          <span className="num ml-auto text-2xs text-txt-lo">{shortAddr(m.trader)}</span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-4">
          <Fig label="Allocated" value={usd(m.allocation, 0)} />
          {/* On a settled mandate the closing equity is the headline, so showing it again
              under "Equity" spent a column saying the same number twice. The peak is the
              figure that is actually missing there — it is what the floor trailed. */}
          <Fig label={live ? "Equity" : "Peak"} value={usd(live ? m.equity : m.highWaterMark)} />
          <Fig
            label={live ? "Distance to floor" : "Ended at"}
            value={live ? usd(m.headroom) : usd(m.equity)}
            tone={tone}
          />
          <Fig label="P&L" value={`${pnl >= 0 ? "+" : "−"}${usd(Math.abs(pnl))}`} tone={pnl >= 0 ? "up" : "down"} />
        </div>

        {live && (
          <div className="border-t border-edge px-5 py-4">
            <Gauge equity={m.equity} floor={m.floor} peak={m.highWaterMark} />
          </div>
        )}

        <div className="grid grid-cols-1 divide-y divide-edge border-t border-edge sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Term k="Max drawdown" v={`${m.maxDrawdownBps / 100}% ${MODE[m.drawdownMode]}`} />
          <Term k="Daily loss" v={`${m.dailyLossBps / 100}%`} />
          <Term k="Profit split" v={`${m.profitSplitBps / 100}% to trader`} />
        </div>

        {!live && m.breach !== "None" && (
          <div className="border-t border-edge bg-down/[0.06] px-5 py-3 text-2xs leading-relaxed text-down">
            Closed by the contract — {m.breach.toLowerCase()}. No appeal, no support ticket, and
            nobody had to decide. The same function anyone could have called.
          </div>
        )}
      </section>

      <section className="panel px-5 py-4">
        <p className="text-xs leading-relaxed text-txt-mid">
          These numbers are not a statement about this account. They are the account — read
          straight from the contract that enforces it, which anyone can query without
          permission.{" "}
          <a
            href={explorerAddr(m.account)}
            target="_blank"
            rel="noreferrer"
            className="text-acc-hi underline decoration-acc/40 underline-offset-2"
          >
            Check it yourself
          </a>
          .
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/trade?m=${m.id}`}
            className="rounded-lg bg-acc px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-acc-hi"
          >
            Open the live dashboard
          </Link>
          <Link href="/" className="btn">
            What is this?
          </Link>
        </div>
      </section>
    </div>
  );
}

/** Tailwind only ships classes it can see as literals, so the tone maps to a full name. */
const TONE: Record<string, string> = {
  "txt-hi": "text-txt-hi",
  "txt-mid": "text-txt-mid",
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
};

function Fig({label, value, tone = "txt-hi"}: {label: string; value: string; tone?: string}) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 text-lg ${TONE[tone] ?? TONE["txt-hi"]}`}>{value}</div>
    </div>
  );
}

function Term({k, v}: {k: string; v: string}) {
  return (
    <div className="px-5 py-3">
      <div className="text-2xs text-txt-lo">{k}</div>
      <div className="num mt-0.5 text-xs text-txt-hi">{v}</div>
    </div>
  );
}

function Gauge({equity, floor, peak}: {equity: number; floor: number; peak: number}) {
  const span = Math.max(peak - floor, 1e-9);
  const pct = Math.max(0, Math.min(100, ((equity - floor) / span) * 100));
  const tone = pct <= 20 ? "bg-down" : pct < 45 ? "bg-warn" : "bg-up";
  const money0 = (v: number) => usd(v, 0);
  return (
    <div className="space-y-2">
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-800 ring-1 ring-inset ring-white/[0.04]">
        <div className={`h-full rounded-full ${tone}`} style={{width: `${pct}%`}} />
      </div>
      <div className="flex justify-between text-2xs">
        <span className="text-down">{money0(floor)} floor</span>
        <span className="text-txt-lo">{money0(peak)} peak</span>
      </div>
    </div>
  );
}
