"use client";

import type {Address} from "viem";
import {publicClient, ADDR} from "./chain";
import {registryAbi} from "./abi";
import {usePolled} from "./data";

/**
 * The bounty board's read: would enforcing this mandate right now terminate it, on which
 * rule, and what would it pay *this* caller.
 *
 * `previewEnforce` answers for msg.sender, because the trader is not paid for enforcing their
 * own mandate. An eth_call with no `from` runs as the zero address, which the contract
 * (correctly) never pays — so a visitor with no wallet is previewed as an arbitrary stranger,
 * which is exactly what they would be if they connected one.
 */
export const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;

export const BREACH_RULE = ["None", "Trailing drawdown", "Daily loss", "Expiry"] as const;

export type Preview = {
  enforceable: boolean;
  rule: number;
  equity: bigint;
  floor: bigint;
  bounty: bigint;
};

export async function previewEnforce(id: bigint, as?: Address): Promise<Preview> {
  const r = (await publicClient.readContract({
    address: ADDR.registry,
    abi: registryAbi,
    functionName: "previewEnforce",
    args: [id],
    account: as ?? STRANGER,
  })) as readonly [boolean, number, bigint, bigint, bigint];
  return {enforceable: r[0], rule: Number(r[1]), equity: r[2], floor: r[3], bounty: r[4]};
}

export function usePreview(id: bigint | undefined, as?: Address) {
  return usePolled(
    async () => (id === undefined ? undefined : previewEnforce(id, as)),
    4_000,
    [id?.toString(), as],
  ).data;
}

export async function fetchBountyBps(): Promise<number> {
  return Number(
    await publicClient.readContract({address: ADDR.registry, abi: registryAbi, functionName: "enforcementBountyBps"}),
  );
}
