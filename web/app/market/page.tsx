"use client";

import {useState} from "react";
import type {Address} from "viem";
import {Panel, Stat, Field, Empty, Explainer, LiveDot} from "@/components/ui";
import {publicClient, ADDR, hasBook, isConfigured, explorerTx, shortAddrSafe} from "@/lib/chain";
import {bookAbi, registryAbi, erc20Abi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {usePolled} from "@/lib/data";
import {fmtUsd, fmtBps, fmtPct, shortAddr} from "@/lib/format";

/**
 * The market for trader risk.
 *
 * This page is the part of the product that has no equivalent anywhere — onchain or off. A
 * prop firm publishes one menu and every trader takes it or leaves. Here LPs post capital
 * against the record they want, traders who qualify take it without asking, and two LPs who
 * want the same trader compete by improving their terms.
 *
 * The left column is a trader's own credential; the right is what the market will pay for it.
 */

type TraderRecord = {
  mandatesIssued: number;
  mandatesSettled: number;
  breaches: number;
  profitableExits: number;
  daysTraded: number;
  capitalEntrusted: bigint;
  realisedProfit: bigint;
  realisedLoss: bigint;
  bestConsistencyBps: number;
  firstMandateAt: bigint;
};

type Offer = {
  id: bigint;
  lp: Address;
  allocation: bigint;
  slotsTotal: number;
  slotsTaken: number;
  profitSplitBps: number;
  maxDrawdownBps: number;
  dailyLossBps: number;
  drawdownMode: number;
  maxConsistencyBps: number;
  criteria: {
    minMandatesSettled: number;
    maxBreaches: number;
    minProfitableExits: number;
    minDaysTraded: number;
    minRealisedProfit: bigint;
    maxConsistencyBps: number;
  };
  qualifies: boolean;
  reason: string;
};

const DRAWDOWN_MODE: Record<number, string> = {0: "static", 1: "trailing", 2: "trailing to b/e"};
const NO_LIMIT = 4_294_967_295;

export default function MarketPage() {
  const {address} = useWallet();

  const {data, refresh} = usePolled(async () => {
    if (!hasBook) return undefined;
    const ids = (await publicClient.readContract({
      address: ADDR.book, abi: bookAbi, functionName: "openOffers",
    })) as readonly bigint[];

    const offers: Offer[] = await Promise.all(
      ids.map(async (id) => {
        const o = (await publicClient.readContract({
          address: ADDR.book, abi: bookAbi, functionName: "offerAt", args: [id],
        })) as {
          lp: Address; allocation: bigint; slotsTotal: number; slotsTaken: number;
          terms: {
            profitSplitBps: number; maxDrawdownBps: number; dailyLossBps: number;
            drawdownMode: number; maxConsistencyBps: number;
          };
          criteria: Offer["criteria"];
        };
        let qualifies = false;
        let reason = "Connect a wallet to check";
        if (address) {
          const q = (await publicClient.readContract({
            address: ADDR.book, abi: bookAbi, functionName: "qualifies", args: [id, address],
          })) as readonly [boolean, string];
          qualifies = q[0];
          reason = q[1];
        }
        return {
          id, lp: o.lp, allocation: o.allocation,
          slotsTotal: Number(o.slotsTotal), slotsTaken: Number(o.slotsTaken),
          profitSplitBps: Number(o.terms.profitSplitBps),
          maxDrawdownBps: Number(o.terms.maxDrawdownBps),
          dailyLossBps: Number(o.terms.dailyLossBps),
          drawdownMode: Number(o.terms.drawdownMode),
          maxConsistencyBps: Number(o.terms.maxConsistencyBps),
          criteria: o.criteria, qualifies, reason,
        };
      }),
    );

    const record = address
      ? ((await publicClient.readContract({
          address: ADDR.registry, abi: registryAbi, functionName: "recordOf", args: [address],
        })) as TraderRecord)
      : undefined;

    return {offers, record};
  }, 5_000, [address]);

  if (!isConfigured || !hasBook) {
    return (
      <Panel title="Market unavailable">
        <Empty>The underwriting book is not deployed on this network.</Empty>
      </Panel>
    );
  }

  const offers = data?.offers ?? [];
  const best = offers.filter((o) => o.qualifies).sort((a, b) => b.profitSplitBps - a.profitSplitBps)[0];

  return (
    <div className="space-y-4">
      <Explainer>
        <h1 className="text-base font-semibold tracking-tight text-txt-hi">
          Capital competes for traders. Not the other way round.
        </h1>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-txt-mid">
          A prop firm publishes one set of terms and everyone takes it or leaves — and it earns
          challenge fees whether you succeed or not. Here anyone with capital posts an offer
          against the record they want, and{" "}
          <span className="text-txt-hi">any trader who meets it takes it without asking
          permission</span>. Two backers who want the same trader compete by improving their
          terms. No challenge fees. Nobody earns anything when a trader fails.
        </p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-txt-lo">
          This works because your record below was written by the contract that enforced the
          rules it describes — not claimed by you, and not vouched for by a firm. That is why
          it travels.
        </p>
      </Explainer>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_1fr]">
        <RecordCard record={data?.record} address={address} best={best} />
        <OffersTable offers={offers} onClaimed={refresh} />
      </div>
    </div>
  );
}

