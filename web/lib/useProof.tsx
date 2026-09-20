"use client";

import {createContext, useCallback, useContext, useMemo, useState, type ReactNode} from "react";
import {ProofDrawer, type ProofSpec} from "@/components/Proof";

/**
 * One drawer, opened from anywhere.
 *
 * The alternative was a panel per call site, which would have meant every number that wants
 * to be checkable also carrying its own open/close state. A single host means adding
 * "verify this" to a new figure is one `open({...})` call.
 */

type Ctx = {open: (spec: ProofSpec) => void; close: () => void};

const ProofContext = createContext<Ctx | undefined>(undefined);

export function ProofProvider({children}: {children: ReactNode}) {
  const [spec, setSpec] = useState<ProofSpec | null>(null);
  const open = useCallback((s: ProofSpec) => setSpec(s), []);
  const close = useCallback(() => setSpec(null), []);
  const value = useMemo(() => ({open, close}), [open, close]);

  return (
    <ProofContext.Provider value={value}>
      {children}
      <ProofDrawer spec={spec} onClose={close} />
    </ProofContext.Provider>
  );
}

export function useProof(): Ctx {
  const v = useContext(ProofContext);
  // A number that cannot find the drawer should render as an ordinary number rather than
  // crash the page around it.
  return v ?? {open: () => {}, close: () => {}};
}

/**
 * The affordance itself: a contract function name you can press.
 *
 * Rendered as the function's own signature because that is the honest label — it is not a
 * "learn more" link, it is the exact call whose result you are reading.
 */
export function ProofChip({spec, className = ""}: {spec: ProofSpec; className?: string}) {
  const {open} = useProof();
  return (
    <button
      onClick={() => open(spec)}
      title={`Verify ${spec.title} against the contract`}
      className={`num group inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-2xs
                  text-txt-lo/70 transition-colors hover:border-edge-hi hover:bg-white/[0.04] hover:text-acc-hi ${className}`}
    >
      {spec.functionName}()
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-0 transition-opacity group-hover:opacity-100"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}
