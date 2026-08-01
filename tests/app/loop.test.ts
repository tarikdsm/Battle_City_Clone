import { describe, expect, it } from 'vitest';
import { createLoop, type LoopCallbacks } from '../../src/app/loop';

// The loop's contract in one number: the sim advances at 60 Hz, so one tick is
// 1000/60 ms. Declared here independently of the implementation on purpose —
// these tests pin the contract, not the constant.
const TICK_MS = 1000 / 60;

interface Probe {
  cb: LoopCallbacks;
  steps: number;
  renders: { alpha: number; dtMs: number }[];
  paused: boolean;
}

function probe(): Probe {
  const p: Probe = {
    steps: 0,
    renders: [],
    paused: false,
    cb: {
      step(): void {
        p.steps++;
      },
      render(alpha: number, dtMs: number): void {
        p.renders.push({ alpha, dtMs });
      },
      isPaused(): boolean {
        return p.paused;
      },
    },
  };
  return p;
}

/** Last render of the run — every `tickOnce` renders exactly once. */
function lastRender(p: Probe): { alpha: number; dtMs: number } {
  const r = p.renders.at(-1);
  if (!r) {
    throw new Error('render was never called');
  }
  return r;
}

describe('createLoop — fixed timestep (arch §3.4)', () => {
  it('steps 6 times for 100 ms and renders an alpha in [0, 1)', () => {
    const p = probe();
    const loop = createLoop(p.cb);

    loop.tickOnce(100);

    expect(p.steps).toBe(6);
    expect(p.renders).toHaveLength(1);
    const { alpha, dtMs } = lastRender(p);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
    expect(dtMs).toBe(100);
  });

  it('clamps a 400 ms spike to 250 ms and never exceeds the 10-step cap', () => {
    const p = probe();
    const loop = createLoop(p.cb);

    loop.tickOnce(400);

    // 250 ms of budget is worth 14 whole ticks (250 / 16.666… = 14.999…, NOT the
    // 15 the brief assumed), and the runaway guard trims that to 10 regardless.
    expect(p.steps).toBeLessThanOrEqual(15);
    expect(p.steps).toBe(10);
    // render sees the CLAMPED dt — nothing downstream should ever animate a
    // 400 ms frame just because the tab was in the background.
    expect(lastRender(p).dtMs).toBe(250);
    expect(lastRender(p).alpha).toBeLessThan(1);
  });

  it('caps a 1000 ms spike at 10 steps and drops the remainder', () => {
    const p = probe();
    const loop = createLoop(p.cb);

    loop.tickOnce(1000);
    expect(p.steps).toBe(10);
    expect(lastRender(p).alpha).toBeLessThan(1);

    // The dropped remainder must not resurface: the next frame gets only the
    // steps its own dt pays for (a spiral of death would burst here).
    p.steps = 0;
    loop.tickOnce(1016);
    expect(p.steps).toBeLessThanOrEqual(2);
  });

  it('carries the accumulator remainder across calls', () => {
    const p = probe();
    const loop = createLoop(p.cb);

    // NOTE (brief deviation): the brief predicts "two calls of 8 ms ⇒ 0 then 1
    // step", but 8 + 8 = 16 ms is *below* the 16.667 ms threshold it names in
    // the same sentence, so the tick can only land on the third call. The
    // property under test — the sub-tick remainder is kept, not discarded — is
    // asserted here with arithmetic that matches TICK_MS = 1000/60.
    loop.tickOnce(8);
    expect(p.steps).toBe(0);
    expect(lastRender(p).alpha).toBeCloseTo(8 / TICK_MS, 12);

    loop.tickOnce(16);
    expect(p.steps).toBe(0);
    expect(lastRender(p).alpha).toBeCloseTo(16 / TICK_MS, 12);

    loop.tickOnce(24);
    expect(p.steps).toBe(1);
    expect(lastRender(p).alpha).toBeCloseTo((24 - TICK_MS) / TICK_MS, 12);
  });

  it('pauses hard: no steps, alpha pinned to 1, accumulator frozen', () => {
    const p = probe();
    const loop = createLoop(p.cb);
    p.paused = true;

    loop.tickOnce(100);
    loop.tickOnce(200);
    loop.tickOnce(300);

    expect(p.steps).toBe(0);
    expect(p.renders).toHaveLength(3);
    for (const r of p.renders) {
      // Exactly 1 — the core froze, so prev == current and any other alpha
      // would visibly jitter every tank for the whole pause (T1.6/T1.7).
      expect(r.alpha).toBe(1);
    }

    // Unpausing must not release a burst of catch-up steps: the 300 ms spent
    // paused was never accumulated, so this frame is worth its own 100 ms only.
    p.paused = false;
    loop.tickOnce(400);
    expect(p.steps).toBe(6);
  });

  it('shrugs off a backwards or NaN timestamp and keeps running after it', () => {
    const p = probe();
    const loop = createLoop(p.cb);

    loop.tickOnce(100);
    expect(p.steps).toBe(6);

    // The clock went backwards (a non-monotonic source, or a stop/start race).
    p.steps = 0;
    loop.tickOnce(50);
    expect(p.steps).toBe(0);
    expect(lastRender(p).dtMs).toBe(0);

    // A garbage timestamp must contribute nothing AND must not become the new
    // baseline — if it did, every later frame would measure `now - NaN` and the
    // loop would never step again.
    loop.tickOnce(Number.NaN);
    expect(p.steps).toBe(0);
    expect(lastRender(p).dtMs).toBe(0);
    expect(Number.isFinite(lastRender(p).alpha)).toBe(true);

    // Recovery: the baseline is the last *finite* timestamp (50 — a backwards
    // clock does re-baseline, otherwise the next frame would see a huge dt), so
    // this frame is worth 100 ms.
    loop.tickOnce(150);
    expect(p.steps).toBe(6);
  });

  it('drives start/stop through the injected scheduler, never a global RAF', () => {
    // The node test environment has no requestAnimationFrame at all: if the
    // loop reached for the global default this suite would throw.
    expect(
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame,
    ).toBeUndefined();

    const p = probe();
    const scheduled: ((t: number) => void)[] = [];
    const cancelled: number[] = [];
    let nextHandle = 1;
    const loop = createLoop(p.cb, {
      now: () => 1000,
      schedule: (fn) => {
        scheduled.push(fn);
        return nextHandle++;
      },
      cancel: (h) => {
        cancelled.push(h);
      },
    });

    loop.start();
    expect(scheduled).toHaveLength(1);
    loop.start(); // idempotent — must not double-schedule
    expect(scheduled).toHaveLength(1);

    // start() re-baselines the clock from `now`, so the first frame's dt is
    // measured from 1000, not from 0.
    scheduled[0](1100);
    expect(p.steps).toBe(6);
    expect(scheduled).toHaveLength(2); // re-armed for the next frame

    loop.stop();
    expect(cancelled).toEqual([2]);

    loop.stop(); // idempotent
    expect(cancelled).toEqual([2]);
  });
});