function RecordCard({
  record,
  address,
  best,
}: {
  record: TraderRecord | undefined;
  address: Address | undefined;
  best: Offer | undefined;
}) {
  if (!address) {
    return (
      <Panel title="Your record">
        <Empty>Connect a wallet to see your track record.</Empty>
      </Panel>
    );
  }

  const r = record;
  const unproven = !r || r.mandatesSettled === 0;
  const net = r ? r.realisedProfit - r.realisedLoss : 0n;

  return (
    <div className="space-y-4">
      <Panel title="Your record" right={<LiveDot />}>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Mandates settled"
              value={r?.mandatesSettled ?? 0}
              sub={`${r?.mandatesIssued ?? 0} issued`}
              size="lg"
            />
            <Stat
              label="Breaches"
              value={r?.breaches ?? 0}
              tone={(r?.breaches ?? 0) === 0 ? "up" : "down"}
              size="lg"
            />
          </div>

          <div className="divide-y divide-edge border-t border-edge pt-1">
            <Field label="Profitable exits" value={String(r?.profitableExits ?? 0)} />
            <Field label="Days traded" value={String(r?.daysTraded ?? 0)} />
            <Field
              label="Best consistency"
              value={r && r.bestConsistencyBps > 0 ? fmtBps(r.bestConsistencyBps) : "—"}
            />
            <Field label="Capital entrusted" value={fmtUsd(r?.capitalEntrusted)} />
            <Field label="Lifetime profit" value={fmtUsd(r?.realisedProfit)} />
            <Field label="Lifetime loss" value={fmtUsd(r?.realisedLoss)} />
          </div>

          <div className="rounded-lg border border-edge bg-ink-950/60 px-3 py-2.5">
            <div className="stat-label">Net realised</div>
            <div className={`figure font-mono mt-1 text-lg ${net >= 0n ? "text-up" : "text-down"}`}>
              {net >= 0n ? "+" : "−"}
              {fmtUsd(net >= 0n ? net : -net)}
            </div>
          </div>

          {unproven ? (
            <p className="text-2xs leading-relaxed text-txt-lo">
              No settled mandates yet. Take an open offer, trade it to a close, and this record
              starts working for you — everywhere, not just here.
            </p>
          ) : (
            <p className="text-2xs leading-relaxed text-txt-lo">
              Written by the enforcement contract at settlement. Anyone can read it and nobody
              can edit it — including us.
            </p>
          )}
        </div>
      </Panel>

      {best && (
        <Panel title="Best terms you qualify for">
          <div className="p-4">
            <div className="figure font-mono text-3xl text-up drop-shadow-[0_0_18px_rgba(0,227,155,0.4)]">
              {fmtPct(best.profitSplitBps)}
            </div>
            <div className="mt-1 text-2xs text-txt-lo">
              profit split on {fmtUsd(best.allocation)} · offered by {shortAddr(best.lp)}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function OffersTable({offers, onClaimed}: {offers: Offer[]; onClaimed: () => void}) {
  const {address, client, wrongChain} = useWallet();
  const [busy, setBusy] = useState<bigint>();
  const [msg, setMsg] = useState<{ok: boolean; text: string; hash?: string}>();

  async function claim(id: bigint) {
    if (!client || !address) return;
    setBusy(id);
    setMsg(undefined);
    try {
      const hash = await client.writeContract({
        account: address, chain: null,
        address: ADDR.book, abi: bookAbi, functionName: "claim", args: [id],
      });
      await publicClient.waitForTransactionReceipt({hash});
      setMsg({ok: true, text: "Mandate issued. It's yours to trade.", hash});
      onClaimed();
    } catch (e) {
      const s = String(e);
      setMsg({
        ok: false,
        text: s.includes("RecordDoesNotQualify")
          ? "Your record doesn't meet this offer."
          : s.includes("denied")
            ? "Rejected in wallet."
            : "Claim failed.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Panel
      title={`Open offers (${offers.length})`}
      right={<span className="text-2xs text-txt-lo">sorted by split</span>}
    >
      {offers.length === 0 ? (
        <Empty>
          No open offers. Anyone can post one — capital plus the record they want behind it.
        </Empty>
      ) : (
        <div className="divide-y divide-edge">
          {[...offers]
            .sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.profitSplitBps - a.profitSplitBps)
            .map((o) => (
              <div key={o.id.toString()} className="row-hover p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="figure font-mono text-2xl text-txt-hi">
                        {fmtUsd(o.allocation)}
                      </span>
                      <span
                        className={`figure font-mono text-lg ${o.qualifies ? "text-up" : "text-txt-mid"}`}
                      >
                        {fmtPct(o.profitSplitBps)}
                      </span>
                      <span className="text-2xs text-txt-lo">to trader</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-txt-lo">
                      <span>
                        {fmtPct(o.maxDrawdownBps)} {DRAWDOWN_MODE[o.drawdownMode]}
                      </span>
                      <span>· {fmtPct(o.dailyLossBps)} daily</span>
                      {o.maxConsistencyBps > 0 && (
                        <span>· {fmtPct(o.maxConsistencyBps)} consistency</span>
                      )}
                      <span>· by {shortAddr(o.lp)}</span>
                      <span>
                        · {o.slotsTotal - o.slotsTaken} of {o.slotsTotal} left
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {o.qualifies ? (
                      <button
                        onClick={() => void claim(o.id)}
                        disabled={busy !== undefined || wrongChain || !address}
                        className="btn btn-up px-4 font-semibold"
                      >
                        {busy === o.id ? "Claiming…" : "Take this offer"}
                      </button>
                    ) : (
                      <>
                        <span className="btn cursor-default opacity-45">Locked</span>
                        <span className="max-w-[190px] text-right text-2xs text-warn">
                          {o.reason}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <Requirements c={o.criteria} />
              </div>
            ))}
        </div>
      )}

      {msg && (
        <div className={`border-t border-edge px-4 py-2.5 text-2xs ${msg.ok ? "text-up" : "text-down"}`}>
          {msg.text}
          {msg.hash && (
            <>
              {" · "}
              <a className="underline" href={explorerTx(msg.hash)} target="_blank" rel="noreferrer">
                tx
              </a>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

/** What the backer wants to see before they'll fund you. */
function Requirements({c}: {c: Offer["criteria"]}) {
  const reqs: string[] = [];
  if (c.minMandatesSettled > 0) reqs.push(`${c.minMandatesSettled}+ settled`);
  if (c.maxBreaches < NO_LIMIT) reqs.push(`≤${c.maxBreaches} breaches`);
  if (c.minProfitableExits > 0) reqs.push(`${c.minProfitableExits}+ profitable exits`);
  if (c.minDaysTraded > 0) reqs.push(`${c.minDaysTraded}+ days traded`);
  if (c.minRealisedProfit > 0n) reqs.push(`${fmtUsd(c.minRealisedProfit)}+ lifetime profit`);
  if (c.maxConsistencyBps > 0) reqs.push(`consistency ≤${fmtPct(c.maxConsistencyBps)}`);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-2xs uppercase tracking-[0.1em] text-txt-lo">Requires</span>
      {reqs.length === 0 ? (
        <span className="rounded-md border border-edge bg-ink-950 px-2 py-0.5 text-2xs text-txt-mid">
          open to anyone
        </span>
      ) : (
        reqs.map((r) => (
          <span
            key={r}
            className="num rounded-md border border-edge bg-ink-950 px-2 py-0.5 text-2xs text-txt-mid"
          >
            {r}
          </span>
        ))
      )}
    </div>
  );
}

void shortAddrSafe;
