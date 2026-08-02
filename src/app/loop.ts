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
  /**
   * Run once per rendered FRAME, before any step and whether or not the core is
   * paused. Optional, and it exists for exactly one thing: reading a **polled**
   * input device (the gamepad — T9.1). A device with no events has to be
   * sampled, and sampling it inside `step` would tie it to the 60 Hz tick, so a
   * button pressed and released between two ticks on a 144 Hz display would
   * never be seen. Sampling here, and draining in `step`, is what gives a
   * polled pad the same sub-tick press latch the keyboard has.
   */
  frame?(dtMs: number): void;
  /**
   * Advance the simulation exactly one tick.
   *
   * Called **once on a paused frame too**, and must therefore be safe to run
   * while frozen: a paused `stepGame` resolves the pause toggle from the pad
   * and returns without advancing anything. That call is the only thing that
   * can ever unpause the game — see `isPaused` and the branch in `tickOnce`.
   */
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
  /**
   * When true the loop does not **accumulate**, and pins alpha to 1. It still
   * calls `step` exactly once per frame — a paused core is the only thing that
   * can unpause itself, and it needs the pad to reach it (T3.3).
   */
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
    // One condition covers every unusable dt: NaN, ±Infinity and a backwards
    // clock all contribute nothing. Infinity in particular must NOT fall
    // through to the clamp below — a garbage timestamp is not a 250 ms spike,
    // and treating it as one would burn a 10-step catch-up on nothing.
    if (!Number.isFinite(dt) || dt <= 0) {
      dt = 0; // non-monotonic clock (or the very first frame): nothing to advance
    } else if (dt > MAX_DT_MS) {
      dt = MAX_DT_MS;
    }
    if (Number.isFinite(nowMs)) {
      lastMs = nowMs; // …and a NaN timestamp must not become the new baseline,
      // or every later frame would measure `now - NaN` and the loop would die.
    }

    // Before the pause fork: a paused core still runs one `step`, and that step
    // is the only thing that can ever unpause it — so the pad has to have been
    // read by the time it runs.
    cb.frame?.(dt);

    if (cb.isPaused()) {
      // **One step, and that is not a contradiction** (fixed at T3.3). A paused
      // `stepGame` runs its pause preamble ONLY: it reads the pad, resolves the
      // toggle edge, and returns without advancing `tick`, without touching a
      // timer and without running a system — `game.ts` says so in as many
      // words, "the pad has to work when nothing else does, or a paused game
      // could never be unpaused".
      //
      // Until T3.3 this branch skipped `step()` altogether, which meant nothing
      // polled the pad again and **the pause was a one-way door**: the only code
      // that can clear `state.paused` is the very code the loop had stopped
      // calling. It shipped that way and no test caught it, because the e2e's
      // resume check compares pixels and the renderer kept animating through the
      // pause — a wedged loop still produced a moving picture. Freezing
      // presentation animation (the other half of T3.3) is what made it visible.
      cb.step();
      // The core froze, so prev == current for every entity and alpha must be
      // pinned. A cycling alpha would visibly jitter every tank between
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
    // lifetime and get clamped, costing a pointless 10-step catch-up. Gated on
    // finiteness like every other write to lastMs — a clock that hands back
    // garbage costs one frame, never the baseline.
    const t = now();
    if (Number.isFinite(t)) {
      lastMs = t;
    }
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
