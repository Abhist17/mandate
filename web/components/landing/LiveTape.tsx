"use client";

import {useEffect, useRef, useState} from "react";
import {publicClient, ADDR, isConfigured} from "@/lib/chain";
import {oracleAbi} from "@/lib/abi";
import {fetchActiveIds, fetchPoolStats} from "@/lib/data";
import {CountUp} from "@/components/motion";
import {useInView} from "@/lib/motion";

/**
 * The tape under the engine: the numbers the diagram is about, read live.
 *
 * The brief for this page asked for market data "updating in real time" in the hero. The
 * cheap way is a decorative ticker of invented figures, on the one site whose premise is
 * that its numbers are not invented. So every cell here is a chain read — block height,
 * the oracle's BTC price, what the pool holds, what is allocated, how many mandates are
 * live — and a cell whose read fails shows a dash rather than something plausible.
 *
 * Polls only while visible. The block number is the fast one, and it is the honest way to
 * show Monad's speed: not an animation that looks fast, the chain being fast.
 */

type Tape = {
  block?: bigint;
  btc?: number;
  pool?: number;
  allocated?: number;
  live?: number;
};

const usd0 = (n: number) =>
  n.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0});
const usd2 = (n: number) =>
  n.toLocaleString("en-US", {style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2});

export function LiveTape() {
  const [ref, visible] = useInView<HTMLDivElement>({once: false, threshold: 0, rootMargin: "0px"});
  const [tape, setTape] = useState<Tape>({});
  const lastBlock = useRef<bigint | undefined>(undefined);
  const [beat, setBeat] = useState(0);

  // Slow reads: what the pool holds and what is live. These move on the scale of minutes.
  useEffect(() => {
    if (!visible || !isConfigured) return;
    let dead = false;
    const load = async () => {
      const [pool, ids, px] = await Promise.all([
        fetchPoolStats().catch(() => undefined),
        fetchActiveIds().catch(() => undefined),
        publicClient
          .readContract({address: ADDR.oracle, abi: oracleAbi, functionName: "price", args: [16]})
          .catch(() => undefined),
      ]);
      if (dead) return;
      setTape((t) => ({
        ...t,
        pool: pool ? Number(pool.totalAssets) / 1e6 : t.pool,
        allocated: pool ? Number(pool.allocated) / 1e6 : t.allocated,
        live: ids ? ids.length : t.live,
        btc: px ? Number((px as readonly [bigint, bigint])[0]) / 1e8 : t.btc,
      }));
    };
    void load();
    const i = setInterval(load, 12_000);
    return () => {
      dead = true;
      clearInterval(i);
    };
  }, [visible]);

  // The fast read: block height, every two seconds while the tape is on screen.
  useEffect(() => {
    if (!visible) return;
    let dead = false;
    const load = async () => {
      const b = await publicClient.getBlockNumber().catch(() => undefined);
      if (dead || b === undefined) return;
      // Compared outside the state updater: updaters must be pure, and StrictMode runs
      // them twice — a toggle in there would flip back and the beat would never show.
      if (lastBlock.current !== undefined && b > lastBlock.current) setBeat((n) => n + 1);
      lastBlock.current = b;
      setTape((t) => ({...t, block: b}));
    };
    void load();
    const i = setInterval(load, 2_000);
    return () => {
      dead = true;
      clearInterval(i);
    };
  }, [visible]);

  return (
    <div
      ref={ref}
      className="grid grid-cols-2 divide-edge overflow-hidden rounded-xl border border-edge bg-ink-950/70 backdrop-blur-sm sm:grid-cols-5 sm:divide-x"
    >
      <Cell label="Monad block" hint="live">
        <span className="flex items-center gap-2">
          {/* The dot re-keys on every new block, so its pulse is one per block — the
              chain's own heartbeat rather than a loop that would pulse regardless. */}
          <span key={beat} className="block-beat h-1.5 w-1.5 rounded-full bg-up" />
          {tape.block !== undefined ? tape.block.toLocaleString("en-US") : "—"}
        </span>
      </Cell>
      <Cell label="BTC · oracle">
        <CountUp value={tape.btc} format={usd2} />
      </Cell>
      <Cell label="In the pool">
        <CountUp value={tape.pool} format={usd0} />
      </Cell>
      <Cell label="Allocated">
        <CountUp value={tape.allocated} format={usd0} />
      </Cell>
      <Cell label="Live mandates">
        <CountUp value={tape.live} format={(n) => Math.round(n).toString()} duration={600} />
      </Cell>
    </div>
  );
}

function Cell({label, hint, children}: {label: string; hint?: string; children: React.ReactNode}) {
  return (
    <div className="border-b border-edge px-4 py-3 last:border-b-0 sm:border-b-0">
      <div className="flex items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.16em] text-txt-lo">
        {label}
        {hint && <span className="text-up/70">· {hint}</span>}
      </div>
      <div className="num mt-1 text-sm text-txt-hi">{children}</div>
    </div>
  );
}
