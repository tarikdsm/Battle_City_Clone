// src/app/perf.ts — frame-phase instrumentation (arch §11).
//
// Arch §11 budgets the frame in separate numbers — sim step ≤ 2 ms, render CPU
// ≤ 6 ms, draw calls — and until T10 nothing in this repo could tell them apart
// in the REAL loop. A harness that patches `requestAnimationFrame`
// (`scripts/capture-play.ts`) only ever sees `step() + render()` as one blob, so
// the sim's share had to be quoted from a bench rig instead of measured where it
// runs. This module is the missing split: the play screen marks each phase and
// the recorder reads the ring off `globalThis.__bcPerf`.
//
// **Dev builds only, and provably so.** `ENABLED` is `import.meta.env.DEV`,
// which Vite statically replaces with the literal `false` in a production
// bundle; every function below then short-circuits on a constant and the global
// is never installed. Same argument `debug.ts` makes for the URL flags.
//
// The API is begin/end marks rather than a `timeX(fn)` wrapper on purpose: a
// wrapper allocates one closure per tick and per frame, and arch §11 asks for
// near-zero steady-state allocation on exactly those two paths. Marks cost two
// `performance.now()` calls and nothing else.
//
// Steps and frames are NOT one-to-one: the fixed-timestep loop can run several
// ticks for one rendered frame, or none. A sample is therefore "all the sim time
// that accumulated before this frame drew", with the step count beside it, so a
// reader can divide when it wants per-step and leave it alone when it does not.

/** One rendered frame: the sim time that preceded it, and its own draw cost. */
export interface PerfSample {
  /** Total `stepGame` time attributed to this frame, in ms. */
  simMs: number;
  /** How many ticks that total covers. 0 is legal — a frame may draw alone. */
  steps: number;
  /** Time inside `view.render` + the audio update, in ms. */
  renderMs: number;
}

/** What the recorder sees on `globalThis.__bcPerf`. */
export interface PerfHandle {
  /** Begin collecting. Clears anything already buffered. */
  start(): void;
  /** Stop collecting and drain the samples gathered since `start`. */
  stop(): PerfSample[];
}

/**
 * Folded to `false` in production by Vite, which is what makes every guard below
 * dead code rather than a runtime branch.
 */
const ENABLED = import.meta.env.DEV;

/**
 * Bound so a page left running for an afternoon cannot grow the buffer without
 * limit. 36,000 frames is ten minutes at 60 Hz — far longer than any measurement
 * window, and the recorder's windows are 8 s.
 */
const MAX_SAMPLES = 36_000;

const samples: PerfSample[] = [];
let recording = false;
let stepStartedAt = 0;
let renderStartedAt = 0;
let pendingSimMs = 0;
let pendingSteps = 0;

/** Mark the start of one simulation tick. */
export function markStepStart(): void {
  if (!ENABLED || !recording) return;
  stepStartedAt = performance.now();
}

/**
 * Close one simulation tick. The total is held until the next `markFrameEnd`,
 * so a frame that ran three ticks reports all three.
 */
export function markStepEnd(): void {
  if (!ENABLED || !recording) return;
  pendingSimMs += performance.now() - stepStartedAt;
  pendingSteps += 1;
}

/** Mark the start of one rendered frame. */
export function markFrameStart(): void {
  if (!ENABLED || !recording) return;
  renderStartedAt = performance.now();
}

/** Close the frame, and with it the sample the steps above accumulated. */
export function markFrameEnd(): void {
  if (!ENABLED || !recording) return;
  const renderMs = performance.now() - renderStartedAt;
  if (samples.length < MAX_SAMPLES) {
    samples.push({ simMs: pendingSimMs, steps: pendingSteps, renderMs });
  }
  pendingSimMs = 0;
  pendingSteps = 0;
}

/**
 * Publish the handle on `globalThis`. Called once by the app entry point; a
 * no-op in production, where `ENABLED` is the literal `false`.
 */
export function installPerfHandle(): void {
  if (!ENABLED) return;
  const handle: PerfHandle = {
    start(): void {
      samples.length = 0;
      pendingSimMs = 0;
      pendingSteps = 0;
      recording = true;
    },
    // Drains as well as stops, so a second `stop` cannot hand the same window
    // out twice and a stale buffer can never be read as a fresh capture.
    stop(): PerfSample[] {
      recording = false;
      const out = samples.slice();
      samples.length = 0;
      pendingSimMs = 0;
      pendingSteps = 0;
      return out;
    },
  };
  (globalThis as unknown as { __bcPerf?: PerfHandle }).__bcPerf = handle;
}
