// tests/app/perf.test.ts — the frame-phase counters (arch §11, T10).
//
// Two properties matter and neither is about the numbers: the module must be
// INERT until a recording starts (a shipped player pays nothing, and a dev
// session pays nothing until the recorder asks), and a sample must pair each
// frame with every tick that preceded it — the fixed-timestep loop does not run
// one step per frame, so a naive 1:1 reading would misattribute the sim cost.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installPerfHandle,
  markFrameEnd,
  markFrameStart,
  markStepEnd,
  markStepStart,
  type PerfHandle,
} from '../../src/app/perf';

function handle(): PerfHandle {
  installPerfHandle();
  const h = (globalThis as unknown as { __bcPerf?: PerfHandle }).__bcPerf;
  if (h === undefined) throw new Error('perf handle not installed');
  return h;
}

function step(): void {
  markStepStart();
  markStepEnd();
}

function frame(): void {
  markFrameStart();
  markFrameEnd();
}

describe('perf counters (arch §11)', () => {
  beforeEach(() => {
    // Every test starts from a stopped, drained recorder.
    handle().stop();
  });

  it('records nothing at all until a recording is started', () => {
    const h = handle();
    step();
    frame();
    // Starting AFTER those calls must not retro-collect them.
    h.start();
    expect(h.stop()).toEqual([]);
  });

  it('attributes every step since the last frame to that frame', () => {
    const h = handle();
    h.start();
    // Frame 1: three ticks. Frame 2: none — a frame may draw alone when the
    // display runs faster than 60 Hz, and that frame's sim share is truly 0.
    step();
    step();
    step();
    frame();
    frame();
    const out = h.stop();

    expect(out).toHaveLength(2);
    expect(out[0].steps).toBe(3);
    expect(out[1].steps).toBe(0);
    for (const s of out) {
      expect(s.simMs).toBeGreaterThanOrEqual(0);
      expect(s.renderMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('measures a real interval rather than reporting a constant', () => {
    const h = handle();
    h.start();
    markStepStart();
    const until = performance.now() + 2;
    while (performance.now() < until) {
      /* burn a measurable slice */
    }
    markStepEnd();
    frame();
    const out = h.stop();
    expect(out).toHaveLength(1);
    expect(out[0].simMs).toBeGreaterThan(1);
  });

  it('stop() ends AND drains the window', () => {
    const h = handle();
    h.start();
    frame();
    expect(h.stop()).toHaveLength(1);
    frame();
    expect(h.stop()).toHaveLength(0);
  });
});
