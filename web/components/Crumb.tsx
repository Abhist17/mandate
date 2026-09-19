"use client";

import {useState} from "react";
import {useToast} from "@/components/Toast";
import {useMandates} from "@/lib/useMandates";
import {explorerAddr} from "@/lib/chain";
import {timeAgo} from "@/lib/format";
import type {Mandate} from "@/lib/data";

/**
 * Where you are, and the handful of things you can do from here.
 *
 * The row of chips is lifted straight from how funded-account dashboards work, with one
 * difference that matters: "Verify" is not a support link. It opens the account on a block
 * explorer, where the numbers on this page can be re-derived by someone who does not trust
 * this page. A prop firm's dashboard is the firm's word for what happened; this one is a
 * view of state anybody can read.
 */
export function Crumb({mandate}: {mandate: Mandate}) {
  const {refresh} = useMandates();
  const {push} = useToast();
  const [spinning, setSpinning] = useState(false);

  const share = async () => {
    const url = `${location.origin}/trade?m=${mandate.id}`;
    try {
      await navigator.clipboard.writeText(url);
      push({kind: "success", title: "Link copied", body: "Anyone can open this mandate — no account needed."});
    } catch {
      push({kind: "error", title: "Could not copy", body: url});
    }
  };

  const doRefresh = () => {
    setSpinning(true);
    refresh();
    setTimeout(() => setSpinning(false), 600);
  };

  return (
    <div className="space-y-3">
      <nav className="flex items-center gap-1.5 text-2xs text-txt-lo" aria-label="Breadcrumb">
        <span>Trader</span>
        <Sep />
        <span>Client area</span>
        <Sep />
        <span className="num text-txt-hi">Mandate #{mandate.id.toString()}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <Chip onClick={doRefresh}>
          <span className={spinning ? "inline-block animate-spin" : "inline-block"}>
            <RefreshIcon />
          </span>
          Refresh
        </Chip>
        <Chip onClick={share}>
          <ShareIcon /> Share
        </Chip>
        <Chip href={explorerAddr(mandate.state.account)}>
          <ChainIcon /> Verify onchain
        </Chip>

        <span className="ml-auto flex items-center gap-1.5 text-2xs text-txt-lo">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-up" />
          marked {timeAgo(mandate.state.lastMarkedAt)}
        </span>
      </div>
    </div>
  );
}

function Sep() {
  return <span className="text-ink-600">/</span>;
}

function Chip({
  children,
  onClick,
  href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  const cls =
    "inline-flex items-center gap-1.5 rounded-full border border-edge bg-ink-900 px-3 py-1.5 text-2xs " +
    "text-txt-mid transition-colors hover:border-edge-hi hover:bg-ink-850 hover:text-txt-hi";
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

const S = {
  width: 12,
  height: 12,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function RefreshIcon() {
  return (
    <svg {...S}>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg {...S}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg {...S}>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
