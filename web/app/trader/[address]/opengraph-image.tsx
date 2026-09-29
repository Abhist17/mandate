import {ImageResponse} from "next/og";
import {readPassport} from "@/lib/passport";

/**
 * The passport's share card: a trading record, written by the contract that enforced it.
 * Satori rules apply — explicit display on every multi-child node, and no calc().
 */

export const alt = "A trading record written by the contract that enforced it";
export const size = {width: 1200, height: 630};
export const contentType = "image/png";

const INK = "#07080c";
const UP = "#00e39b";
const DOWN = "#ff3d55";
const HI = "#f2f4f8";
const LO = "#646d7e";

const usd = (v: number) => v.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});

export default async function Image({params}: {params: Promise<{address: string}>}) {
  const {address} = await params;
  const p = await readPassport(address);
  const r = p?.record;
  const net = r ? r.realisedProfit - r.realisedLoss : 0;
  const unlocked = p ? p.offers.filter((o) => o.qualifies) : [];
  const top = unlocked.length ? unlocked[unlocked.length - 1] : undefined;
  const clean = r && r.mandatesSettled > 0 && r.breaches === 0;

  return new ImageResponse(
    (
      <div style={{width: "100%", height: "100%", background: INK, display: "flex", flexDirection: "column", padding: 64, position: "relative", fontFamily: "sans-serif"}}>
        {/* the floor, as the card's rule */}
        <div style={{position: "absolute", left: 0, right: 0, top: 150, height: 3, background: DOWN, display: "flex"}} />

        <div style={{display: "flex", alignItems: "center", gap: 20}}>
          <div style={{display: "flex", color: HI, fontSize: 30, fontWeight: 700, letterSpacing: "0.1em"}}>MANDATE</div>
          <div style={{display: "flex", color: LO, fontSize: 24}}>trader passport</div>
          {r && (
            <div style={{marginLeft: "auto", display: "flex", border: `2px solid ${clean ? UP : r.breaches ? DOWN : LO}`, color: clean ? UP : r.breaches ? DOWN : LO, borderRadius: 8, padding: "6px 16px", fontSize: 22, fontWeight: 700, letterSpacing: "0.1em"}}>
              {clean ? "CLEAN RECORD" : r.breaches ? "BREACH ON RECORD" : "NEW"}
            </div>
          )}
        </div>

        <div style={{display: "flex", marginTop: 70, color: HI, fontSize: 52, fontWeight: 700}}>
          {`${address.slice(0, 6)}…${address.slice(-4)}`}
        </div>

        {r ? (
          <div style={{display: "flex", gap: 56, marginTop: 40}}>
            <Stat k="Settled" v={String(r.mandatesSettled)} c={HI} />
            <Stat k="Breaches" v={String(r.breaches)} c={r.breaches ? DOWN : UP} />
            <Stat k="Profitable" v={String(r.profitableExits)} c={r.profitableExits ? UP : HI} />
            <Stat k="Net realised" v={`${net >= 0 ? "+" : "−"}${usd(Math.abs(net))}`} c={net >= 0 ? UP : DOWN} />
          </div>
        ) : (
          <div style={{display: "flex", marginTop: 40, color: LO, fontSize: 30}}>No record yet</div>
        )}

        <div style={{display: "flex", marginTop: "auto", color: top ? UP : LO, fontSize: 28}}>
          {top ? `Qualifies for up to ${usd(top.allocation)} at ${top.splitPct}% — no application, no approval` : "Every settled mandate writes to this record"}
        </div>
        <div style={{display: "flex", marginTop: 14, color: LO, fontSize: 22}}>
          Written by the contract that enforced it. Not claimed, not vouched for. On Monad.
        </div>
      </div>
    ),
    size,
  );
}

function Stat({k, v, c}: {k: string; v: string; c: string}) {
  return (
    <div style={{display: "flex", flexDirection: "column"}}>
      <div style={{display: "flex", color: LO, fontSize: 20, letterSpacing: "0.1em"}}>{k.toUpperCase()}</div>
      <div style={{display: "flex", color: c, fontSize: 44, marginTop: 6}}>{v}</div>
    </div>
  );
}
