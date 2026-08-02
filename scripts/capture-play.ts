// scripts/capture-play.ts — the first playable, measured while it is played.
//
//   npm run dev          # in another terminal — the script needs it
//   npm run capture:play
//
// Committed output: `docs/calibration/play.json`. Screenshots (git-ignored) go
// to `screens/play/` unless CAPTURE_OUT says otherwise.
//
// ## What makes this different from capture-entities / capture-post
//
// Those two build their own rig: they compose the render layer by hand and
// write tank positions directly, because a reproducible frame is what a
// calibration target needs. This one measures the OPPOSITE thing — the real
// page, the real `main.ts`, the real loop, with the simulation running and keys
// being pressed. Nothing is injected into the game; the instrumentation lives
// entirely in an init script that patches `requestAnimationFrame` and the WebGL
// draw entry points before any application code runs.
//
// That matters for arch §11's "Render CPU ≤ 6 ms @High desktop": every earlier
// number in this repo was SwiftShader drawing a static board. This one is a
// real GPU (the browser is launched headed for exactly that reason — headless
// Chromium falls back to SwiftShader) with tanks, bullets and terrain damage
// happening, and the GL renderer string is recorded next to the numbers so the
// figure is attributable rather than merely quoted.
//
// Timing is measured around the whole rAF callback, i.e. `step()` + `render()`.
// The sim's share is known independently — 2.11 µs/step (T1.8) — so this is a
// render-CPU figure with ~0.002 ms of simulation folded in.

import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT = process.env.CAPTURE_OUT ?? join('screens', 'play');
const ARTIFACT = join('docs', 'calibration', 'play.json');

const W = 1600;
const H = 900;
/** Fixed so the AI, the spawn cycle and the power-up rolls repeat run to run. */
const SEED = 20260802;
/** Fidelity §11.1: a 2 s "STAGE N" curtain before the controls come alive. */
const INTRO_MS = 2000;

type Quality = 'low' | 'medium' | 'high';
const QUALITIES: readonly Quality[] = ['high', 'medium', 'low'];

interface FrameSample {
  ms: number;
  calls: number;
}

interface LoopStats {
  frames: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  drawCalls: { min: number; median: number; max: number };
}

interface Results {
  capturedAt: string;
  url: string;
  viewport: { w: number; h: number; devicePixelRatio: number };
  gpu: { vendor: string; renderer: string; headless: boolean };
  /** What Auto picks now that the probe samples a drawing frame. */
  autoProbe: { picked: string; fps: number; dpr: number; cores: number } | null;
  /** Real-loop cost per preset, measured mid-action. */
  loop: Record<string, LoopStats>;
  /** The board state each measurement window ran against. */
  scene: Record<string, { enemiesLeftAtEnd: number; scoreAtEnd: number }>;
  budget: { renderCpuMs: number; drawCalls: number };
  /** Every console/page error seen across every run. Must stay empty. */
  consoleErrors: string[];
  /** Any HTTP response ≥ 400, with its URL. Must stay empty. */
  failedRequests: string[];
}

// ---------------------------------------------------------------------------
// Page-side instrumentation. Installed via addInitScript, so it is in place
// before `main.ts` evaluates and before the first GL context exists.
// ---------------------------------------------------------------------------

interface PerfHook {
  start(): void;
  stop(): FrameSample[];
}

/**
 * tsx transpiles this file with esbuild's `keepNames`, which rewrites every
 * named function as `__name(function …, "name")` and defines `__name` once at
 * the top of the MODULE. Playwright serialises the function body alone, so the
 * helper is missing in the page and the init script dies with `__name is not
 * defined` — silently, because an init-script failure only shows up later as a
 * missing hook. A one-line global shim is the smallest fix that does not fight
 * the toolchain, and it is installed before everything else.
 */
const KEEP_NAMES_SHIM = 'globalThis.__name ??= (fn) => fn;';

