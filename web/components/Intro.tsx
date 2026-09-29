"use client";

import {useEffect} from "react";

/**
 * The opening: the product's mechanic drawing itself into the product's name.
 *
 * A red line crosses an empty screen — the floor. A green line climbs above it — equity. The
 * band between them fills, a settlement ring goes out once from where equity stands, the name
 * resolves, and the frame lifts into the page. About two and a half seconds, once a session.
 *
 * Built so it cannot get in the way:
 *   - It is CSS. The pre-paint script in <head> decides whether to play it and schedules its
 *     own end, so it runs and finishes even if this component never hydrates.
 *   - A click or a key skips it. Reduced motion, a shared mandate link and presentation mode
 *     never see it at all.
 *   - While it plays, the landing hero's own entrance is paused rather than wasted underneath
 *     it, and resumes the moment it lifts.
 */
export function Intro() {
  useEffect(() => {
    const d = document.documentElement;
    if (d.getAttribute("data-intro") !== "on") return;
    const skip = () => {
      if (d.getAttribute("data-intro") !== "on") return;
      const w = window as unknown as {__introEnd?: ReturnType<typeof setTimeout>};
      if (w.__introEnd) clearTimeout(w.__introEnd);
      d.setAttribute("data-intro", "skip");
      setTimeout(() => d.removeAttribute("data-intro"), 260);
    };
    window.addEventListener("pointerdown", skip, {once: true});
    window.addEventListener("keydown", skip, {once: true});
    return () => {
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  return (
    <div className="intro" aria-hidden="true">
      <svg className="intro-svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="intro-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00e39b" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#00e39b" stopOpacity="0.02" />
          </linearGradient>
          {/* User-space region: a horizontal line has a zero-height bounding box, so a
              box-relative filter region is empty and the floor rendered as nothing. */}
          <filter id="intro-glow" filterUnits="userSpaceOnUse" x="0" y="380" width="1000" height="80">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* the headroom: the band between equity and the floor, which is the product */}
        <path className="intro-band" d={`${EQUITY} L 900 420 L 0 420 Z`} fill="url(#intro-band)" />

        {/* No non-scaling-stroke here: it moves dashing into screen space, which breaks the
            pathLength normalisation the draw-on depends on — the floor never appeared. */}
        <path className="intro-floor" d="M 0 420 L 1000 420" stroke="#ff3d55" strokeWidth="1.6"
          pathLength={1} filter="url(#intro-glow)" />
        <path className="intro-equity" d={EQUITY} fill="none" stroke="#00e39b" strokeWidth="1.8"
          strokeLinejoin="round" pathLength={1} />

        <circle className="intro-ring" cx="900" cy="214" r="10" fill="none" stroke="#00e39b" strokeWidth="1.5" />
        <circle className="intro-head" cx="900" cy="214" r="5" fill="#00e39b" />

        <text className="intro-label" x="22" y="444" fill="#ff3d55" fontSize="13"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" letterSpacing="2">
          FLOOR · ENFORCED ONCHAIN
        </text>
        <text className="intro-label intro-label-2" x="22" y="366" fill="#00e39b" fontSize="13"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" letterSpacing="2">
          EQUITY
        </text>
      </svg>

      <div className="intro-word">
        <div className="intro-name">MANDATE</div>
        <div className="intro-tag font-display">The rules are the contract.</div>
      </div>

      <div className="intro-hint">click to skip</div>
    </div>
  );
}

/** Climbs with the texture of a real session: advances, gives some back, advances. Ends short
 *  of the right edge, where a slice-fit viewport would crop the settlement ring. */
const EQUITY =
  "M 0 392 L 70 384 L 120 389 L 190 360 L 250 368 L 330 330 L 390 340 L 470 296 " +
  "L 530 306 L 610 262 L 670 274 L 760 236 L 820 246 L 900 214";
