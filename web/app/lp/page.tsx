"use client";

import {useState} from "react";
import {Panel, Stat, StatusPill, Field, Empty, LiveDot} from "@/components/ui";
import {fetchMandate, fetchPoolStats, usePolled, type Mandate} from "@/lib/data";
import {publicClient, ADDR, isConfigured, explorerAddr, BREACH_KIND} from "@/lib/chain";
import {registryAbi, poolExtraAbi, erc20Abi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {fmtUsd, fmtBps, fmtSigned, shortAddr, timeAgo, fmtPct} from "@/lib/format";

/**
 * LP view.
 *
 * An LP is buying two things: a return, and a bound on how badly any one trader can hurt
 * them. So the page leads with utilisation and per-mandate headroom rather than APY — the
 * risk being run is more informative than the yield already earned, and it is the number
 * that is actually decision-relevant before depositing.
 */
export default function LpPage() {
  const {address} = useWallet();

  const {data: pool} = usePolled(fetchPoolStats, 3_000);

  const {data: mandates} = usePolled(async () => {
    const active = (await publicClient.readContract({
      address: ADDR.registry,
      abi: registryAbi,
      functionName: "activeMandates",
    })) as readonly bigint[];
    const highest = active.length > 0 ? active[active.length - 1]! : 0n;
    const ids: bigint[] = [];
    for (let i = 1n; i <= highest + 6n; i++) ids.push(i);
    const all = await Promise.all(ids.map((id) => fetchMandate(id).catch(() => undefined)));
    return all.filter((m): m is Mandate => m !== undefined);
  }, 4_000);

  const {data: position, refresh} = usePolled(async () => {
    if (!address) return undefined;
    const [shares, assetBal, claim] = await Promise.all([
      publicClient.readContract({address: ADDR.pool, abi: poolExtraAbi, functionName: "balanceOf", args: [address]}),
      publicClient.readContract({address: ADDR.asset, abi: erc20Abi, functionName: "balanceOf", args: [address]}),
      publicClient.readContract({address: ADDR.pool, abi: poolExtraAbi, functionName: "previewClaim", args: [address]}),
    ]);
    const value = (await publicClient.readContract({
      address: ADDR.pool,
      abi: poolExtraAbi,
      functionName: "convertToAssets",
      args: [shares as bigint],
    })) as bigint;
    const [claimAssets, ready, funded] = claim as readonly [bigint, boolean, boolean];
    return {shares: shares as bigint, value, assetBal: assetBal as bigint, claimAssets, ready, funded};
  }, 4_000, [address]);

  if (!isConfigured) {
    return (
      <Panel title="Not configured">
        <Empty>Deploy the contracts and fill in .env.</Empty>
      </Panel>
    );
  }

  const active = mandates?.filter((m) => m.state.status === 1) ?? [];
  const closed = mandates?.filter((m) => m.state.status > 1) ?? [];
  const breachCount = closed.filter((m) => m.state.status === 2).length;

  return (
    <div className="space-y-4">
      <Panel title="Capital pool" right={<LiveDot />}>
        <div className="grid grid-cols-2 gap-5 p-4 md:grid-cols-5">
          <Stat label="Total value" value={fmtUsd(pool?.totalAssets)} size="xl" />
          <Stat label="Idle" value={fmtUsd(pool?.idle)} sub="available to allocate or withdraw" size="lg" />
          <Stat label="Allocated" value={fmtUsd(pool?.allocated)} sub="locked inside live mandates" size="lg" />
          <Stat label="Utilisation" value={fmtBps(pool?.utilisationBps)} size="lg" />
          <Stat label="Price per share" value={fmtUsd(pool?.pricePerShare)} size="lg" />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Panel
            title={`Active mandates (${active.length})`}
            right={<span className="text-2xs text-txt-lo">sorted by distance to floor</span>}
          >
            {active.length === 0 ? (
              <Empty>No live mandates.</Empty>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
                    <th className="px-4 py-2 text-left font-medium">Mandate</th>
                    <th className="px-4 py-2 text-left font-medium">Trader</th>
                    <th className="px-4 py-2 text-right font-medium">Allocation</th>
                    <th className="px-4 py-2 text-right font-medium">Equity</th>
                    <th className="px-4 py-2 text-right font-medium">P&L</th>
                    <th className="px-4 py-2 text-right font-medium">Notional</th>
                    <th className="px-4 py-2 text-right font-medium">To floor</th>
                    <th className="px-4 py-2 text-right font-medium">Marked</th>
                  </tr>
                </thead>
                <tbody>
                  {[...active]
                    .sort((a, b) => Number(a.headroomBps) - Number(b.headroomBps))
                    .map((m) => {
                      const pnl = m.liveEquity - m.terms.allocation;
                      const bps = Number(m.headroomBps);
                      const tone = bps < 150 ? "text-down" : bps < 350 ? "text-warn" : "text-up";
                      return (
                        <tr key={m.id.toString()} className="border-b border-edge/60 last:border-0">
                          <td className="px-4 py-2.5">
                            <a
                              href={explorerAddr(m.state.account)}
                              target="_blank"
                              rel="noreferrer"
                              className="num text-txt-hi underline decoration-ink-600"
                            >
                              #{m.id.toString()}
                            </a>
                          </td>
                          <td className="num px-4 py-2.5 text-txt-mid">{shortAddr(m.state.trader)}</td>
                          <td className="num px-4 py-2.5 text-right text-txt-mid">
                            {fmtUsd(m.terms.allocation)}
                          </td>
                          <td className="num px-4 py-2.5 text-right text-txt-hi">{fmtUsd(m.liveEquity)}</td>
                          <td
                            className={`num px-4 py-2.5 text-right ${pnl >= 0n ? "text-up" : "text-down"}`}
                          >
                            {fmtSigned(pnl)}
                          </td>
                          <td className="num px-4 py-2.5 text-right text-txt-mid">{fmtUsd(m.notional)}</td>
                          <td className={`num px-4 py-2.5 text-right ${tone}`}>
                            {fmtUsd(m.headroom)}
                            <span className="ml-1.5 text-2xs text-txt-lo">{fmtBps(m.headroomBps)}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right text-2xs text-txt-lo">
                            {timeAgo(m.state.lastMarkedAt)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title={`History (${closed.length})`}
            right={
              <span className="text-2xs text-txt-lo">
                {breachCount} enforced by the contract
              </span>
            }
          >
            {closed.length === 0 ? (
              <Empty>Nothing settled yet.</Empty>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-edge text-2xs uppercase tracking-wider text-txt-lo">
                    <th className="px-4 py-2 text-left font-medium">Mandate</th>
                    <th className="px-4 py-2 text-left font-medium">Trader</th>
                    <th className="px-4 py-2 text-left font-medium">Outcome</th>
                    <th className="px-4 py-2 text-right font-medium">Allocation</th>
                    <th className="px-4 py-2 text-right font-medium">Final equity</th>
                    <th className="px-4 py-2 text-right font-medium">Pool result</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((m) => {
                    const delta = m.state.lastMarkedEquity - m.terms.allocation;
                    return (
                      <tr key={m.id.toString()} className="border-b border-edge/60 last:border-0">
                        <td className="num px-4 py-2.5 text-txt-hi">#{m.id.toString()}</td>
                        <td className="num px-4 py-2.5 text-txt-mid">{shortAddr(m.state.trader)}</td>
                        <td className="px-4 py-2.5">
                          <StatusPill status={m.state.status} />
                          {m.state.breachKind > 0 && (
                            <span className="ml-2 text-2xs text-txt-lo">
                              {BREACH_KIND[m.state.breachKind]}
                            </span>
                          )}
                        </td>
                        <td className="num px-4 py-2.5 text-right text-txt-mid">
                          {fmtUsd(m.terms.allocation)}
                        </td>
                        <td className="num px-4 py-2.5 text-right text-txt-hi">
                          {fmtUsd(m.state.lastMarkedEquity)}
                        </td>
                        <td
                          className={`num px-4 py-2.5 text-right ${delta >= 0n ? "text-up" : "text-down"}`}
                        >
                          {fmtSigned(delta)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <LpActions position={position} onDone={refresh} />

          <Panel title="What you are underwriting">
            <div className="divide-y divide-edge px-4 py-1">
              <Field label="Max per mandate" value="20% of pool" />
              <Field label="Withdrawal delay" value="60s" />
              <Field label="Loss cap per mandate" value="its allocation" />
            </div>
            <div className="space-y-2 border-t border-edge px-4 py-3 text-2xs leading-relaxed text-txt-lo">
              <p>
                Share price counts mandate equity at its last mark, so it trails the market by
                at most one keeper mark.
              </p>
              <p>
                Withdrawals are priced at claim time, not request time — you cannot lock a price
                and wait to see whether the next mark goes your way.
              </p>
              <p>
                Breach losses are socialised across all shares. The per-mandate cap is what bounds
                them.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

type LpPosition = {
  shares: bigint;
  value: bigint;
  assetBal: bigint;
  claimAssets: bigint;
  ready: boolean;
  funded: boolean;
} | undefined;

function LpActions({position, onDone}: {position: LpPosition; onDone: () => void}) {
  const {address, client, wrongChain} = useWallet();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  const units = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
  })();

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!client || !address) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const hash = await fn();
      await publicClient.waitForTransactionReceipt({hash});
      setMsg(`${label} confirmed`);
      onDone();
    } catch (e) {
      setMsg(String(e).includes("denied") ? "Rejected in wallet." : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }

  const deposit = () =>
    run("Deposit", async () => {
      const approve = await client!.writeContract({
        account: address!, chain: null, address: ADDR.asset, abi: erc20Abi,
        functionName: "approve", args: [ADDR.pool, units],
      });
      await publicClient.waitForTransactionReceipt({hash: approve});
      return client!.writeContract({
        account: address!, chain: null, address: ADDR.pool, abi: poolExtraAbi,
        functionName: "deposit", args: [units, address!],
      });
    });

  const requestOut = () =>
    run("Withdrawal request", () =>
      client!.writeContract({
        account: address!, chain: null, address: ADDR.pool, abi: poolExtraAbi,
        functionName: "requestWithdrawal", args: [position!.shares],
      }),
    );

  const claim = () =>
    run("Claim", () =>
      client!.writeContract({
        account: address!, chain: null, address: ADDR.pool, abi: poolExtraAbi,
        functionName: "claimWithdrawal", args: [],
      }),
    );

  const mint = () =>
    run("Faucet", () =>
      client!.writeContract({
        account: address!, chain: null, address: ADDR.asset, abi: erc20Abi,
        functionName: "mint", args: [address!, 100_000n * 1_000_000n],
      }),
    );

  if (!address) {
    return (
      <Panel title="Your position">
        <Empty>Connect a wallet to deposit.</Empty>
      </Panel>
    );
  }

  const pending = position && position.claimAssets > 0n;

  return (
    <Panel title="Your position">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Shares" value={fmtUsd(position?.shares)} />
          <Stat label="Value" value={fmtUsd(position?.value)} />
        </div>

        <div className="border-t border-edge pt-3">
          <label className="stat-label">Deposit amount</label>
          <input
            className="input num mt-1"
            value={amount}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="mt-1 flex items-center justify-between text-2xs text-txt-lo">
            <span>wallet {fmtUsd(position?.assetBal)}</span>
            <button onClick={mint} disabled={busy} className="underline hover:text-txt-hi">
              faucet 100k
            </button>
          </div>
        </div>

        <button
          onClick={deposit}
          disabled={busy || wrongChain || units === 0n}
          className="btn btn-up w-full py-2"
        >
          {busy ? "…" : "Deposit"}
        </button>

        {pending ? (
          <div className="space-y-2 border-t border-edge pt-3">
            <Field label="Pending withdrawal" value={fmtUsd(position!.claimAssets)} />
            <button
              onClick={claim}
              disabled={busy || !position!.ready || !position!.funded}
              className="btn w-full py-2"
            >
              {!position!.ready
                ? "Maturing…"
                : !position!.funded
                  ? "Waiting for idle capital"
                  : "Claim"}
            </button>
            {!position!.funded && position!.ready && (
              <p className="text-2xs text-txt-lo">
                Not enough idle capital — allocated capital is locked until a mandate settles.
              </p>
            )}
          </div>
        ) : (
          <button
            onClick={requestOut}
            disabled={busy || !position || position.shares === 0n}
            className="btn w-full py-2"
          >
            Request full withdrawal
          </button>
        )}

        {msg && <div className="text-2xs text-txt-mid">{msg}</div>}
      </div>
    </Panel>
  );
}
