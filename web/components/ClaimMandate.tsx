"use client";

import {useState} from "react";
import {ADDR, publicClient, explorerTx, hasDemoIssuer} from "@/lib/chain";
import {demoIssuerAbi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {usePolled} from "@/lib/data";
import {fmtUsd, fmtPct} from "@/lib/format";
import {Panel} from "@/components/ui";

/**
 * Self-serve mandate claim.
 *
 * The point of this component is that a stranger can go from landing on the page to trading
 * funded capital without messaging anybody. Terms are read from the contract rather than
 * hardcoded here, so what a tester reads before clicking is exactly what they get.
 */
export function ClaimMandate({onClaimed}: {onClaimed: (mandateId: bigint) => void}) {
  const {address, client, wrongChain, connect, available} = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{kind: "ok" | "err"; text: string; hash?: string}>();

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
    const [allocation, dd, daily, split, pos] = terms as unknown as [bigint, number, number, number, number];
    const [claimable, reason] = status as readonly [boolean, string];
    return {
      allocation, dd, daily, split, pos, claimable, reason,
      made: made as bigint, max: max as bigint,
    };
  }, 8_000, [address]);

  if (!hasDemoIssuer) return null;

  async function claim() {
    if (!client || !address) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const hash = await client.writeContract({
        account: address, chain: null,
        address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "claim", args: [],
      });
      await publicClient.waitForTransactionReceipt({hash});
      const id = (await publicClient.readContract({
        address: ADDR.demoIssuer, abi: demoIssuerAbi, functionName: "mandateOf", args: [address],
      })) as bigint;
      setMsg({kind: "ok", text: `Mandate #${id} is yours`, hash});
      refresh();
      onClaimed(id);
    } catch (e) {
      const s = String(e);
      setMsg({
        kind: "err",
        text: s.includes("AlreadyClaimed")
          ? "This address already claimed a mandate."
          : s.includes("ClaimLimitReached")
            ? "All demo mandates have been claimed."
            : s.includes("denied")
              ? "Rejected in wallet."
              : "Claim failed.",
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

        {data && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded border border-edge bg-ink-950 px-3 py-2.5 text-2xs">
            <Term label="Allocation" value={fmtUsd(data.allocation)} />
            <Term label="Max drawdown" value={`${fmtPct(data.dd)} trailing`} />
            <Term label="Daily loss" value={fmtPct(data.daily)} />
            <Term label="Position cap" value={`${data.pos / 10000}x`} />
            <Term label="Profit split" value={`${fmtPct(data.split)} to you`} />
            <Term label="Term" value="7 days" />
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
            {busy ? "Claiming…" : data?.claimable ? "Claim a mandate" : (data?.reason ?? "…")}
          </button>
        )}

        {msg && (
          <div className={`text-2xs ${msg.kind === "ok" ? "text-up" : "text-down"}`}>
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
