import {mkdirSync, readFileSync, writeFileSync, existsSync} from "node:fs";
import {dirname} from "node:path";

/**
 * Append-only local store of every mark the keeper performs.
 *
 * This exists for one reason: the pitch needs a measured number, not an estimate.
 * "We marked N mandates across M blocks for $X of gas" is the entire economic argument for
 * why a continuous per-block risk loop is viable on Monad and nowhere else. That number comes
 * from here.
 */

export type MarkRecord = {
  ts: number;
  blockNumber: string;
  mandateIds: string[];
  breaches: number;
  gasUsed: string;
  effectiveGasPrice: string;
  /** Gas cost in MON. */
  costMon: number;
  txHash: string;
  prices: Record<string, number>;
};

export type StoreShape = {
  startedAt: number;
  marks: MarkRecord[];
  totals: {
    marks: number;
    mandateMarks: number;
    breaches: number;
    gasUsed: string;
    costMon: number;
    blocksObserved: number;
  };
};

const EMPTY: StoreShape = {
  startedAt: Date.now(),
  marks: [],
  totals: {marks: 0, mandateMarks: 0, breaches: 0, gasUsed: "0", costMon: 0, blocksObserved: 0},
};

export class MarkStore {
  private data: StoreShape;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as StoreShape;
      } catch {
        // A corrupt store must never stop the keeper enforcing. Start fresh and carry on.
        this.data = {...EMPTY, startedAt: Date.now()};
      }
    } else {
      this.data = {...EMPTY, startedAt: Date.now()};
    }
  }

  record(mark: MarkRecord): void {
    this.data.marks.push(mark);
    const t = this.data.totals;
    t.marks += 1;
    t.mandateMarks += mark.mandateIds.length;
    t.breaches += mark.breaches;
    t.gasUsed = (BigInt(t.gasUsed) + BigInt(mark.gasUsed)).toString();
    t.costMon += mark.costMon;
    this.flush();
  }

  observeBlock(): void {
    this.data.totals.blocksObserved += 1;
  }

  get totals(): StoreShape["totals"] {
    return this.data.totals;
  }

  /** Average gas cost of marking a single mandate — the benchmark number for the pitch. */
  get costPerMandateMark(): number {
    const {mandateMarks, costMon} = this.data.totals;
    return mandateMarks === 0 ? 0 : costMon / mandateMarks;
  }

  flush(): void {
    mkdirSync(dirname(this.path), {recursive: true});
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}
