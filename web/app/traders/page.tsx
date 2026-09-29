import Link from "next/link";
import {readLeaderboard} from "@/lib/passport";

/**
 * Every trader who has held a mandate, ranked by their contract-written record.
 *
 * The ranking rule is printed on the page and is nothing more than it says: profitable exits,
 * then fewest breaches, then net realised profit. A leaderboard on an opaque "score" would be
 * one more number a user has to trust; this one can be re-derived by anyone from recordOf.
 */

export const revalidate = 20;

const usd = (v: number) => v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});

export default async function TradersPage() {
  const rows = await readLeaderboard().catch(() => []);

  return (
    <div className="space-y-5">
      <header className="max-w-3xl space-y-2">
        <div className="num flex items-center gap-2 text-2xs uppercase tracking-[0.16em] text-txt-lo">
          <span className="text-acc-hi">Traders</span>
          <span className="h-px w-6 bg-edge-hi" />
          records written by the contract
        </div>
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-txt-hi">
          A track record nobody can edit — including the trader.
        </h1>
        <p className="text-sm leading-relaxed text-txt-mid">
          Every settlement writes to the trader&rsquo;s public record in the same transaction. Ranked
          by profitable exits, then fewest breaches, then net realised profit — a rule you can
          re-derive yourself from <span className="num text-txt-hi">recordOf</span>.
        </p>
      </header>

      <section className="panel overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-txt-lo">No traders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
                  <th className="px-4 py-2 text-left font-medium">#</th>
                  <th className="px-4 py-2 text-left font-medium">Trader</th>
                  <th className="px-4 py-2 text-right font-medium">Profitable</th>
                  <th className="px-4 py-2 text-right font-medium">Breaches</th>
                  <th className="px-4 py-2 text-right font-medium">Settled</th>
                  <th className="px-4 py-2 text-right font-medium">Entrusted</th>
                  <th className="px-4 py-2 text-right font-medium">Net realised</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const net = r.record.realisedProfit - r.record.realisedLoss;
                  return (
                    <tr key={r.address} className="row-hover border-b border-edge/50 last:border-0">
                      <td className="num px-4 py-2.5 text-txt-lo">{i + 1}</td>
                      <td className="px-4 py-2.5">
                        <Link href={`/trader/${r.address}`} className="num text-txt-hi hover:text-acc-hi">
                          {r.address.slice(0, 6)}…{r.address.slice(-4)}
                        </Link>
                        {r.record.mandatesSettled > 0 && r.record.breaches === 0 && (
                          <span className="ml-2 rounded border border-up/30 bg-up/10 px-1.5 py-px text-[0.6rem] font-semibold uppercase tracking-wider text-up">
                            clean
                          </span>
                        )}
                      </td>
                      <td className="num px-4 py-2.5 text-right text-up">{r.record.profitableExits}</td>
                      <td className={`num px-4 py-2.5 text-right ${r.record.breaches ? "text-down" : "text-txt-mid"}`}>{r.record.breaches}</td>
                      <td className="num px-4 py-2.5 text-right text-txt-mid">
                        {r.record.mandatesSettled}/{r.record.mandatesIssued}
                      </td>
                      <td className="num px-4 py-2.5 text-right text-txt-mid">{usd(r.record.capitalEntrusted)}</td>
                      <td className={`num px-4 py-2.5 text-right ${net >= 0 ? "text-up" : "text-down"}`}>
                        {net >= 0 ? "+" : "−"}
                        {usd(Math.abs(net))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
