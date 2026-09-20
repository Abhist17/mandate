"use client";

import {useCallback, useEffect, useState} from "react";
import {encodeFunctionData, decodeFunctionResult, type Abi} from "viem";
import {publicClient, explorerAddr, RPC_URL} from "@/lib/chain";

/**
 * "Don't trust us."
 *
 * Every number on this dashboard claims to come from the contract that enforces it. That is
 * a claim, and a claim is worth what it can be checked for. This panel makes the check one
 * click: it shows the address, the exact calldata, and then — when asked — sends that call
 * to the chain again, right now, and prints the raw bytes that come back next to the number
 * the UI is showing.
 *
 * It is the one screen in this product a prop firm cannot build. FundingPips' dashboard is
 * disclaimed as "not a live representation of performance" precisely because there is no
 * underlying object a customer could query. Here there is, so here is the query.
 */

export type ProofSpec = {
  /** What the reader is checking, in their words. */
  title: string;
  /** What the number means, one line. */
  blurb?: string;
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** How the UI is currently rendering it, to sit beside the raw result. */
  shown: string;
  /** Turn the decoded return into something readable. */
  format?: (decoded: unknown) => string;
};

export function ProofDrawer({spec, onClose}: {spec: ProofSpec | null; onClose: () => void}) {
  const [raw, setRaw] = useState<string>();
  const [decoded, setDecoded] = useState<string>();
  const [block, setBlock] = useState<bigint>();
  const [at, setAt] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Escape closes it. A panel that traps you is a panel people stop opening.
  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, onClose]);

  useEffect(() => {
    setRaw(undefined);
    setDecoded(undefined);
    setBlock(undefined);
    setErr(undefined);
  }, [spec]);

  const run = useCallback(async () => {
    if (!spec) return;
    setBusy(true);
    setErr(undefined);
    try {
      const data = encodeFunctionData({
        abi: spec.abi,
        functionName: spec.functionName,
        args: spec.args as never,
      });
      const bn = await publicClient.getBlockNumber();
      // eth_call at an explicit block, so the answer is pinned to something checkable
      // rather than to "whatever the node felt like when you asked".
      const res = await publicClient.call({to: spec.address, data, blockNumber: bn});
      const hex = res.data ?? "0x";
      setRaw(hex);
      setBlock(bn);
      setAt(new Date().toLocaleTimeString("en-GB"));
      try {
        const out = decodeFunctionResult({
          abi: spec.abi,
          functionName: spec.functionName,
          data: hex as `0x${string}`,
        });
        setDecoded(spec.format ? spec.format(out) : stringify(out));
      } catch {
        setDecoded(undefined);
      }
    } catch (e) {
      setErr(String(e).slice(0, 300));
    } finally {
      setBusy(false);
    }
  }, [spec]);

  if (!spec) return null;

  const calldata = safeEncode(spec);
  const selector = calldata.slice(0, 10);
  const matches = decoded !== undefined && normalise(decoded) === normalise(spec.shown);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />

      <aside className="relative flex h-full w-full max-w-[520px] flex-col overflow-y-auto border-l border-edge bg-ink-950 shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-edge bg-ink-950/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-txt-lo">
              Verify this number
            </div>
            <h2 className="mt-1 text-sm font-semibold text-txt-hi">{spec.title}</h2>
            {spec.blurb && <p className="mt-1 text-2xs leading-relaxed text-txt-mid">{spec.blurb}</p>}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-edge px-2 py-1 text-2xs text-txt-lo transition-colors hover:border-edge-hi hover:text-txt-hi"
          >
            Esc
          </button>
        </header>

        <div className="space-y-5 px-5 py-5">
          <Block label="What the screen says">
            <div className="num text-xl text-txt-hi">{spec.shown}</div>
          </Block>

          <Block label="Where it comes from">
            <Kv k="Contract">
              <a
                href={explorerAddr(spec.address)}
                target="_blank"
                rel="noreferrer"
                className="num underline decoration-ink-600 underline-offset-2 hover:text-acc-hi"
              >
                {spec.address}
              </a>
            </Kv>
            <Kv k="Function">
              <span className="num text-txt-hi">
                {spec.functionName}({spec.args.map(String).join(", ")})
              </span>
            </Kv>
            <Kv k="Selector">
              <span className="num text-txt-mid">{selector}</span>
            </Kv>
            <Kv k="Node">
              <span className="num break-all text-txt-mid">{RPC_URL}</span>
            </Kv>
          </Block>

          <Block label="Calldata">
            <code className="num block break-all rounded-lg border border-edge bg-ink-980 p-3 text-2xs leading-relaxed text-txt-mid">
              {calldata}
            </code>
          </Block>

          <button
            onClick={run}
            disabled={busy}
            className="w-full rounded-lg bg-acc px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-acc-hi disabled:opacity-50"
          >
            {busy ? "Calling the chain…" : raw ? "Call it again" : "Run this call now"}
          </button>

          {err && (
            <div className="rounded-lg border border-down/30 bg-down/[0.07] p-3 text-2xs leading-relaxed text-down">
              {err}
            </div>
          )}

          {raw && (
            <Block label={`Returned at block ${block?.toLocaleString()} · ${at}`}>
              <code className="num block break-all rounded-lg border border-edge bg-ink-980 p-3 text-2xs leading-relaxed text-txt-mid">
                {raw}
              </code>
              {decoded !== undefined && (
                <>
                  <div className="mt-3 flex items-baseline justify-between gap-3">
                    <span className="text-2xs text-txt-lo">Decoded</span>
                    <span className="num text-sm text-txt-hi">{decoded}</span>
                  </div>
                  <div
                    className={`mt-3 rounded-lg border px-3 py-2.5 text-2xs leading-relaxed ${
                      matches
                        ? "border-up/30 bg-up/[0.07] text-up"
                        : "border-warn/30 bg-warn/[0.07] text-warn"
                    }`}
                  >
                    {matches
                      ? "Matches what the screen is showing. This dashboard is a view over that value, not a copy of it."
                      : "This does not match the number above. The chain is right and we are wrong — please report it. The whole point of this panel is that you find out from us rather than from a closed account."}
                  </div>
                </>
              )}
            </Block>
          )}

          <p className="text-2xs leading-relaxed text-txt-lo">
            This runs in your browser, against the node above. Point any client at the same
            address and calldata and you get the same bytes — there is no account, no API key
            and no permission involved, because the state is public and the function is a
            view.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Block({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <section>
      <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-txt-lo">
        {label}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function Kv({k, children}: {k: string; children: React.ReactNode}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-edge/60 py-1.5 last:border-0">
      <span className="text-2xs text-txt-lo">{k}</span>
      <span className="text-2xs">{children}</span>
    </div>
  );
}

/** Encoding can throw on a malformed spec; the panel should still open and say why. */
function safeEncode(spec: ProofSpec): string {
  try {
    return encodeFunctionData({
      abi: spec.abi,
      functionName: spec.functionName,
      args: spec.args as never,
    });
  } catch {
    return "0x";
  }
}

function stringify(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(stringify).join(", ");
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${stringify(val)}`)
      .join(", ");
  }
  return String(v);
}

/** Compare on digits alone, so "$2,928.18" and "2928.18" are not a false mismatch. */
const normalise = (s: string) => s.replace(/[^0-9.]/g, "");
