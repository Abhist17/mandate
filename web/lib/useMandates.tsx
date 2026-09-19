"use client";

import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {fetchRelevantIds, fetchMandate, usePolled, type Mandate} from "@/lib/data";
import {useSession} from "@/lib/useSession";
import {isConfigured} from "@/lib/chain";

/**
 * One poll of the mandate set, shared by everything that needs it.
 *
 * The sidebar's account switcher and the dashboard below it want exactly the same list. Two
 * independent pollers would double the RPC load and — worse — drift, so the switcher could
 * show a mandate as active for a tick after the detail view had already marked it breached.
 * A trader watching two parts of one screen disagree about whether they still have an
 * account has no reason to believe either of them.
 */

type Store = {
  mandates: Mandate[] | undefined;
  selected: bigint | undefined;
  select: (id: bigint) => void;
  /** The selected mandate, held at its last good value across a failed read. */
  current: Mandate | undefined;
  refresh: () => void;
};

const Ctx = createContext<Store | undefined>(undefined);

export function MandatesProvider({children}: {children: ReactNode}) {
  const {address} = useSession();
  const [selected, setSelected] = useState<bigint>();

  // Merge each tick into what we already know: a mandate whose read failed keeps its last
  // value instead of vanishing for a frame. Anything settled drops out on its own, because
  // fetchRelevantIds stops returning it.
  const known = useRef(new Map<string, Mandate>());
  const {data: mandates, refresh} = usePolled(
    async () => {
      if (!isConfigured) return [];
      const ids = await fetchRelevantIds(address);
      const all = await Promise.all(ids.map((id) => fetchMandate(id).catch(() => undefined)));
      const next = new Map<string, Mandate>();
      for (const id of ids) {
        const fresh = all.find((m) => m?.id === id);
        const prev = known.current.get(id.toString());
        if (fresh) next.set(id.toString(), fresh);
        else if (prev) next.set(id.toString(), prev);
      }
      known.current = next;
      return [...next.values()];
    },
    4_000,
    [address],
  );

  // A shared link names its mandate. Honouring it before anything else is the whole point
  // of the share button: someone opening the link has to land on the account they were
  // sent, not on whichever one this browser would have picked for itself.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const want = new URLSearchParams(window.location.search).get("m");
    if (!want || !/^\d+$/.test(want)) return;
    setSelected((cur) => cur ?? BigInt(want));
  }, []);

  // Otherwise open on your own mandate if you have one, and failing that on whichever is
  // closest to its floor, because that is the one worth watching.
  useEffect(() => {
    if (selected !== undefined || !mandates || mandates.length === 0) return;
    const active = mandates.filter((m) => m.state.status === 1);
    const mine = address
      ? active.find((m) => m.state.trader.toLowerCase() === address.toLowerCase())
      : undefined;
    if (mine) {
      setSelected(mine.id);
      return;
    }
    const pick =
      active.length > 0
        ? active.reduce((a, b) => (a.headroomBps <= b.headroomBps ? a : b))
        : mandates[0]!;
    setSelected(pick.id);
  }, [mandates, selected, address]);

  // Same stale-beats-blank rule for the selected one: a single failed poll would otherwise
  // unmount the entire detail view for one tick and remount it the next.
  const lastGood = useRef<Mandate | undefined>(undefined);
  const current = useMemo(() => {
    const found = mandates?.find((m) => m.id === selected);
    if (found) lastGood.current = found;
    return found ?? (lastGood.current?.id === selected ? lastGood.current : undefined);
  }, [mandates, selected]);

  const value = useMemo<Store>(
    () => ({mandates, selected, select: setSelected, current, refresh}),
    [mandates, selected, current, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMandates(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMandates must be used inside <MandatesProvider>");
  return v;
}