function instrument(): void {
  const draws = { n: 0 };
  const patch = (proto: object): void => {
    const p = proto as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of [
      'drawElements',
      'drawArrays',
      'drawElementsInstanced',
      'drawArraysInstanced',
    ]) {
      const orig = p[k];
      if (typeof orig !== 'function') {
        continue;
      }
      p[k] = function (this: unknown, ...a: unknown[]): unknown {
        draws.n++;
        return orig.apply(this, a);
      };
    }
  };
  const g = globalThis as unknown as {
    WebGL2RenderingContext?: { prototype: object };
    WebGLRenderingContext?: { prototype: object };
    requestAnimationFrame: (cb: (t: number) => void) => number;
    __bcperf?: PerfHook;
  };
  if (g.WebGL2RenderingContext) {
    patch(g.WebGL2RenderingContext.prototype);
  }
  if (g.WebGLRenderingContext) {
    patch(g.WebGLRenderingContext.prototype);
  }

  const samples: FrameSample[] = [];
  let recording = false;
  const raf = g.requestAnimationFrame.bind(globalThis);
  g.requestAnimationFrame = (cb: (t: number) => void): number =>
    raf((t: number) => {
      const c0 = draws.n;
      const t0 = performance.now();
      cb(t);
      const ms = performance.now() - t0;
      // Only callbacks that actually DREW are loop frames: the auto probe's own
      // rAF chain issues no draw calls, and counting it would halve the mean.
      if (recording && draws.n > c0) {
        samples.push({ ms, calls: draws.n - c0 });
      }
    });

  g.__bcperf = {
    start(): void {
      samples.length = 0;
      recording = true;
    },
    stop(): FrameSample[] {
      recording = false;
      return samples.slice();
    },
  };
}

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A scripted skirmish: circle out of the base, shoot up the corridor, come
 * back. Held fire keys are the point — that is the input layer's turbo pulse
 * driving the core's press-edge detector for real.
 */
const SCRIPT: readonly [string, number][] = [
  ['KeyW', 700],
  ['KeyJ', 600],
  ['KeyA', 500],
  ['KeyW', 700],
  ['KeyJ', 900],
  ['KeyD', 800],
  ['KeyJ', 700],
  ['KeyW', 600],
  ['KeyJ', 1100],
  ['KeyD', 500],
  ['KeyS', 700],
  ['KeyJ', 900],
];

async function play(page: Page, budgetMs: number): Promise<void> {
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < budgetMs) {
    const [code, ms] = SCRIPT[i % SCRIPT.length];
    i++;
    await page.keyboard.down(code);
    await sleep(Math.min(ms, budgetMs - (Date.now() - t0)));
    await page.keyboard.up(code);
  }
}

function stats(samples: FrameSample[]): LoopStats {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const calls = samples.map((s) => s.calls).sort((a, b) => a - b);
  const pick = (xs: number[], q: number): number =>
    xs[Math.min(xs.length - 1, Math.floor(xs.length * q))];
  const total = ms.reduce((a, b) => a + b, 0);
  const round = (n: number): number => +n.toFixed(3);
  return {
    frames: samples.length,
    meanMs: round(total / Math.max(1, ms.length)),
    medianMs: round(pick(ms, 0.5)),
    p95Ms: round(pick(ms, 0.95)),
    maxMs: round(ms[ms.length - 1] ?? 0),
    // Frames actually delivered over the window, i.e. the rate a player saw.
    fps: 0,
    drawCalls: {
      min: calls[0] ?? 0,
      median: pick(calls, 0.5) ?? 0,
      max: calls[calls.length - 1] ?? 0,
    },
  };
}

/**
 * A page with the frame instrumentation armed and its console watched. The
 * error list is part of the artifact: "no console errors over a real played
 * stage" is a claim, and this is what backs it.
 */
async function newInstrumentedPage(
  browser: Browser,
  results: Results,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => {
    results.consoleErrors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push(msg.text());
    }
  });
  // A failed resource logs as a bare "Failed to load resource: … 404", with no
  // hint of WHAT failed. Recording the URL is the difference between an error
  // that can be fixed and one that can only be shrugged at.
  page.on('response', (res) => {
    if (res.status() >= 400) {
      results.failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });
  await page.addInitScript({ content: KEEP_NAMES_SHIM });
  await page.addInitScript(instrument);
  return page;
}

async function hudNumber(page: Page, name: string): Promise<number> {
  const text = await page.locator(`[data-hud="${name}"]`).textContent();
  return Number(text ?? '0');
}

