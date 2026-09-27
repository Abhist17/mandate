"use client";

import {Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode} from "react";
import {easeOut, useInView, usePrefersReducedMotion} from "@/lib/motion";

/**
 * Motion primitives. See lib/motion.ts for the rules they follow.
 */

/**
 * Uncover a block when it scrolls into view.
 *
 * `wipe` reveals top-to-bottom behind a moving edge, the way a terminal pane draws in; the
 * default rises. `delay` staggers siblings so a section arrives in reading order rather than
 * all at once.
 *
 * Two elements, on purpose. The observed one is an unstyled outer wrapper; the effect lives
 * on the inner one. Observing the clipped element itself deadlocks: Chrome's
 * IntersectionObserver applies the target's own clip-path, so a block hidden by
 * `inset(0 0 100% 0)` has no visible area, never intersects, and is never revealed.
 * `fill` carries full height through both, for grid items that must stretch.
 */
export function Reveal({
  children,
  as = "div",
  wipe = false,
  delay = 0,
  threshold = 0.15,
  fill = false,
  className = "",
  id,
}: {
  children: ReactNode;
  as?: "div" | "section" | "header";
  wipe?: boolean;
  delay?: number;
  threshold?: number;
  fill?: boolean;
  className?: string;
  id?: string;
}) {
  const [ref, inView] = useInView<HTMLDivElement>({threshold});
  const [done, setDone] = useState(false);

  // Timed rather than keyed off transitionend: that event fires once per property, and not
  // at all when transitions are disabled, and a reveal must never get stuck half-applied.
  useEffect(() => {
    if (!inView) return;
    const t = setTimeout(() => setDone(true), 900 + delay);
    return () => clearTimeout(t);
  }, [inView, delay]);

  const Tag = as as "div";
  return (
    <div ref={ref} id={id} className={fill ? "h-full" : undefined}>
      <Tag
        className={`reveal ${wipe ? "wipe" : ""} ${inView ? "in" : ""} ${done ? "done" : ""} ${
          fill ? "h-full" : ""
        } ${className}`}
        style={{"--d": `${delay}ms`} as CSSProperties}
      >
        {children}
      </Tag>
    </div>
  );
}

/**
 * A line of text whose words rise out of their own masks, in order.
 *
 * Pure CSS — no hooks — so it animates at first paint even before hydration, and renders
 * complete wherever animation is off. The container carries the sentence for assistive
 * technology; the per-word spans are presentation.
 */
export function WordReveal({
  text,
  stagger = 55,
  start = 0,
}: {
  text: string;
  stagger?: number;
  start?: number;
}) {
  const words = text.split(" ");
  return (
    <span aria-label={text}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="wr" aria-hidden="true">
            <span style={{animationDelay: `${start + i * stagger}ms`}}>{w}</span>
          </span>
          {i < words.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A number that counts to its value the first time it is seen, then eases between values.
 *
 * The one rule: it never visibly drops to zero. A value that is already on screen when it
 * first arrives counts up from zero; one that arrives offscreen is parked at zero while it
 * cannot be seen and counts up when it scrolls in. Under reduced motion it simply is the
 * value.
 */
export function CountUp({
  value,
  format,
  duration = 900,
  className = "",
}: {
  value: number | undefined;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>({threshold: 0.3});
  const reduce = usePrefersReducedMotion();
  const [shown, setShown] = useState<number | undefined>(value);
  const shownRef = useRef<number | undefined>(value);
  const started = useRef(false);
  const raf = useRef(0);

  const animate = (from: number, to: number, ms: number) => {
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const v = from + (to - from) * easeOut(p);
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  useEffect(() => {
    // No value means no value: a dash, never a zero. The funding path withdraws its figures
    // before the account exists, and "to trader 0%" would state a split that is not true —
    // it simply is not set yet. The next value then counts in afresh.
    if (value === undefined) {
      cancelAnimationFrame(raf.current);
      shownRef.current = undefined;
      setShown(undefined);
      started.current = false;
      return;
    }
    const motionOn = document.documentElement.dataset.motion === "on" && !reduce;

    if (!motionOn) {
      shownRef.current = value;
      setShown(value);
      started.current = true;
      return;
    }

    if (!started.current) {
      if (inView) {
        started.current = true;
        animate(0, value, duration);
      } else {
        // Offscreen: park at zero where nobody can see the drop.
        shownRef.current = 0;
        setShown(0);
      }
      return;
    }

    // Already counted once: ease from wherever it is to the new value, briefly.
    animate(shownRef.current ?? value, value, Math.min(duration, 450));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, inView, reduce]);

  return (
    <span ref={ref} className={className}>
      {shown === undefined ? "—" : format(shown)}
    </span>
  );
}
