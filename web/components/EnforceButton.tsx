"use client";

import {useState} from "react";
import {ADDR, publicClient, awaitTx} from "@/lib/chain";
import {registryAbi} from "@/lib/abi";
import {useWallet} from "@/lib/useWallet";
import {useToast} from "@/components/Toast";
import type {Mandate} from "@/lib/data";

/**
 * Enforce a breach, from any wallet.
 *
 * This is the whole thesis made clickable. When a mandate's live equity has fallen below its
 * floor but nobody has marked it yet, it sits in a window where *anyone at all* can end it —
 * an LP protecting their capital, a passing observer, a competing trader, you. No role, no
 * allowlist, no keeper.
 *
 * A prop firm cannot offer this button, because on their side enforcement is a decision.
 * Here it is arithmetic anyone can execute.
 */
export function EnforceButton({mandate, onDone}: {mandate: Mandate; onDone: () => void}) {
  const {address, client, wrongChain, connect, available} = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Live equity is under the floor, but the mandate is still Active — so a mark right now
  // would end it. That is precisely the window this button exists for.
  const enforceable = mandate.state.status === 1 && mandate.liveEquity < mandate.floor;
  if (!enforceable) return null;

  const shortfall = mandate.floor - mandate.liveEquity;

  async function enforce() {
    if (!client || !address) return;
    setBusy(true);
    const id = toast.push({
      kind: "pending",
      title: `Enforcing mandate #${mandate.id}`,
      body: "Marking to market and flattening the position.",
    });
    try {
      const hash = await client.writeContract({
        account: address,
        chain: null,
        address: ADDR.registry,
        abi: registryAbi,
        functionName: "markAndEnforce",
        args: [mandate.id],
      });
      toast.update(id, {body: "Waiting for confirmation…", hash});
      await awaitTx(hash);
      toast.update(id, {
        kind: "success",
        title: `Mandate #${mandate.id} enforced`,
        body: "Position flattened and capital returned to whoever backed it — by you, from a wallet with no special role.",
        hash,
      });
      onDone();
    } catch (e) {
      toast.update(id, {
        kind: "error",
        title: "Enforcement failed",
        body: String(e).includes("denied")
          ? "Rejected in wallet."
          : String(e).split("\n")[0]?.slice(0, 140),
      });
    } finally {
      setBusy(false);
    }
  }

  const usd = (v: bigint) =>
    (Number(v) / 1e6).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });

  return (
    <div className="rounded-xl border border-down/35 bg-down/[0.07] p-4 shadow-glow-down">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-down" />
        <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-down">
          Below the floor · enforceable now
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-txt-mid">
        Mandate #{mandate.id.toString()} is{" "}
        <span className="num text-down">{usd(shortfall)}</span> under its drawdown floor and has
        not been marked yet.{" "}
        <span className="text-txt-hi">Anyone can end it right now</span> — this button calls the
        same public function the keeper calls. You need no role and no permission.
      </p>

      {!available ? (
        <p className="mt-3 text-2xs text-txt-lo">Install a wallet to enforce it yourself.</p>
      ) : !address ? (
        <button onClick={() => void connect()} className="btn btn-down mt-3 w-full">
          Connect a wallet to enforce
        </button>
      ) : (
        <button
          onClick={enforce}
          disabled={busy || wrongChain}
          className="btn btn-down mt-3 w-full font-semibold"
        >
          {busy ? "Enforcing…" : "Enforce this breach"}
        </button>
      )}

    </div>
  );
}
