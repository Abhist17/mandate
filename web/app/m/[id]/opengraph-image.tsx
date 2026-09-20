import {ImageResponse} from "next/og";
import {readPublicMandate, usd, shortAddr} from "@/lib/public-mandate";

/**
 * The share card.
 *
 * When someone drops a mandate link into a Discord thread, this is the pitch — it gets
 * looked at far more than the page behind it, so it carries the one number that explains
 * the product: how far this account is from the floor that closes it.
 *
 * The red rule across the card is the floor itself, and it is the identity of the whole
 * product: a single line you do not cross, drawn at the height the account is actually at.
 */

export const alt = "A funded mandate on Monad, enforced by contract";
export const size = {width: 1200, height: 630};
export const contentType = "image/png";

const INK = "#07080c";
const UP = "#00e39b";
const DOWN = "#ff3d55";
const WARN = "#ffb43a";
const HI = "#f2f4f8";
const LO = "#646d7e";

export default async function Image({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const m = await readPublicMandate(id);

  if (!m) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: INK,
            color: HI,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 44,
            letterSpacing: "0.08em",
          }}
        >
          MANDATE
        </div>
      ),
      size,
    );
  }

  const live = m.statusCode === 1;
  const tone = !live ? LO : m.headroomBps < 150 ? DOWN : m.headroomBps < 400 ? WARN : UP;

  // Where the floor sits between the account's low and its peak, as a share of the card.
  const lo = Math.min(m.floor, m.equity, m.allocation);
  const hi = Math.max(m.highWaterMark, m.equity, m.allocation);
  const span = Math.max(hi - lo, 1e-9);
  // Clamped to the band between the header and the stat row. The line is meant to read as
  // "the floor sits about here relative to the account", not as a precise plot — and a line
  // free to wander the full height lands on top of the stats and makes the card unreadable.
  const floorPct = Math.max(30, Math.min(62, 100 - ((m.floor - lo) / span) * 100));
  // Satori has no calc(), so positions are resolved to pixels here.
  const floorY = Math.round((floorPct / 100) * size.height);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: INK,
          display: "flex",
          flexDirection: "column",
          padding: 64,
          position: "relative",
          fontFamily: "sans-serif",
        }}
      >
        {/* the floor, drawn where it actually is */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: floorY,
            height: 3,
            background: DOWN,
            display: "flex",
          }}
        />
        {/* Right-aligned: the stats run along the left, and a label that collides with
            them costs more than it explains. */}
        <div
          style={{
            position: "absolute",
            right: 64,
            top: floorY + 12,
            color: DOWN,
            fontSize: 22,
            display: "flex",
          }}
        >
          {`${usd(m.floor, 0)} floor`}
        </div>

        <div style={{display: "flex", alignItems: "center", gap: 20}}>
          <div style={{display: "flex", color: HI, fontSize: 30, fontWeight: 700, letterSpacing: "0.1em"}}>
            MANDATE
          </div>
          <div style={{display: "flex", color: LO, fontSize: 24}}>{`#${m.id}`}</div>
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              border: `2px solid ${live ? UP : DOWN}`,
              color: live ? UP : DOWN,
              borderRadius: 8,
              padding: "6px 16px",
              fontSize: 22,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {m.status}
          </div>
        </div>

        <div style={{display: "flex", flexDirection: "column", marginTop: 56}}>
          <div style={{display: "flex", color: LO, fontSize: 26, letterSpacing: "0.12em"}}>
            {live ? "DISTANCE TO FLOOR" : "CLOSED AT"}
          </div>
          <div style={{display: "flex", color: tone, fontSize: 132, fontWeight: 700, lineHeight: 1.05}}>
            {live ? usd(m.headroom) : usd(m.equity)}
          </div>
          {/* The reason belongs beside the figure, not above it: labelling the closing
              equity "DAILY LOSS" read as though the loss itself was $94,412. */}
          {!live && m.breach !== "None" && (
            <div style={{display: "flex", color: DOWN, fontSize: 26, marginTop: 10}}>
              {`${m.breach} — closed by the contract`}
            </div>
          )}
        </div>

        <div style={{display: "flex", gap: 64, marginTop: "auto"}}>
          <Stat k="Funded" v={usd(m.allocation, 0)} />
          <Stat k="Equity" v={usd(m.equity, 0)} />
          <Stat k="Split" v={`${m.profitSplitBps / 100}%`} />
          <Stat k="Trader" v={shortAddr(m.trader)} />
        </div>

        <div style={{display: "flex", marginTop: 34, color: LO, fontSize: 22}}>
          The drawdown, the daily limit and the payout are a smart contract on Monad.
        </div>
      </div>
    ),
    size,
  );
}

function Stat({k, v}: {k: string; v: string}) {
  return (
    <div style={{display: "flex", flexDirection: "column"}}>
      <div style={{display: "flex", color: LO, fontSize: 20, letterSpacing: "0.1em"}}>{k.toUpperCase()}</div>
      <div style={{display: "flex", color: HI, fontSize: 34, marginTop: 6}}>{v}</div>
    </div>
  );
}
