// src/app/loop.ts — the fixed-timestep driver (arch §3.4).
//
// The core simulation advances in whole 60 Hz ticks and nothing else; this loop
// is the only place where wall-clock time is turned into ticks. Everything that
// touches the browser (the clock and the frame scheduler) is injected, so the
// loop is testable in plain Node.

/** One simulation tick, in milliseconds (60 Hz — core `TICK_S` is 1/60). */
const TICK_MS = 1000 / 60;

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
   * Draw one frame. `alpha` is the fraction of a tick left in the accumulator
   * (always in [0, 1)) for interpolating between the previous and current tick;
   * `dtMs` is the clamped frame time, for time-based presentation effects.
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
  let acc = 0;
  let handle: number | null = null;

  function tickOnce(nowMs: number): void {
    let dt = nowMs - lastMs;
    lastMs = nowMs;
    if (!(dt > 0)) {
      dt = 0; // non-monotonic clock (or the very first frame): nothing to advance
    } else if (dt > MAX_DT_MS) {
      dt = MAX_DT_MS;
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

    acc += dt;
    // Computed by division rather than repeated subtraction: the subtracting
    // form loses a ULP per iteration, which is enough to make an exact 100 ms
    // frame run 5 ticks instead of 6.
    const wanted = Math.floor(acc / TICK_MS);
    const steps = wanted > MAX_STEPS_PER_TICK ? MAX_STEPS_PER_TICK : wanted;
    for (let i = 0; i < steps; i++) {
      cb.step();
    }
    acc -= steps * TICK_MS;
    if (wanted > steps) {
      acc %= TICK_MS; // dropped the whole ticks we refused to run; keep the phase
    }
    if (acc < 0) {
      acc = 0; // 1-ULP guard: alpha must stay in [0, 1)
    }
    cb.render(acc / TICK_MS, dt);
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
