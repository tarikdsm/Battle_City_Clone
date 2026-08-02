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

/**
 * The viewport sweep. Wide, square-ish, tall/portrait, a HiDPI case, a tiny
 * one, and one that is RESIZED after load — the path that broke.
 */
const VIEWPORTS: readonly {
  w: number;
  h: number;
  dpr: number;
  quality: Quality;
  resizeTo?: [number, number];
}[] = [
  { w: 1600, h: 900, dpr: 1, quality: 'high' },
  { w: 1280, h: 720, dpr: 1.5, quality: 'low' },
  { w: 770, h: 587, dpr: 1.5, quality: 'low' },
  { w: 1024, h: 1024, dpr: 1, quality: 'medium' },
  { w: 480, h: 900, dpr: 2, quality: 'low' }, // portrait: HUD docks to the bottom
  { w: 1200, h: 400, dpr: 1, quality: 'medium' }, // letterbox
  { w: 770, h: 587, dpr: 1.5, quality: 'low', resizeTo: [1280, 720] },
];

/**
 * Pass/fail bounds, in the artifact so it carries its own verdict.
 *
 * The frustum is a **contain-fit**, so the right invariant is not "the board
 * fills the height" — on a tall canvas it fills the *width* instead and the
 * height fraction is legitimately low (0.46 in portrait). What must hold at
 * every aspect is:
 *
 * - `minLimitingFill` — the board spans ≥ 80% of whichever axis is limiting.
 *   The geometric value is 0.87 (the drawn content is `BOARD_U` wide by
 *   `BOARD_U·cos32 + SCENE_H·sin32` tall against a frustum with `MARGIN_U` of
 *   slack); the margin absorbs frame pixels too dark to clear the brightness
 *   threshold. **The bug this guards against measured 0.58**, so the bound is
 *   nowhere near the failure it has to catch.
 * - `boardAspect` — the drawn box keeps the board's own on-screen aspect. A
 *   board scaled by a stale blit keeps its aspect, which is why this alone is
 *   not sufficient and the fill bound above is the primary guard.
 * - `maxCenterOffsetX` — horizontal framing is symmetric, always.
 * - `maxCenterOffsetYFrac` — vertical framing is deliberately NOT symmetric:
 *   `CAMERA_TARGET_Y` reserves `SCENE_H·sin32 / 2` of headroom upward so tall
 *   pieces are not clipped, which biases the content box down by ~2.4% of the
 *   frame. Bounded rather than zeroed, because zeroing it would be asserting
 *   the opposite of what `sceneRoot.ts` documents.
 */
const EXPECT = {
  minLimitingFill: 0.8,
  boardAspect: 1.16,
  boardAspectTol: 0.05,
  maxCenterOffsetX: 3,
  maxCenterOffsetYFrac: 0.06,
  maxHudOverlapPx2: 0,
};

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
  /** Board framing + HUD docking at every viewport. Every row must pass. */
  viewportExpectations: typeof EXPECT;
  viewports: {
    label: string;
    viewport: number[];
    canvasBox: number[];
    hudBox: number[];
    hudOverlapPx2: number;
    board: BoardBox | null;
    boardAspect: number;
    pass: boolean;
  }[];
  /**
   * Shader compile warnings per preset, with their origin. Recorded because the
   * DoD forbids three.js warnings and these come from upstream (see the report).
   */
  shaderWarnings: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Page-side instrumentation. Installed via addInitScript, so it is in place
// before `main.ts` evaluates and before the first GL context exists.
// ---------------------------------------------------------------------------

interface PerfHook {
  start(): void;
  stop(): FrameSample[];
  /** Ask for a board bounding box on the next frame that draws. */
  wantBox(): void;
  /** The box from the last `wantBox`, or null if no frame has drawn yet. */
  box(): BoardBox | null;
}

/** The board's on-screen extent, measured from the pixels the GPU produced. */
interface BoardBox {
  /** Drawing-buffer size the box was measured in. */
  buffer: [number, number];
  /** x, y (top-down), w, h in drawing-buffer pixels. */
  rect: [number, number, number, number];
  /** Fraction of the drawing buffer the board spans. */
  fillW: number;
  fillH: number;
  /** Left margin − right margin, in pixels. 0 = perfectly centred. */
  centerOffsetX: number;
  centerOffsetY: number;
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
  let wantBox = false;
  let lastBox: BoardBox | null = null;

  // The board's extent, read back from the finished frame. Done here — inside
  // the rAF callback, before the compositor swaps — because the canvas has no
  // `preserveDrawingBuffer`, so this is the only moment the pixels exist.
  const measure = (): void => {
    const canvas = document.querySelector('canvas#game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl === null) {
      return;
    }
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // The clear colour is 0x0a0a0a (renderer.ts). Anything brighter is drawn.
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) {
      return; // nothing drawn yet
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    lastBox = {
      buffer: [W, H],
      // GL's origin is bottom-left; report the rect top-down like the screen.
      rect: [x0, H - 1 - y1, w, h],
      fillW: +(w / W).toFixed(4),
      fillH: +(h / H).toFixed(4),
      centerOffsetX: x0 - (W - 1 - x1),
      centerOffsetY: y0 - (H - 1 - y1),
    };
  };

