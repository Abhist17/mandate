"use client";

import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from "react";
import {explorerTx} from "@/lib/chain";

/**
 * Transaction feedback.
 *
 * Previously every action reported itself as a line of small text inside whatever panel
 * triggered it — easy to miss, and gone the moment you navigated. A transaction that moves
 * capital deserves to be acknowledged somewhere the eye will actually find it, with a link to
 * the receipt.
 *
 * Errors stay until dismissed. Successes clear themselves: a confirmation you have already
 * read is clutter, but a failure you have not is the whole message.
 */

export type ToastKind = "pending" | "success" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  hash?: string;
};

type Ctx = {
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<Ctx | undefined>(undefined);

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

let nextId = 1;

export function ToastProvider({children}: {children: ReactNode}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId++;
    setToasts((prev) => [...prev, {...t, id}]);
    return id;
  }, []);

  const update = useCallback((id: number, patch: Partial<Omit<Toast, "id">>) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? {...t, ...patch} : t)));
  }, []);

  return (
    <ToastContext.Provider value={{push, update, dismiss}}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({toast, onDismiss}: {toast: Toast; onDismiss: () => void}) {
  useEffect(() => {
    if (toast.kind !== "success") return;
    const t = setTimeout(onDismiss, 7000);
    return () => clearTimeout(t);
  }, [toast.kind, onDismiss]);

  const tone =
    toast.kind === "success"
      ? "border-up/35 bg-up/[0.09]"
      : toast.kind === "error"
        ? "border-down/35 bg-down/[0.09]"
        : "border-edge-hi bg-ink-850";

  const mark =
    toast.kind === "success" ? "✓" : toast.kind === "error" ? "✕" : "";

  const markTone =
    toast.kind === "success" ? "text-up" : toast.kind === "error" ? "text-down" : "text-txt-mid";

  return (
    <div
      className={`pointer-events-auto rounded-xl border px-4 py-3 shadow-panel-lg backdrop-blur-sm ${tone}`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-px text-xs ${markTone}`}>
          {toast.kind === "pending" ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-txt-lo border-t-txt-hi" />
          ) : (
            mark
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-txt-hi">{toast.title}</div>
          {toast.body && (
            <div className="mt-0.5 text-2xs leading-relaxed text-txt-mid">{toast.body}</div>
          )}
          {toast.hash && (
            <a
              href={explorerTx(toast.hash)}
              target="_blank"
              rel="noreferrer"
              className="num mt-1 inline-block text-2xs text-txt-lo underline decoration-txt-lo/40 hover:text-txt-hi"
            >
              {toast.hash.slice(0, 10)}… ↗
            </a>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-2xs text-txt-lo transition-colors hover:text-txt-hi"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
