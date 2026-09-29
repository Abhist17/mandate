"use client";

import {useState} from "react";
import Link from "next/link";
import {Panel, Empty, Skeleton} from "@/components/ui";
import {CountUp} from "@/components/motion";
import {useToast} from "@/components/Toast";
import {useMandates} from "@/lib/useMandates";
import {useWallet} from "@/lib/useWallet";
import {usePolled, type Mandate} from "@/lib/data";
import {previewEnforce, fetchBountyBps, BREACH_RULE, type Preview} from "@/lib/enforce";
import {fetchFeed, type FeedEvent} from "@/lib/feed";
import {ADDR, awaitTx, sendTx, describeRevert, explorerTx, isConfigured} from "@/lib/chain";
import {registryAbi} from "@/lib/abi";
import {fmtUsd, shortAddr} from "@/lib/format";

/**
 * The enforcement market.
 *
 * Every live mandate, ordered by how close it is to its floor, with what enforcing it would
 * pay you right now — and, underneath, the public tape of every mandate funded and every
 * breach enforced.
 *
 * This is what "anyone can enforce" looks like once it is paid. Lending protocols never
 * relied on a trusted liquidator: they paid a bonus and let searchers race. Mandate does the
 * same for a rulebook, so the rules are enforced by whoever gets there first — not by us,
 * and not by anyone who can decide not to.
 */
