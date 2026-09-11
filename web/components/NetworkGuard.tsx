"use client";

import {publicClient, ADDR, isConfigured, CHAIN_ID, RPC_URL} from "@/lib/chain";
import {usePolled} from "@/lib/data";
import {useWallet} from "@/lib/useWallet";

/**
 * Refuse to run against a network where our contracts do not exist.
 *
 * This exists because of a trap that cost a real tester a real transaction. A local anvil
 * fork of Monad testnet reports **the same chain id as Monad testnet itself** (10143), so a
 * wallet connected to the public network looks perfectly correct to a chain-id check — and
 * then sends transactions to addresses that only exist on the fork. They do not revert. A
 * call to an address with no code succeeds, costs ~21k gas, and does nothing, so the user
 * pays for a transaction that was never going to work and sees a bare "failed" afterwards.
 *
 * A chain id is a claim about which network you are on. Whether our contracts are actually
 * there is a fact, and this checks the fact.
 */
export function NetworkGuard({children}: {children: React.ReactNode}) {
  const {address} = useWallet();

  const {data} = usePolled(async () => {
    if (!isConfigured) return {app: true, wallet: true};

    // 1. Does the network the APP reads from have our contracts?
    //
    // A failed read is NOT "no code". On a public RPC, reads time out and get rate-limited;
    // treating that as "contracts missing" swapped the entire page for a red banner and back
    // every few seconds — the flicker a tester reported. Only an explicit "0x" means missing.
    let app = true;
    try {
      const appCode = await publicClient.getCode({address: ADDR.registry});
      app = appCode !== "0x" && appCode !== undefined;
    } catch {
      app = true;
    }

    // 2. Does the network the WALLET will SEND to have them?
    //
    // These are different questions and the first version only asked the first one, which
    // missed the exact case it was written for: the app reading a local fork while the
    // wallet is pointed at the public network. Both report chain id 10143, both look
    // correct, and the transaction lands somewhere with no contracts. Asking the wallet's
    // own provider is the only way to tell — a chain id cannot distinguish a fork from
    // what it forked.
    let wallet = true;
    if (address && typeof window !== "undefined" && window.ethereum) {
      try {
        const code = (await window.ethereum.request({
          method: "eth_getCode",
          params: [ADDR.registry, "latest"],
        })) as string;
        wallet = Boolean(code && code !== "0x");
      } catch {
        wallet = true; // a provider that won't answer is not evidence of a problem
      }
    }

    return {app, wallet};
  }, 30_000, [address]);

  // Undefined on first paint — don't flash a scary banner before we know.
  if (data === undefined || (data.app && data.wallet)) return <>{children}</>;

  const walletMismatch = data.app && !data.wallet;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-down/40 bg-down/[0.07] p-5 shadow-glow-down">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-down" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-down">
            {walletMismatch
              ? "Your wallet is on a different network from this app"
              : "Contracts not found on this network"}
          </h2>
        </div>

        {walletMismatch ? (
          <>
            <p className="mt-3 max-w-2xl text-xs leading-relaxed text-txt-mid">
              This page is reading contracts that exist on{" "}
              <span className="num text-txt-hi">{RPC_URL}</span>, but your wallet is connected to
              a network where{" "}
              <span className="num text-txt-hi">{ADDR.registry.slice(0, 10)}…</span> has no code.
              <span className="text-txt-hi">
                {" "}
                A transaction sent from here would succeed, do nothing, and still cost you gas.
              </span>{" "}
              So the app has stopped you.
            </p>
            <p className="mt-2 max-w-2xl text-2xs leading-relaxed text-txt-lo">
              Both networks report chain id <span className="num">{CHAIN_ID}</span> — a local fork
              keeps the chain id of whatever it forks — so your wallet cannot tell them apart and
              neither can a chain-id check.
            </p>

            {/* Say what to DO. A warning that only says what is wrong leaves the reader
                exactly as stuck as before, just better informed. */}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-edge bg-ink-950 p-3.5">
                <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-txt-hi">
                  Option A · use this local copy
                </div>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-2xs leading-relaxed text-txt-mid">
                  <li>
                    MetaMask → Networks → <span className="text-txt-hi">Add network manually</span>
                  </li>
                  <li>
                    Name <span className="num text-txt-hi">Mandate Local</span> · RPC{" "}
                    <span className="num text-txt-hi">{RPC_URL}</span> · Chain ID{" "}
                    <span className="num text-txt-hi">{CHAIN_ID}</span> · Symbol{" "}
                    <span className="num text-txt-hi">MON</span>
                  </li>
                  <li>Switch to it, then import the test account shown in your terminal</li>
                </ol>
                <p className="mt-2 text-2xs text-txt-lo">
                  Works in two minutes. Only on this machine.
                </p>
              </div>

              <div className="rounded-lg border border-up/25 bg-up/[0.04] p-3.5">
                <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-up">
                  Option B · deploy to the real network
                </div>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-2xs leading-relaxed text-txt-mid">
                  <li>
                    In a terminal:{" "}
                    <span className="num text-txt-hi">./scripts/set-key.sh</span> — paste your key
                    when prompted (hidden)
                  </li>
                  <li>
                    Then <span className="num text-txt-hi">make deploy-live</span>
                  </li>
                </ol>
                <p className="mt-2 text-2xs text-txt-lo">
                  Your wallet works as-is, and so does everyone else&rsquo;s. This is the one
                  that lets you share the link.
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="mt-3 max-w-2xl text-xs leading-relaxed text-txt-mid">
              The app is configured for contracts at{" "}
              <span className="num text-txt-hi">{ADDR.registry.slice(0, 10)}…</span>, but there is
              no code at that address on the network this page is reading from. Any transaction
              you send would silently do nothing and still cost gas.
            </p>
            <p className="mt-2 max-w-2xl text-2xs leading-relaxed text-txt-lo">
              The usual cause: a local fork of Monad testnet reports the same chain id{" "}
              <span className="num">({CHAIN_ID})</span> as the real network, so a wallet cannot
              tell them apart. Point the app and your wallet at the same one.
            </p>
          </>
        )}

        <div className="mt-3 rounded-lg border border-edge bg-ink-950 px-3 py-2 text-2xs">
          <div className="flex justify-between gap-4">
            <span className="text-txt-lo">reading from</span>
            <span className="num text-txt-mid">{RPC_URL}</span>
          </div>
          <div className="mt-1 flex justify-between gap-4">
            <span className="text-txt-lo">expected registry</span>
            <span className="num text-txt-mid">{ADDR.registry}</span>
          </div>
        </div>
      </div>

      {/* The read-only views below still work against whatever IS there, so leave them up. */}
      <div className="pointer-events-none opacity-40">{children}</div>
    </div>
  );
}
