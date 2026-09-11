"use client";

import {useState} from "react";
import {ADDR, publicClient, hasDemoIssuer, awaitTx} from "@/lib/chain";
import {useToast} from "@/components/Toast";
import {demoIssuerAbi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {usePolled} from "@/lib/data";
import {fmtUsd, fmtPct} from "@/lib/format";
import {Panel} from "@/components/ui";

/**
 * The models a tester can claim, mirroring DemoIssuer.Preset. Terms are read from the
 * contract, not from this table — the copy here only explains the trade-off each one makes.
 */
const PRESETS = [
  {
    id: 0,
    name: "Zero",
    tagline: "Best split, hardest payout",
    blurb: "Instant funded. The floor trails up then locks at your starting size. A 15% consistency rule gates every withdrawal.",
  },
  {
    id: 1,
    name: "Evaluation",
    tagline: "Profit is yours to give back",
    blurb: "A static floor that never moves, so a good run cannot be taken away by the floor chasing you up. 35% consistency rule.",
  },
  {
    id: 2,
    name: "Pro",
    tagline: "Tightest risk, cleanest payout",
    blurb: "A 6% static floor and a 3% daily limit — but no consistency rule at all. Nothing gates the withdrawal.",
  },
] as const;

const DRAWDOWN_MODE: Record<number, string> = {
  0: "static",
  1: "trailing",
  2: "trailing to breakeven",
};

/**
 * Self-serve mandate claim.
 *
 * The point of this component is that a stranger can go from landing on the page to trading
 * funded capital without messaging anybody. Terms are read from the contract rather than
 * hardcoded here, so what a tester reads before clicking is exactly what they get.
 */
export function ClaimMandate({onClaimed}: {onClaimed: (mandateId: bigint) => void}) {
  const {address, client, wrongChain, connect, available} = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<number>(0);

  const {data, refresh} = usePolled(async () => {
    if (!hasDemoIssuer) return undefined;
    const [terms, status, made, max] = await Promise.all([
      Promise.all([
        publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "allocation"}),
        publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "maxDrawdownBps"}),
        publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "dailyLossBps"}),
        publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "profitSplitBps"}),
        publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "maxPositionBps"}),
      ]),
      address
        ? publicClient.readContract({
            address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "claimStatus", args: [address],
          })
        : Promise.resolve([false, "Connect a wallet"] as const),
      publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "claimsMade"}),
      publicClient.readContract({address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "maxClaims"}),
    ]);
    const [allocation, , , , pos] = terms as unknown as [bigint, number, number, number, number];
    const [claimable, reason] = status as readonly [boolean, string];

    // Read every preset's real terms from the contract, so the card shows what the chain
    // will actually issue rather than a hardcoded table that can drift out of date.
    const presetTerms = await Promise.all(
      PRESETS.map(
        (p) =>
          publicClient.readContract({
            address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "presetTerms", args: [p.id],
          }) as Promise<{
            maxDrawdownBps: number;
            dailyLossBps: number;
            profitSplitBps: number;
            drawdownMode: number;
            maxConsistencyBps: number;
          }>,
      ),
    );

    return {
      allocation, pos, claimable, reason, presetTerms,
      made: made as bigint, max: max as bigint,
    };
  }, 8_000, [address]);

  if (!hasDemoIssuer) return null;

  async function claim() {
    if (!client || !address) return;
    setBusy(true);
    const t = toast.push({
      kind: "pending",
      title: `Claiming a ${PRESETS[preset]!.name} mandate`,
      body: "Confirm in your wallet.",
    });
    try {
      const hash = await client.writeContract({
        account: address, chain: null,
        address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "claimPreset", args: [preset],
      });
      toast.update(t, {body: "Waiting for confirmation…", hash});
      await awaitTx(hash);
      const id = (await publicClient.readContract({
        address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "mandateOf", args: [address],
      })) as bigint;
      toast.update(t, {
        kind: "success",
        title: `Mandate #${id} is yours`,
        body: "Place a trade and watch your distance to floor.",
        hash,
      });
      refresh();
      onClaimed(id);
    } catch (e) {
      const s = String(e);
      toast.update(t, {
        kind: "error",
        title: "Claim failed",
        body: s.includes("AlreadyClaimed")
          ? "This address already claimed a mandate."
          : s.includes("ClaimLimitReached")
            ? "All demo mandates have been claimed."
            : s.includes("ClaimsClosed")
              ? "Claims are closed on this deployment."
              : s.includes("denied") || s.includes("User rejected")
                ? "Rejected in wallet."
                : s.includes("insufficient funds")
                  ? "Not enough MON for gas — grab some from the faucet."
                  : // Anything else verbatim rather than swallowed: a bare "failed" tells the
                    // user nothing and tells us nothing either.
                    (s.split("\n")[0]?.slice(0, 140) ?? "unknown error"),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Get a mandate"
      right={
        data && (
          <span className="num text-2xs text-txt-lo">
            {data.made.toString()} / {data.max.toString()} claimed
          </span>
        )
      }
    >
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-txt-mid">
          Claim funded testnet capital and trade it under enforced terms. No signup, no
          approval, no one to ask. Breach the drawdown and the contract takes it back — that
          is the thing worth trying to break.
        </p>

        {/* Pick a model. The three differ in the ways traders actually argue about. */}
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={`rounded border px-2 py-2 text-left transition-colors ${
                preset === p.id
                  ? "border-ink-500 bg-ink-800"
                  : "border-edge bg-ink-950 hover:border-ink-600"
              }`}
            >
              <div className="text-xs font-semibold text-txt-hi">{p.name}</div>
              <div className="mt-0.5 text-2xs leading-tight text-txt-lo">{p.tagline}</div>
            </button>
          ))}
        </div>

        <p className="text-2xs leading-relaxed text-txt-mid">{PRESETS[preset]!.blurb}</p>

        {data?.presetTerms[preset] && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded border border-edge bg-ink-950 px-3 py-2.5 text-2xs">
            <Term label="Allocation" value={fmtUsd(data.allocation)} />
            <Term
              label="Max drawdown"
              value={`${fmtPct(data.presetTerms[preset]!.maxDrawdownBps)} ${
                DRAWDOWN_MODE[data.presetTerms[preset]!.drawdownMode] ?? ""
              }`}
            />
            <Term label="Daily loss" value={fmtPct(data.presetTerms[preset]!.dailyLossBps)} />
            <Term label="Position cap" value={`${data.pos / 10000}x`} />
            <Term
              label="Profit split"
              value={`${fmtPct(data.presetTerms[preset]!.profitSplitBps)} to you`}
            />
            <Term
              label="Consistency"
              value={
                data.presetTerms[preset]!.maxConsistencyBps === 0
                  ? "none"
                  : `max ${fmtPct(data.presetTerms[preset]!.maxConsistencyBps)}`
              }
            />
          </div>
        )}

        {!available ? (
          <p className="text-2xs text-txt-lo">
            No wallet detected. Install a browser wallet and add Monad testnet.
          </p>
        ) : !address ? (
          <button onClick={() => void connect()} className="btn w-full py-2">
            Connect wallet
          </button>
        ) : (
          <button
            onClick={claim}
            disabled={busy || wrongChain || !data?.claimable}
            className="btn btn-up w-full py-2"
          >
            {busy
              ? "Claiming…"
              : data?.claimable
                ? `Claim a ${PRESETS[preset]!.name} mandate`
                : (data?.reason ?? "…")}
          </button>
        )}


        <p className="text-2xs leading-relaxed text-txt-lo">
          Terms are read from the contract, not from this page. What you see here is what gets
          issued, and it cannot be changed afterwards.
        </p>
      </div>
    </Panel>
  );
}

function Term({label, value}: {label: string; value: string}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-txt-lo">{label}</span>
      <span className="num text-txt-hi">{value}</span>
    </div>
  );
}