async function measure(
  browser: Browser,
  quality: Quality,
  results: Results,
  shots: boolean,
): Promise<void> {
  const page = await newInstrumentedPage(browser, results);
  await page.goto(`${BASE}?quality=${quality}&seed=${SEED}`);
  await page.locator('[data-hud="root"]').waitFor();
  await sleep(INTRO_MS + 500);

  // Warm up: let the field populate and the first shots land, so the measured
  // window is a busy board rather than an empty one.
  await play(page, 6000);

  await page.evaluate(() => {
    (globalThis as unknown as { __bcperf: PerfHook }).__bcperf.start();
  });
  const windowMs = 8000;
  const t0 = Date.now();
  const playing = play(page, windowMs);

  if (shots) {
    // A burst while the board is at its busiest — one of these has a bullet in
    // flight, which is the frame the report needs.
    for (let i = 0; i < 6; i++) {
      await sleep(700);
      await page.screenshot({ path: join(OUT, `play-${quality}-${i}.png`) });
    }
  }
  await playing;
  const elapsed = Date.now() - t0;

  const samples = await page.evaluate(() =>
    (globalThis as unknown as { __bcperf: PerfHook }).__bcperf.stop(),
  );

  const row = stats(samples);
  row.fps = +((samples.length * 1000) / elapsed).toFixed(1);
  results.loop[quality] = row;
  results.scene[quality] = {
    enemiesLeftAtEnd: await hudNumber(page, 'enemies-left'),
    scoreAtEnd: await hudNumber(page, 'p1-score'),
  };

  if (shots) {
    results.viewport = {
      w: W,
      h: H,
      devicePixelRatio: await page.evaluate(() => globalThis.devicePixelRatio),
    };
    results.gpu = {
      ...(await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2');
        if (!gl) {
          return { vendor: '(no webgl2)', renderer: '(no webgl2)' };
        }
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext) {
          return {
            vendor: '(masked)',
            renderer: gl.getParameter(gl.RENDERER) as string,
          };
        }
        return {
          vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string,
          renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string,
        };
      })),
      headless: false,
    };
  }

  await page.close();
}

/** A load with no `?quality`, so the Auto path runs and prints its decision. */
async function probeAuto(browser: Browser, results: Results): Promise<void> {
  const page = await newInstrumentedPage(browser, results);
  const decision = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, 20_000);
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.text().startsWith('auto quality')) {
        clearTimeout(timer);
        resolve(msg.text());
      }
    });
  });
  await page.goto(`${BASE}?seed=${SEED}`);
  await page.locator('[data-hud="root"]').waitFor();
  // The probe samples its second over a DRAWING loop now, so the board has to
  // be doing something while it counts — an idle intro curtain is still a real
  // frame, but a busy field is the honest load.
  const playing = play(page, 4000);
  const line = await decision;
  // Awaited before closing: a key-up landing on a closed page is an unhandled
  // rejection that kills the process after the artifact is already written.
  await playing;
  await page.close();

  if (line === null) {
    results.autoProbe = null;
    return;
  }
  // `console.log('auto quality', picked, sample)` — Playwright renders it as
  // `auto quality high {fps: 60.1, dpr: 1, cores: 16}`.
  const picked = /auto quality (\w+)/.exec(line)?.[1] ?? '(unparsed)';
  const num = (key: string): number =>
    Number(new RegExp(`${key}:\\s*([0-9.]+)`).exec(line)?.[1] ?? NaN);
  results.autoProbe = {
    picked,
    fps: num('fps'),
    dpr: num('dpr'),
    cores: num('cores'),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: BASE,
    viewport: { w: W, h: H, devicePixelRatio: 1 },
    gpu: { vendor: '', renderer: '', headless: false },
    autoProbe: null,
    loop: {},
    scene: {},
    // arch §11's row, restated here so the artifact carries its own pass/fail.
    budget: { renderCpuMs: 6, drawCalls: 120 },
    consoleErrors: [],
    failedRequests: [],
  };

  // Headed: Playwright's headless Chromium renders through SwiftShader, and a
  // software rasteriser is not the machine anybody plays on.
  const browser = await chromium.launch({ headless: false });
  try {
    for (const quality of QUALITIES) {
      await measure(browser, quality, results, quality === 'high');
    }
    await probeAuto(browser, results);
  } finally {
    await browser.close();
  }

  writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nscreenshots → ${OUT}`);
  console.log(`measurements → ${ARTIFACT}\n`);
  console.log(`GPU: ${results.gpu.vendor} / ${results.gpu.renderer}`);
  console.table(results.loop);
  console.log('auto probe:', results.autoProbe);
}

void main();
