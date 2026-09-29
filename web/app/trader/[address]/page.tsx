import type {Metadata} from "next";
import Link from "next/link";
import {notFound} from "next/navigation";
import {readPassport, type Record} from "@/lib/passport";
import {explorerAddr} from "@/lib/chain";

/**
 * The trader passport. A public document, like the mandate page: no wallet, no session.
 *
 * Its centre of gravity is the offer list. Every backer's standing offer is checked against
 * this record by the book contract itself, and the page shows each verdict with the
 * contract's own reason — so a trader can see exactly what the next rung of capital needs,
 * and a backer can see exactly who qualifies. The record is the application.
 */

export const revalidate = 15;

type Params = {params: Promise<{address: string}>};

const usd = (v: number) => v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function generateMetadata({params}: Params): Promise<Metadata> {
  const {address} = await params;
  const p = await readPassport(address);
  if (!p) return {title: "Trader not found"};
  const r = p.record;
  const title = `${short(p.address)} — ${r.mandatesSettled} settled, ${r.breaches} breach${r.breaches === 1 ? "" : "es"}, ${r.profitableExits} profitable`;
  const description =
    "A trading record written by the contract that enforced it — not claimed by the trader, not vouched for by a firm. Mandate, on Monad.";
  return {title, description, openGraph: {title, description, type: "profile"}, twitter: {card: "summary_large_image", title, description}};
}

export default async function PassportPage({params}: Params) {
  const {address} = await params;
  const p = await readPassport(address);
  if (!p) notFound();
  const r = p.record;
  const net = r.realisedProfit - r.realisedLoss;
  const unlocked = p.offers.filter((o) => o.qualifies);
  const next = p.offers.find((o) => !o.qualifies);

  return (
    <div className="mx-auto max-w-4xl space-y-5 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="text-sm font-semibold tracking-[0.08em] text-txt-hi">
          MANDATE
        </Link>
        <span className="text-2xs text-txt-lo">trader passport</span>
      </header>
      <div className="floor-rule" />

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-5 py-4">
          <h1 className="num text-base font-semibold text-txt-hi">{short(p.address)}</h1>
          <Badge r={r} />
          <a
            href={explorerAddr(p.address)}
            target="_blank"
            rel="noreferrer"
            className="num ml-auto text-2xs text-txt-lo underline decoration-ink-600 underline-offset-2 hover:text-txt-hi"
          >
            {p.address}
          </a>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-4">
          <Fig label="Settled" value={String(r.mandatesSettled)} sub={`of ${r.mandatesIssued} issued`} />
          <Fig label="Breaches" value={String(r.breaches)} tone={r.breaches ? "text-down" : "text-up"} />
          <Fig label="Profitable exits" value={String(r.profitableExits)} tone={r.profitableExits ? "text-up" : undefined} />
          <Fig label="Days traded" value={String(r.daysTraded)} />
          <Fig label="Capital entrusted" value={usd(r.capitalEntrusted)} sub="lifetime allocation" />
          <Fig label="Net realised" value={`${net >= 0 ? "+" : "−"}${usd(Math.abs(net))}`} tone={net >= 0 ? "text-up" : "text-down"} />
          <Fig
            label="Best consistency"
            value={r.bestConsistencyBps ? `${(r.bestConsistencyBps / 100).toFixed(1)}%` : "—"}
            sub="biggest day ÷ total profit"
          />
          <Fig
            label="On record since"
            value={r.firstMandateAt ? new Date(r.firstMandateAt * 1000).toLocaleDateString("en-GB", {day: "numeric", month: "short"}) : "—"}
          />
        </div>

        <div className="border-t border-edge px-5 py-3 text-2xs leading-relaxed text-txt-lo">
          Written by the contract that enforced every mandate below, in the transaction that
          settled it. Not claimed by the trader, not vouched for by a firm — and it goes wherever
          this address goes.
        </div>
      </section>

      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="panel-title">What this record unlocks</h2>
          <span className="text-2xs text-txt-lo">
            {unlocked.length} of {p.offers.length} open offers
          </span>
        </header>
        {p.offers.length === 0 ? (
          <p className="px-5 py-6 text-2xs text-txt-lo">No open offers on the book.</p>
        ) : (
          <ul className="divide-y divide-edge/60">
            {p.offers.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.65rem] ${o.qualifies ? "border-up/50 bg-up/10 text-up" : "border-edge bg-ink-950 text-txt-lo"}`}>
                  {o.qualifies ? "✓" : "·"}
                </span>
                <span className="num text-sm text-txt-hi">{usd(o.allocation)}</span>
                <span className="num text-xs text-txt-mid">{o.splitPct}% to trader</span>
                <span className="num text-2xs text-txt-lo">{o.slotsLeft} left</span>
                <span className={`ml-auto text-2xs ${o.qualifies ? "text-up" : "text-txt-lo"}`}>
                  {o.qualifies ? "qualifies — claimable now" : o.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <div className="border-t border-edge px-5 py-3 text-2xs text-txt-mid">
            Next rung: <span className="num text-txt-hi">{usd(next.allocation)}</span> at{" "}
            <span className="num text-txt-hi">{next.splitPct}%</span> — the book says{" "}
            <span className="text-warn">&ldquo;{next.reason.toLowerCase()}&rdquo;</span>.
          </div>
        )}
      </section>

      <section className="panel overflow-hidden">
        <header className="panel-head">
          <h2 className="panel-title">Mandates</h2>
          <span className="text-2xs text-txt-lo">{p.mandates.length}</span>
        </header>
        {p.mandates.length === 0 ? (
          <p className="px-5 py-6 text-2xs text-txt-lo">None yet.</p>
        ) : (
          <ul className="divide-y divide-edge/60">
            {p.mandates.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-xs">
                <Link href={`/m/${m.id}`} className="num text-txt-hi hover:text-acc-hi">
                  #{m.id}
                </Link>
                <span className={`rounded border px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-wider ${m.statusCode === 1 ? "border-up/30 bg-up/10 text-up" : m.statusCode === 2 ? "border-down/40 bg-down/10 text-down" : "border-ink-600 bg-ink-800 text-txt-mid"}`}>
                  {m.status}
                </span>
                <span className="num text-txt-mid">{usd(m.allocation)}</span>
                {m.statusCode !== 1 && (
                  <span className="num ml-auto text-2xs text-txt-lo">
                    ended at {usd(m.equity)}
                    {m.breach !== "None" ? ` · ${m.breach.toLowerCase()}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href="/traders" className="btn">
          All traders
        </Link>
        <Link href="/market" className="rounded-lg bg-acc px-4 py-2 text-xs font-semibold text-white hover:bg-acc-hi">
          See the offers
        </Link>
      </div>
    </div>
  );
}

function Badge({r}: {r: Record}) {
  const [label, cls] =
    r.mandatesSettled === 0
      ? ["No settled mandates yet", "border-ink-600 bg-ink-800 text-txt-mid"]
      : r.breaches === 0
        ? ["Clean record", "border-up/30 bg-up/10 text-up"]
        : ["Breach on record", "border-down/40 bg-down/10 text-down"];
  return <span className={`rounded-md border px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${cls}`}>{label}</span>;
}

function Fig({label, value, sub, tone}: {label: string; value: string; sub?: string; tone?: string}) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 text-lg ${tone ?? "text-txt-hi"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}
