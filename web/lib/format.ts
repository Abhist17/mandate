/**
 * Number formatting.
 *
 * Precision is not decoration here. A trader reading a distance-to-floor of "$945" needs to
 * know it is $945 and not $945.44 rounded from $944.51, because that is the number that
 * decides whether they are still funded. So money keeps two decimals everywhere and nothing
 * is abbreviated except deliberately, in the places labelled as summaries.
 */

const ASSET_DECIMALS = 6;
const PRICE_DECIMALS = 8;

export function fmtUsd(v: bigint | undefined, decimals = ASSET_DECIMALS): string {
  if (v === undefined) return "—";
  return (Number(v) / 10 ** decimals).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPrice(v: bigint | undefined): string {
  return fmtUsd(v, PRICE_DECIMALS);
}

/** Signed, with an explicit + so a gain never reads as a loss at a glance. */
export function fmtSigned(v: bigint | undefined, decimals = ASSET_DECIMALS): string {
  if (v === undefined) return "—";
  const n = Number(v) / 10 ** decimals;
  const s = Math.abs(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "−" : "+"}${s}`;
}

export const fmtBps = (bps: bigint | number | undefined): string =>
  bps === undefined ? "—" : `${(Number(bps) / 100).toFixed(2)}%`;

export const fmtPct = (bps: number): string => `${(bps / 100).toFixed(0)}%`;

export const toNum = (v: bigint | undefined, decimals = ASSET_DECIMALS): number =>
  v === undefined ? 0 : Number(v) / 10 ** decimals;

export const shortAddr = (a: string | undefined): string =>
  !a ? "—" : `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmtSize(v: bigint | undefined): string {
  if (v === undefined) return "—";
  const n = Number(v) / 1e18;
  return n.toLocaleString("en-US", {maximumFractionDigits: 4});
}

export function timeAgo(unix: number | bigint | undefined): string {
  if (unix === undefined) return "—";
  const secs = Math.floor(Date.now() / 1000) - Number(unix);
  if (secs < 0) return "now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function fmtCountdown(expiry: bigint | undefined): string {
  if (expiry === undefined) return "—";
  const secs = Number(expiry) - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "expired";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}