  const raf = g.requestAnimationFrame.bind(globalThis);
  g.requestAnimationFrame = (cb: (t: number) => void): number =>
    raf((t: number) => {
      const c0 = draws.n;
      const t0 = performance.now();
      cb(t);
      const ms = performance.now() - t0;
      // Only callbacks that actually DREW are loop frames: the auto probe's own
      // rAF chain issues no draw calls, and counting it would halve the mean.
      if (draws.n === c0) {
        return;
      }
      if (recording) {
        samples.push({ ms, calls: draws.n - c0 });
      }
      if (wantBox) {
        wantBox = false;
        measure();
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
    wantBox(): void {
      wantBox = true;
    },
    box(): BoardBox | null {
      return lastBox;
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
  size?: { width: number; height: number; dpr: number },
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: size?.width ?? W, height: size?.height ?? H },
    deviceScaleFactor: size?.dpr ?? 1,
  });
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
  // Shader compile warnings are a per-preset fact (SMAA vs FXAA), so they are
  // collected against the preset rather than lumped into one list.
  const warnings: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'warning') {
      warnings.push(msg.text().replace(/\s+/g, ' ').trim());
    }
  });
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
  results.shaderWarnings[quality] = warnings;
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

/**
 * The regression the coordinator's G2 blocker asked for: at every viewport the
 * board must fill the frame and the HUD must not sit on top of it.
 *
 * Both facts are measured from what the GPU actually produced, not from the
 * numbers the app believes — the failure mode being guarded against had
 * `canvas.width`, the drawing buffer and the GL viewport all reading correct
 * while the board drew small and off-centre, so anything short of the pixels
 * would have called it green.
 */
async function sweep(browser: Browser, results: Results): Promise<void> {
  for (const v of VIEWPORTS) {
    const page = await newInstrumentedPage(browser, results, {
      width: v.w,
      height: v.h,
      dpr: v.dpr,
    });
    await page.goto(`${BASE}?quality=${v.quality}&seed=${SEED}`);
    await page.locator('[data-hud="root"]').waitFor();
    await sleep(1200);

    // A resized case re-runs the sizing path the way a real window drag does,
    // rather than only ever testing a fresh load.
    if (v.resizeTo) {
      await page.setViewportSize({
        width: v.resizeTo[0],
        height: v.resizeTo[1],
      });
      await sleep(1200);
    }

    await page.evaluate(() => {
      (globalThis as unknown as { __bcperf: PerfHook }).__bcperf.wantBox();
    });
    await sleep(300);
    const box = await page.evaluate(() =>
      (globalThis as unknown as { __bcperf: PerfHook }).__bcperf.box(),
    );
    const layout = await page.evaluate(() => {
      const c = (
        document.querySelector('canvas#game') as HTMLCanvasElement
      ).getBoundingClientRect();
      const h = (
        document.querySelector('[data-hud="root"]') as HTMLElement
      ).getBoundingClientRect();
      const overlap =
        Math.max(0, Math.min(c.right, h.right) - Math.max(c.left, h.left)) *
        Math.max(0, Math.min(c.bottom, h.bottom) - Math.max(c.top, h.top));
      return {
        canvasBox: [c.left, c.top, c.width, c.height] as number[],
        hudBox: [h.left, h.top, h.width, h.height] as number[],
        hudOverlapPx2: Math.round(overlap),
        viewport: [window.innerWidth, window.innerHeight] as number[],
      };
    });
    await page.close();

    const size = v.resizeTo
      ? `${v.resizeTo[0]}x${v.resizeTo[1]}`
      : `${v.w}x${v.h}`;
    const aspect = box === null ? 0 : box.rect[2] / box.rect[3];
    results.viewports.push({
      label: `${size}@${v.dpr}${v.resizeTo ? ' (resized)' : ''} ${v.quality}`,
      ...layout,
      board: box,
      boardAspect: +aspect.toFixed(4),
      pass:
        box !== null &&
        Math.max(box.fillW, box.fillH) >= EXPECT.minLimitingFill &&
        Math.abs(aspect - EXPECT.boardAspect) <= EXPECT.boardAspectTol &&
        Math.abs(box.centerOffsetX) <= EXPECT.maxCenterOffsetX &&
        Math.abs(box.centerOffsetY) <=
          EXPECT.maxCenterOffsetYFrac * box.buffer[1] &&
        layout.hudOverlapPx2 <= EXPECT.maxHudOverlapPx2,
    });
  }
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
    viewportExpectations: EXPECT,
    viewports: [],
    shaderWarnings: {},
  };

  // Headed: Playwright's headless Chromium renders through SwiftShader, and a
  // software rasteriser is not the machine anybody plays on.
  const browser = await chromium.launch({ headless: false });
  try {
    for (const quality of QUALITIES) {
      await measure(browser, quality, results, quality === 'high');
    }
    await sweep(browser, results);
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
  console.table(
    results.viewports.map((v) => ({
      viewport: v.label,
      board: v.board === null ? '—' : `${v.board.rect[2]}x${v.board.rect[3]}`,
      limitFill: v.board === null ? 0 : Math.max(v.board.fillW, v.board.fillH),
      aspect: v.boardAspect,
      offX: v.board?.centerOffsetX ?? 0,
      hudOverlap: v.hudOverlapPx2,
      pass: v.pass,
    })),
  );
  const failures = results.viewports.filter((v) => !v.pass);
  if (failures.length > 0) {
    // A non-zero exit so this can never be "green" in a log nobody read.
    console.error(`\n${failures.length} viewport(s) FAILED framing/docking`);
    process.exitCode = 1;
  }
}

void main();
