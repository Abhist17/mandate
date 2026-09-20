import {publicClient, ADDR, isConfigured, STATUS, BREACH_KIND} from "./chain";
import {registryAbi} from "./abi";

/**
 * A mandate read on the server, for the public page and its share card.
 *
 * Deliberately separate from `lib/data.ts`, which is a client module built around React
 * polling. This one runs during the request, returns plain values, and reads only what a
 * stranger is allowed to see — which, because the state is public, happens to be all of it.
 */

export type PublicMandate = {
  id: string;
  trader: `0x${string}`;
  account: `0x${string}`;
  allocation: number;
  equity: number;
  floor: number;
  headroom: number;
  headroomBps: number;
  highWaterMark: number;
  status: string;
  statusCode: number;
  breach: string;
  maxDrawdownBps: number;
  dailyLossBps: number;
  profitSplitBps: number;
  drawdownMode: number;
  issuedAt: number;
};

const ASSET = 1e6;
const n = (v: bigint) => Number(v) / ASSET;

/** Named-tuple outputs decode to objects, not arrays — read by name, never by index. */
function field<T>(t: unknown, name: string): T {
  return (t as Record<string, T>)[name];
}

export async function readPublicMandate(id: string): Promise<PublicMandate | undefined> {
  if (!isConfigured || !/^\d+$/.test(id)) return undefined;
  const mandateId = BigInt(id);
  const registry = {address: ADDR.registry as `0x${string}`, abi: registryAbi} as const;

  try {
    const [state, terms, equity, headroom, floor] = await Promise.all([
      publicClient.readContract({...registry, functionName: "stateOf", args: [mandateId]}),
      publicClient.readContract({...registry, functionName: "termsOf", args: [mandateId]}),
      publicClient.readContract({...registry, functionName: "liveEquity", args: [mandateId]}),
      publicClient.readContract({...registry, functionName: "headroom", args: [mandateId]}),
      publicClient.readContract({...registry, functionName: "floorOf", args: [mandateId]}),
    ]);

    const statusCode = Number(field<number>(state, "status"));
    // Status 0 is "never issued" — a URL for a mandate that does not exist should 404
    // rather than render a card full of zeroes.
    if (statusCode === 0) return undefined;

    const breachKind = Number(field<number>(state, "breachKind"));
    // A settled mandate has had its assets swept back to the registry, so liveEquity() is
    // zero and says nothing about how it ended. The last mark is the figure that does.
    const settledEquity = n(field<bigint>(state, "lastMarkedEquity"));
    const hr = headroom as readonly bigint[];
    const fl = floor as readonly bigint[];

    return {
      id,
      trader: field<`0x${string}`>(state, "trader"),
      account: field<`0x${string}`>(state, "account"),
      allocation: n(field<bigint>(terms, "allocation")),
      equity: statusCode === 1 ? n(equity as bigint) : settledEquity,
      floor: n(fl[0] ?? 0n),
      headroom: n(hr[0] ?? 0n),
      headroomBps: Number(hr[1] ?? 0n),
      highWaterMark: n(field<bigint>(state, "highWaterMark")),
      status: STATUS[statusCode] ?? "Unknown",
      statusCode,
      breach: BREACH_KIND[breachKind] ?? "None",
      maxDrawdownBps: Number(field<number>(terms, "maxDrawdownBps")),
      dailyLossBps: Number(field<number>(terms, "dailyLossBps")),
      profitSplitBps: Number(field<number>(terms, "profitSplitBps")),
      drawdownMode: Number(field<number>(terms, "drawdownMode")),
      issuedAt: Number(field<bigint>(state, "issuedAt")),
    };
  } catch {
    return undefined;
  }
}

export const usd = (v: number, dp = 2) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
