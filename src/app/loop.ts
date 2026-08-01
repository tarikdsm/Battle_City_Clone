// src/app/loop.ts — the fixed-timestep driver (arch §3.4).
//
// The core simulation advances in whole 60 Hz ticks and nothing else; this loop
// is the only place where wall-clock time is turned into ticks. Everything that
// touches the browser (the clock and the frame scheduler) is injected, so the
// loop is testable in plain Node.

import { TICK_S } from '../core/constants';

/**
 * One simulation tick, in milliseconds. Derived from the core's authoritative
 * `TICK_S` rather than re-spelled as `1000 / 60` so the two can never drift
 * apart (they are bit-identical doubles, so this is maintainability, not a
 * behaviour change). Deliberately NOT exported: a consumer that needs the tick
 * rate should read `TICK_S` from core, and the renderer needs neither — it gets
 * `alpha` and `dtMs` handed to it.
 */
const TICK_MS = TICK_S * 1000;

/**
 * Largest dt a single frame may contribute. A backgrounded tab hands back a
 * multi-second timestamp; without the clamp the sim would try to catch up on
 * minutes of missed time in one frame.
 */
const MAX_DT_MS = 250;

/**
 * Runaway guard: the most steps one `tickOnce` may run. Whatever the clamped dt
 * still asks for beyond this is dropped — a brief slow-motion hitch is far
 * better than a spiral of death where each frame falls further behind.
 */
const MAX_STEPS_PER_TICK = 10;

export interface LoopCallbacks {
  /** Advance the simulation exactly one tick. */
  step(): void;
  /**
   * Draw one frame. `alpha` is the interpolation factor between the previous
   * and the current tick: **in [0, 1) while running, and exactly 1 while
   * paused**. Do not clamp or assert `alpha < 1` — the pause case is not an
   * edge case, it is the contract: a paused core does not advance, so `prev`
   * and `current` are the same state, and anything less than 1 would render
   * every entity a fraction of a tick behind where it actually is, jittering
   * the whole board for as long as the pause lasts (T1.6/T1.7).
   *
   * `dtMs` is the clamped frame time (≤ 250 ms), for time-based presentation
   * effects; it keeps ticking while paused so overlays can still animate.
   */
  render(alpha: number, dtMs: number): void;
  /** When true the loop neither steps nor accumulates, and pins alpha to 1. */
  isPaused(): boolean;
}

export interface Loop {
  /** Begin scheduling frames. Idempotent. */
  start(): void;
  /** Cancel the pending frame. Idempotent. */
  stop(): void;
  /** Run one frame for the given timestamp. Called by `start`; exposed for tests. */
  tickOnce(nowMs: number): void;
}

export interface LoopOptions {
  /** Clock used to re-baseline on `start`. Default: `performance.now`. */
  now?: () => number;
  /** Frame scheduler returning a cancellation handle. Default: `requestAnimationFrame`. */
  schedule?: (fn: (t: number) => void) => number;
  /** Cancels a handle from `schedule`. Default: `cancelAnimationFrame`. */
  cancel?: (h: number) => void;
}

export function createLoop(cb: LoopCallbacks, opts?: LoopOptions): Loop {
  // The browser defaults are only ever *referenced* here, never called, unless
  // the caller leaves them out — which the tests never do.
  const now = opts?.now ?? ((): number => performance.now());
  const schedule =
    opts?.schedule ??
    ((fn: (t: number) => void): number => requestAnimationFrame(fn));
  const cancel =
    opts?.cancel ??
    ((h: number): void => {
      cancelAnimationFrame(h);
    });

  let lastMs = 0;
  // The accumulator is kept in TICKS, not milliseconds: `alpha` is then simply
  // the fractional part, so it cannot land outside [0, 1) however the doubles
  // round, and the leftover is never a subtraction of an inexact 16.666… ms.
  let accTicks = 0;
  let handle: number | null = null;

  function tickOnce(nowMs: number): void {
    let dt = nowMs - lastMs;
    // NaN-safe by construction (`!(NaN > 0)` is true): a garbage timestamp
    // contributes nothing instead of poisoning the accumulator.
    if (!(dt > 0)) {
      dt = 0; // non-monotonic clock (or the very first frame): nothing to advance
    } else if (dt > MAX_DT_MS) {
      dt = MAX_DT_MS;
    }
    if (Number.isFinite(nowMs)) {
      lastMs = nowMs; // …and a NaN timestamp must not become the new baseline,
      // or every later frame would measure `now - NaN` and the loop would die.
    }

    if (cb.isPaused()) {
      // The core freezes on pause: prev == current for every entity, so alpha
      // must be pinned. A cycling alpha would visibly jitter every tank between
      // prevX/prevY and x/y for the whole pause (contract from T1.6/T1.7).
      // The accumulator is deliberately NOT advanced, so unpausing cannot
      // release a burst of catch-up steps.
      cb.render(1, dt);
      return;
    }

    accTicks += dt / TICK_MS;
    // One division per frame, not one subtraction per step: repeatedly
    // subtracting a tick loses a ULP each time, enough to make an exact 100 ms
    // frame run 5 ticks instead of 6.
    const wanted = Math.floor(accTicks);
    const steps = wanted > MAX_STEPS_PER_TICK ? MAX_STEPS_PER_TICK : wanted;
    for (let i = 0; i < steps; i++) {
      cb.step();
    }
    accTicks -= steps;
    if (accTicks >= 1) {
      // The cap fired. Drop the whole ticks we refused to run but keep the
      // sub-tick phase, so the next frame resumes where this one left off.
      accTicks -= Math.floor(accTicks);
    }
    cb.render(accTicks, dt);
  }

  function frame(t: number): void {
    // Re-arm first so a stop() from inside step/render cancels *this* handle
    // and the loop really ends.
    handle = schedule(frame);
    tickOnce(t);
  }

  function start(): void {
    if (handle !== null) {
      return;
    }
    // Re-baseline: without this the first frame's dt would be the whole page
    // lifetime and get clamped, costing a pointless 10-step catch-up.
    lastMs = now();
    handle = schedule(frame);
  }

  function stop(): void {
    if (handle === null) {
      return;
    }
    cancel(handle);
    handle = null;
  }

  return { start, stop, tickOnce };
}
