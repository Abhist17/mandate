"use client";

import {useEffect, useRef, useState, type RefObject} from "react";

/**
 * The motion system's plumbing.
 *
 * No animation library: a handful of hooks over IntersectionObserver and requestAnimationFrame
 * cover everything the site does, and owning them means every loop provably stops when it is
 * offscreen, when the tab is hidden, and — without exception — when the reader has asked their
 * system for less motion.
 *
 * The rule the whole system follows: motion here is always a *consequence*. A pulse is a
 * transfer, a check is a check, a line drawing is a value arriving. Nothing moves at random,
 * because nothing in the product is random.
 */

/** Fast out, long settle — the curve of an order filling, not of a ball bouncing. */
export const easeOut = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
export const easeInOut = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Progress of `t` through the window [start, start + dur], clamped to 0..1. */
export const phase = (t: number, start: number, dur: number) => clamp01((t - start) / dur);

export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduce(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduce;
}

/**
 * Whether an element is on screen.
 *
 * `once` latches the first reveal — the default, because content that un-reveals as you
 * scroll back up is motion for its own sake.
 */
export function useInView<T extends Element>(
  opts: {once?: boolean; threshold?: number; rootMargin?: string} = {},
): [RefObject<T | null>, boolean] {
  const {once = true, threshold = 0.2, rootMargin = "0px 0px -8% 0px"} = opts;
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      {threshold, rootMargin},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once, threshold, rootMargin]);

  return [ref, inView];
}

/**
 * A clock that only ticks while it has a reason to.
 *
 * `elapsed` restarts from zero each time the loop becomes active. Frame deltas are clamped,
 * so a tab returning from the background resumes where it was rather than fast-forwarding
 * through everything it missed.
 */
export function useFrame(active: boolean, cb: (elapsedMs: number) => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    const tick = (now: number) => {
      elapsed += Math.min(64, now - last);
      last = now;
      cbRef.current(elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

// ── scroll ──────────────────────────────────────────────────────────────────────
// One passive listener for the whole page, coalesced to one callback batch per frame,
// however many things are reading scroll position.

const scrollSubs = new Set<() => void>();
let scrollQueued = false;

function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    scrollSubs.forEach((f) => f());
  });
}

export function useScrollFrame(cb: () => void, active = true) {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    if (!active) return;
    const f = () => cbRef.current();
    scrollSubs.add(f);
    if (scrollSubs.size === 1) {
      window.addEventListener("scroll", onScroll, {passive: true});
      window.addEventListener("resize", onScroll);
    }
    f();
    return () => {
      scrollSubs.delete(f);
      if (scrollSubs.size === 0) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      }
    };
  }, [active]);
}

/**
 * Depth, by a few pixels.
 *
 * Elements drift against the scroll in proportion to their distance from the middle of the
 * viewport, capped at `max` pixels. Off on touch devices and narrow screens, where it reads
 * as lag rather than depth, and off under reduced motion.
 */
export function useParallax<T extends HTMLElement>(strength = 0.035, max = 8): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const reduce = usePrefersReducedMotion();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine) and (min-width: 1024px)");
    const sync = () => setEnabled(fine.matches && !reduce);
    sync();
    fine.addEventListener("change", sync);
    return () => fine.removeEventListener("change", sync);
  }, [reduce]);

  useScrollFrame(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const offset = r.top + r.height / 2 - window.innerHeight / 2;
    const y = Math.max(-max, Math.min(max, -offset * strength));
    el.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
  }, enabled);

  useEffect(() => {
    if (!enabled && ref.current) ref.current.style.transform = "";
  }, [enabled]);

  return ref;
}
