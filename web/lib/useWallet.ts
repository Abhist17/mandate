"use client";

import {useCallback, useEffect, useState} from "react";
import {createWalletClient, custom, type Address, type WalletClient} from "viem";
import {monadTestnet, CHAIN_ID} from "./chain";

/**
 * Minimal EIP-1193 connector.
 *
 * Deliberately not wagmi. The app needs three things — an address, a chain check, and a
 * client that can send a transaction — and a dependency that provides those plus a connector
 * registry, a query cache and a React context is more surface than the feature warrants.
 * SPEC §8 lists the wallet layer as the fourth thing to cut; this is what not needing to cut
 * it looks like.
 */

type Eip1193 = {
  request: (args: {method: string; params?: unknown[]}) => Promise<unknown>;
  on?: (event: string, cb: (...args: never[]) => void) => void;
  removeListener?: (event: string, cb: (...args: never[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export type WalletState = {
  address: Address | undefined;
  chainId: number | undefined;
  wrongChain: boolean;
  available: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  client: WalletClient | undefined;
};

export function useWallet(): WalletState {
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const eth = window.ethereum;
    setAvailable(Boolean(eth));
    if (!eth) return;

    void eth.request({method: "eth_accounts"}).then((accts) => {
      const list = accts as Address[];
      if (list.length > 0) setAddress(list[0]);
    });
    void eth.request({method: "eth_chainId"}).then((id) => setChainId(Number(id as string)));

    const onAccounts = (...args: never[]) => {
      const list = args[0] as unknown as Address[];
      setAddress(list?.[0]);
    };
    const onChain = (...args: never[]) => setChainId(Number(args[0] as unknown as string));

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    setConnecting(true);
    try {
      const accts = (await eth.request({method: "eth_requestAccounts"})) as Address[];
      setAddress(accts[0]);
      setChainId(Number((await eth.request({method: "eth_chainId"})) as string));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const hex = `0x${CHAIN_ID.toString(16)}`;
    try {
      await eth.request({method: "wallet_switchEthereumChain", params: [{chainId: hex}]});
    } catch {
      // Not added yet — offer to add it rather than leaving the user stuck.
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: monadTestnet.name,
            nativeCurrency: monadTestnet.nativeCurrency,
            rpcUrls: monadTestnet.rpcUrls.default.http,
            blockExplorerUrls: ["https://testnet.monadscan.com"],
          },
        ],
      });
    }
  }, []);

  const client =
    address && window.ethereum
      ? createWalletClient({account: address, chain: monadTestnet, transport: custom(window.ethereum)})
      : undefined;

  return {
    address,
    chainId,
    wrongChain: chainId !== undefined && chainId !== CHAIN_ID,
    available,
    connecting,
    connect,
    switchChain,
    client,
  };
}
