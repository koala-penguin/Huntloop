"use client";

import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/** Sideways movement (px) before a swipe can start: small accidental moves stay taps or scrolls. */
const START_X = 12;
/** Vertical movement (px) that hands the gesture to the page scroll, if it comes before START_X. */
const START_Y = 10;
/** Horizontal must beat vertical by this factor at the start to count as a swipe. */
const DOMINANCE = 1.5;
/** Release past this share of the row width (but never needing more than DISTANCE_MAX px) deletes. */
const DISTANCE_SHARE = 0.25;
const DISTANCE_MAX = 90;
/** …or a flick: faster than this (px/ms) to the left over the last ~100 ms, and at least FLICK_MIN px travelled. */
const FLICK_SPEED = 0.3;
const FLICK_MIN = 30;
export const SWIPE_ANIMATION_MS = 200;

type Mode = "pending" | "swipe" | "scroll";

interface Gesture {
  mode: Mode;
  touchId: number;
  x0: number;
  y0: number;
  dx: number;
  /** Recent samples for the release velocity. */
  samples: Array<{ x: number; t: number }>;
}

/** The distance a release must reach to delete, for a row this wide. */
export function swipeDistance(width: number): number {
  return Math.min(width * DISTANCE_SHARE, DISTANCE_MAX);
}

/**
 * Swipe a row to the left with a finger (a mouse drag stays a normal link drag / text selection).
 *
 * Touch Events, not Pointer Events: once a swipe has started, every touchmove is preventDefault()ed (from a
 * non-passive listener) so the browser can't take the gesture over for scrolling when the thumb drifts up
 * or down. Pointer Events offer no way to refuse that: the browser may send pointercancel and take over.
 * Until the swipe starts nothing is prevented, so vertical scrolling and pinch-zoom work as usual.
 */
export function useSwipeLeft({ enabled, onSwiped }: { enabled: boolean; onSwiped: () => void }) {
  const track = useRef<HTMLDivElement | null>(null);
  const reveal = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** A swipe just ended over the link: swallow the click it would cause. */
  const suppressClick = useRef(false);
  const leaving = useRef(false);
  const timers = useRef<number[]>([]);
  const onSwipedRef = useRef(onSwiped);
  useEffect(() => {
    onSwipedRef.current = onSwiped;
  }, [onSwiped]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((id) => window.clearTimeout(id));
  }, []);

  const place = useCallback((offset: number, animate: boolean) => {
    const el = track.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${SWIPE_ANIMATION_MS}ms ease-out` : "none";
    el.style.transform = offset ? `translateX(${offset}px)` : "";
    if (reveal.current) reveal.current.style.opacity = offset ? "1" : "0";
  }, []);

  /** `aborted`: a second finger came down, so it's not a swipe after all. Otherwise distance or speed decides. */
  const end = useCallback(
    (aborted: boolean) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.mode !== "swipe") return;
      const width = track.current?.offsetWidth ?? 0;
      const first = g.samples[0];
      const last = g.samples[g.samples.length - 1];
      const speed = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const far = width > 0 && -g.dx >= swipeDistance(width);
      const flick = speed <= -FLICK_SPEED && -g.dx >= FLICK_MIN;
      // The click that may follow the release comes right after it; clear the flag soon after.
      suppressClick.current = true;
      timers.current.push(window.setTimeout(() => (suppressClick.current = false), 400));
      if (!aborted && (far || flick)) {
        // Decided: report it now (not after the slide-out), so leaving the page mid-animation can't lose it.
        leaving.current = true;
        place(-width, true);
        onSwipedRef.current();
      } else {
        place(0, true);
      }
    },
    [place],
  );

  /** Attaches the touch listeners to the sliding element (non-passive, which React's own listeners aren't). */
  const trackRef = useCallback(
    (el: HTMLDivElement | null) => {
      track.current = el;
      if (!el || !enabled) return;
      const find = (list: TouchList, id: number) => Array.from(list).find((t) => t.identifier === id);

      const onStart = (e: TouchEvent) => {
        // A new touch is a new gesture: a tap right after a swipe must still open the job.
        suppressClick.current = false;
        if (gesture.current) {
          // A second finger: not a swipe (pinch-zoom, or an accident).
          end(true);
          return;
        }
        if (leaving.current || e.touches.length !== 1) return;
        const t = e.changedTouches[0];
        gesture.current = { mode: "pending", touchId: t.identifier, x0: t.clientX, y0: t.clientY, dx: 0, samples: [{ x: t.clientX, t: e.timeStamp }] };
      };

      const onMove = (e: TouchEvent) => {
        const g = gesture.current;
        if (!g || g.mode === "scroll") return;
        // `touches` counts every finger on the screen, also ones that landed on another row (whose touchstart
        // this row never hears): two fingers are a pinch, never a swipe.
        if (e.touches.length > 1) {
          end(true);
          return;
        }
        const t = find(e.changedTouches, g.touchId);
        if (!t) return;
        const dx = t.clientX - g.x0;
        const dy = t.clientY - g.y0;
        if (g.mode === "pending") {
          const ax = Math.abs(dx);
          const ay = Math.abs(dy);
          if (ax < START_X && ay < START_Y) return;
          if (dx <= -START_X && ax > ay * DOMINANCE) g.mode = "swipe";
          else {
            g.mode = "scroll";
            return;
          }
        }
        // Locked: from here on the gesture is ours until the finger lifts, however the thumb drifts.
        if (e.cancelable) e.preventDefault();
        g.dx = Math.min(0, dx);
        g.samples.push({ x: t.clientX, t: e.timeStamp });
        while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > 100) g.samples.shift();
        place(g.dx, false);
      };

      const onEnd = (e: TouchEvent) => {
        const g = gesture.current;
        // Another finger still down when this one lifts: a multi-finger gesture, not a swipe.
        if (g && find(e.changedTouches, g.touchId)) end(e.touches.length > 0);
      };

      el.addEventListener("touchstart", onStart, { passive: true });
      el.addEventListener("touchmove", onMove, { passive: false });
      el.addEventListener("touchend", onEnd);
      // A cancel after the swipe started is decided like a release (distance/speed), never a forced snap-back.
      el.addEventListener("touchcancel", onEnd);
      return () => {
        el.removeEventListener("touchstart", onStart);
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", onEnd);
        el.removeEventListener("touchcancel", onEnd);
      };
    },
    [enabled, end, place],
  );

  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    // detail 0 = keyboard activation (Enter on the link), which a touch swipe never produces.
    if (e.detail !== 0 && (suppressClick.current || leaving.current)) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  /** Back in place (Undo): the row can be swiped again. */
  const reset = useCallback(() => {
    leaving.current = false;
    place(0, false);
  }, [place]);

  return {
    trackRef,
    reveal,
    reset,
    handlers: enabled ? { onClickCapture } : {},
  };
}