export default function EnforcePage() {
  const {mandates, refresh} = useMandates();
  const {address} = useWallet();

  const active = (mandates ?? []).filter((m) => m.state.status === 1);
  const key = active.map((m) => m.id.toString()).join(",");

  // One batched poll for every row's preview, as this wallet.
  const {data: previews} = usePolled(
    async () => {
      const out = new Map<string, Preview>();
      await Promise.all(
        active.map((m) =>
          previewEnforce(m.id, address)
            .then((p) => out.set(m.id.toString(), p))
            .catch(() => undefined),
        ),
      );
      return out;
    },
    4_000,
    [key, address],
  );
  const {data: bps} = usePolled(() => fetchBountyBps(), 60_000);
  const {data: feed} = usePolled(() => fetchFeed(), 10_000);

  if (!isConfigured) return <Empty>Contract addresses are not configured.</Empty>;

  const rows = [...active].sort((a, b) => Number(a.headroomBps - b.headroomBps));
  const enforceable = rows.filter((m) => previews?.get(m.id.toString())?.enforceable);

  return (
    <div className="space-y-5">
      <header className="max-w-3xl space-y-2">
        <div className="num flex items-center gap-2 text-2xs uppercase tracking-[0.16em] text-txt-lo">
          <span className="text-acc-hi">Enforcement market</span>
          <span className="h-px w-6 bg-edge-hi" />
          open to every wallet
        </div>
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-txt-hi">
          Breaches pay whoever enforces them.
        </h1>
        <p className="text-sm leading-relaxed text-txt-mid">
          The first wallet to call <span className="num text-txt-hi">markAndEnforce</span> on a
          mandate that has crossed its floor closes it and is paid{" "}
          <span className="num text-up">{bps !== undefined ? `${(bps / 100).toFixed(2)}%` : "—"}</span> of its
          allocation, out of the capital the enforcement protects. No keeper to trust, no role to
          hold: the rules are enforced by whoever gets there first.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Live mandates" value={<CountUp value={mandates ? active.length : undefined} format={(n) => String(Math.round(n))} duration={500} />} />
        <Tile
          label="Enforceable now"
          value={<CountUp value={previews ? enforceable.length : undefined} format={(n) => String(Math.round(n))} duration={500} />}
          tone={enforceable.length ? "down" : undefined}
        />
        <Tile
          label="Bounty per $100k"
          value={<CountUp value={bps !== undefined ? (100_000 * bps) / 10_000 : undefined} format={(n) => fmtUsd(BigInt(Math.round(n * 1e6)))} duration={600} />}
          tone="up"
        />
        <Tile
          label="Bounties paid"
          value={<CountUp value={feed ? Number(feed.totals.bountiesPaid) / 1e6 : undefined} format={(n) => fmtUsd(BigInt(Math.round(n * 1e6)))} />}
          sub={feed ? `${feed.totals.enforcements} enforcements in the readable window` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Board" right={<span className="text-2xs text-txt-lo">closest to its floor first</span>}>
          {!mandates ? (
            <div className="space-y-3 p-4">
              {Array.from({length: 4}).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Empty>No live mandates. Nothing to enforce.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
                    <th className="px-4 py-2 text-left font-medium">Mandate</th>
                    <th className="px-4 py-2 text-right font-medium">Equity</th>
                    <th className="px-4 py-2 text-right font-medium">Floor</th>
                    <th className="px-4 py-2 text-left font-medium">Distance</th>
                    <th className="px-4 py-2 text-right font-medium">If you enforce</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <Row key={m.id.toString()} m={m} p={previews?.get(m.id.toString())} onDone={refresh} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="For searchers">
            <div className="space-y-3 p-4">
              <p className="text-2xs leading-relaxed text-txt-mid">
                Three calls, all public. The preview runs the same rules enforcement runs, against
                live equity, and tells you what you will be paid.
              </p>
              <pre className="num overflow-x-auto rounded-lg border border-edge bg-ink-980 p-3 text-[0.65rem] leading-relaxed text-txt-mid">
{`ids = registry.activeMandates()

for id in ids:
  ok, rule, equity, floor, bounty =
      registry.previewEnforce(id)
  if ok:
      registry.markAndEnforce(id)
      # flattens, settles, pays you — one tx`}
              </pre>
              <p className="text-2xs leading-relaxed text-txt-lo">
                The trader is never paid for enforcing their own mandate, and the bounty never comes
                out of their share.
              </p>
            </div>
          </Panel>

          <Panel title="Tape" right={<span className="flex items-center gap-1.5 text-2xs text-txt-lo"><span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />live</span>}>
            {!feed ? (
              <div className="space-y-2 p-4">
                {Array.from({length: 5}).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : feed.events.length === 0 ? (
              <Empty>Nothing in the readable window yet.</Empty>
            ) : (
              <ol className="divide-y divide-edge/60">
                {feed.events.slice(0, 14).map((e) => (
                  <Tape key={e.key} e={e} />
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Row({m, p, onDone}: {m: Mandate; p: Preview | undefined; onDone: () => void}) {
  const {address, client, wrongChain, connect} = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const bps = Number(m.headroomBps);
  const enforceable = p?.enforceable ?? false;
  const width = Math.max(2, Math.min(100, bps / 5)); // 500 bps (5%) fills the bar

  async function enforce() {
    if (!client || !address) return void connect();
    setBusy(true);
    const id = toast.push({kind: "pending", title: `Enforcing mandate #${m.id}`, body: "Marking, flattening and settling."});
    try {
      const hash = await sendTx({client, account: address, address: ADDR.registry, abi: registryAbi, functionName: "markAndEnforce", args: [m.id]});
      toast.update(id, {body: "Waiting for confirmation…", hash});
      await awaitTx(hash);
      toast.update(id, {
        kind: "success",
        title: `Mandate #${m.id} enforced`,
        body: p && p.bounty > 0n ? `The contract paid you ${fmtUsd(p.bounty)} for it.` : "Enforced.",
        hash,
      });
      onDone();
    } catch (e) {
      toast.update(id, {kind: "error", title: "Enforcement failed", body: describeRevert(e).slice(0, 140)});
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={`border-b border-edge/50 last:border-0 ${enforceable ? "bg-down/[0.06]" : "row-hover"}`}>
      <td className="px-4 py-2.5">
        <Link href={`/trade?m=${m.id}`} className="num text-txt-hi hover:text-acc-hi">
          #{m.id.toString()}
        </Link>
        <span className="num ml-2 text-2xs text-txt-lo">{shortAddr(m.state.trader)}</span>
      </td>
      <td className="num px-4 py-2.5 text-right text-txt-hi">{fmtUsd(m.liveEquity)}</td>
      <td className="num px-4 py-2.5 text-right text-down">{fmtUsd(m.floor)}</td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
            <div
              className={`h-full rounded-full ${enforceable ? "bg-down" : bps < 150 ? "bg-down" : bps < 400 ? "bg-warn" : "bg-up"}`}
              style={{width: `${enforceable ? 100 : width}%`}}
            />
          </div>
          <span className={`num text-2xs ${enforceable ? "text-down" : "text-txt-mid"}`}>
            {enforceable ? BREACH_RULE[p!.rule] : `${(bps / 100).toFixed(2)}%`}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 text-right">
        {enforceable ? (
          <button
            onClick={() => void enforce()}
            disabled={busy || wrongChain}
            className="btn btn-down whitespace-nowrap py-1.5 font-semibold"
          >
            {busy ? "Enforcing…" : p && p.bounty > 0n ? `Enforce · earn ${fmtUsd(p.bounty)}` : "Enforce"}
          </button>
        ) : (
          <span className="text-2xs text-txt-lo">watching</span>
        )}
      </td>
    </tr>
  );
}

function Tape({e}: {e: FeedEvent}) {
  const when = e.at ? new Date(e.at * 1000).toLocaleTimeString("en-GB") : `#${e.block}`;
  return (
    <li className="flex gap-3 px-4 py-2 text-2xs">
      <a href={explorerTx(e.tx)} target="_blank" rel="noreferrer" className="num shrink-0 text-txt-lo hover:text-txt-hi">
        {when}
      </a>
      {e.kind === "funded" ? (
        <span className="text-txt-mid">
          <span className="text-acc-hi">funded</span> #{e.mandateId.toString()} ·{" "}
          <span className="num text-txt-hi">{fmtUsd(e.amount)}</span> to{" "}
          <span className="num">{shortAddr(e.who)}</span>
        </span>
      ) : (
        <span className="text-txt-mid">
          <span className="text-down">enforced</span> #{e.mandateId.toString()} ·{" "}
          {BREACH_RULE[e.rule ?? 0]?.toLowerCase()} · by <span className="num">{shortAddr(e.who)}</span>
          {e.amount > 0n && (
            <>
              {" "}
              · <span className="num text-up">+{fmtUsd(e.amount)}</span>
            </>
          )}
        </span>
      )}
    </li>
  );
}

function Tile({label, value, sub, tone}: {label: string; value: React.ReactNode; sub?: string; tone?: "up" | "down"}) {
  return (
    <div className="panel px-4 py-3.5">
      <div className="stat-label">{label}</div>
      <div className={`figure font-mono mt-1.5 text-xl ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-txt-hi"}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-2xs text-txt-lo">{sub}</div>}
    </div>
  );
}
