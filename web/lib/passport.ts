import {getAddress, isAddress, type Address} from "viem";
import {publicClient, ADDR, isConfigured, hasBook, STATUS, BREACH_KIND} from "./chain";
import {registryAbi, bookAbi} from "./abi";

/**
 * A trader's passport: the record the contract wrote about them, read on the server.
 *
 * Every mandate that settles updates `recordOf(trader)` — settled, breached, profitable,
 * days traded, capital entrusted, profit and loss — in the same transaction that closes it.
 * Nobody can add to it, remove from it, or vouch for it: it is not a claim the trader makes
 * or a reference a firm gives. At a prop firm your track record stays behind when you leave.
 * Here it is an address, and every backer's offer evaluates it automatically.
 */

export type Record = {
  mandatesIssued: number;
  mandatesSettled: number;
  breaches: number;
  profitableExits: number;
  daysTraded: number;
  capitalEntrusted: number;
  realisedProfit: number;
  realisedLoss: number;
  bestConsistencyBps: number;
  firstMandateAt: number;
  lastSettledAt: number;
};

export type PassportMandate = {
  id: string;
  status: string;
  statusCode: number;
  breach: string;
  allocation: number;
  equity: number;
};

export type OfferFit = {
  id: string;
  allocation: number;
  splitPct: number;
  slotsLeft: number;
  qualifies: boolean;
  reason: string;
};

export type Passport = {address: Address; record: Record; mandates: PassportMandate[]; offers: OfferFit[]};

const n6 = (v: unknown) => Number(v as bigint) / 1e6;
const f = <T>(t: unknown, k: string) => (t as {[key: string]: T})[k];

export function toRecord(r: unknown): Record {
  return {
    mandatesIssued: Number(f(r, "mandatesIssued")),
    mandatesSettled: Number(f(r, "mandatesSettled")),
    breaches: Number(f(r, "breaches")),
    profitableExits: Number(f(r, "profitableExits")),
    daysTraded: Number(f(r, "daysTraded")),
    capitalEntrusted: n6(f(r, "capitalEntrusted")),
    realisedProfit: n6(f(r, "realisedProfit")),
    realisedLoss: n6(f(r, "realisedLoss")),
    bestConsistencyBps: Number(f(r, "bestConsistencyBps")),
    firstMandateAt: Number(f(r, "firstMandateAt")),
    lastSettledAt: Number(f(r, "lastSettledAt")),
  };
}

export async function readPassport(addr: string): Promise<Passport | undefined> {
  if (!isConfigured || !isAddress(addr)) return undefined;
  const address = addr as Address;
  const reg = {address: ADDR.registry, abi: registryAbi} as const;

  try {
    const [rec, ids] = await Promise.all([
      publicClient.readContract({...reg, functionName: "recordOf", args: [address]}),
      publicClient.readContract({...reg, functionName: "mandatesOf", args: [address]}),
    ]);

    const mandates = await Promise.all(
      (ids as readonly bigint[]).map(async (id) => {
        const [state, terms] = await Promise.all([
          publicClient.readContract({...reg, functionName: "stateOf", args: [id]}),
          publicClient.readContract({...reg, functionName: "termsOf", args: [id]}),
        ]);
        const code = Number(f(state, "status"));
        return {
          id: id.toString(),
          status: STATUS[code] ?? "Unknown",
          statusCode: code,
          breach: BREACH_KIND[Number(f(state, "breachKind"))] ?? "None",
          allocation: n6(f(terms, "allocation")),
          equity: n6(f(state, "lastMarkedEquity")),
        };
      }),
    );

    let offers: OfferFit[] = [];
    if (hasBook) {
      const book = {address: ADDR.book, abi: bookAbi} as const;
      const open = (await publicClient.readContract({...book, functionName: "openOffers"})) as readonly bigint[];
      offers = await Promise.all(
        open.map(async (oid) => {
          const [offer, fit] = await Promise.all([
            publicClient.readContract({...book, functionName: "offerAt", args: [oid]}),
            publicClient.readContract({...book, functionName: "qualifies", args: [oid, address]}),
          ]);
          const terms = f<unknown>(offer, "terms");
          const [ok, reason] = fit as readonly [boolean, string];
          return {
            id: oid.toString(),
            allocation: n6(f(offer, "allocation")),
            splitPct: Number(f(terms, "profitSplitBps")) / 100,
            slotsLeft: Number(f(offer, "slotsTotal")) - Number(f(offer, "slotsTaken")),
            qualifies: ok,
            reason,
          };
        }),
      );
      offers.sort((a, b) => a.allocation - b.allocation);
    }

    return {address, record: toRecord(rec), mandates: mandates.reverse(), offers};
  } catch {
    return undefined;
  }
}

/**
 * Everyone who has held a mandate, ranked by a rule stated on the page rather than a score
 * nobody can audit: profitable exits, then fewest breaches, then realised profit.
 */
export async function readLeaderboard(): Promise<{address: Address; record: Record}[]> {
  if (!isConfigured) return [];
  const reg = {address: ADDR.registry, abi: registryAbi} as const;
  const next = Number(await publicClient.readContract({...reg, functionName: "nextMandateId"}));
  const states = await Promise.all(
    Array.from({length: Math.max(0, next - 1)}, (_, i) =>
      publicClient.readContract({...reg, functionName: "stateOf", args: [BigInt(i + 1)]}).catch(() => undefined),
    ),
  );
  // De-duplicated case-insensitively, then checksummed: lowercased addresses in links and
  // share cards read as a different identity from the one the passport page shows.
  const traders = [...new Set(states.filter(Boolean).map((s) => (f<string>(s, "trader")).toLowerCase()))].map((a) => getAddress(a));
  const rows = await Promise.all(
    traders.map(async (a) => ({
      address: a,
      record: toRecord(await publicClient.readContract({...reg, functionName: "recordOf", args: [a]})),
    })),
  );
  return rows
    .filter((r) => r.record.mandatesIssued > 0)
    .sort(
      (a, b) =>
        b.record.profitableExits - a.record.profitableExits ||
        a.record.breaches - b.record.breaches ||
        b.record.realisedProfit - b.record.realisedLoss - (a.record.realisedProfit - a.record.realisedLoss),
    );
}
