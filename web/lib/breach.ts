import type {Position} from "./data";

/**
 * The price that closes you.
 *
 * Perpetuals show a liquidation price because it is the one number that tells a trader how
 * much room they have in the unit they think in — the price of the thing they are trading.
 * A funded account has a floor instead of a margin call, and the equivalent is the price at
 * which equity reaches that floor. No prop firm dashboard shows it; they show a percentage
 * and leave the trader to do the arithmetic under pressure.
 *
 * It is exact arithmetic on the contract's own numbers: headroom is equity minus the binding
 * floor, and a position moves equity by its size for every dollar of price. The floor does
 * not move while price moves against you — the peak it trails from cannot rise on a loss and
 * the daily floor is fixed for the day — so the answer holds until the next new high or the
 * next reset. With several positions each price is computed with the others held still, and
 * closing costs are left out, so the real line sits a hair earlier; the UI says "≈".
 */
export function breachPrice(p: Position, headroom: bigint): number | undefined {
  const size = Number(p.size) / 1e18;
  if (size <= 0) return undefined;
  const mark = Number(p.markPrice) / 1e8;
  const room = Number(headroom) / 1e6;
  const px = p.isLong ? mark - room / size : mark + room / size;
  return px > 0 ? px : undefined;
}

/**
 * The same, for an order not yet placed: where a new position of `size` filled at `fill`
 * would put the line. The spread is paid on entry — equity falls by the distance between the
 * fill and mid the moment it fills — so that comes out of the headroom first.
 */
export function previewBreach(args: {
  isLong: boolean;
  sizeWei: bigint;
  fill: bigint; // 1e8
  mid: bigint; // 1e8
  headroom: bigint; // 1e6
}): number | undefined {
  const size = Number(args.sizeWei) / 1e18;
  if (size <= 0) return undefined;
  const fill = Number(args.fill) / 1e8;
  const mid = Number(args.mid) / 1e8;
  const room = Number(args.headroom) / 1e6 - Math.abs(fill - mid) * size;
  if (room <= 0) return undefined;
  const px = args.isLong ? mid - room / size : mid + room / size;
  return px > 0 ? px : undefined;
}

export const px = (n: number) =>
  n.toLocaleString("en-US", {style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0});
