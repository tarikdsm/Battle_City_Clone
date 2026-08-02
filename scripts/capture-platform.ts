// scripts/capture-platform.ts — Phase 9's visual verification: touch controls,
// responsive layouts, and the installable offline PWA.
//
//   npm run dev                                  # for the touch pass
//   npm run build -- --mode pages && npm run preview   # for the PWA pass
//   npm run capture:platform
//
// Outputs:
//   · `.superpowers/sdd/screens-T9/` — the screenshots (git-ignored, like every
//     other capture directory here; the SCRIPT is what is committed, so anybody
//     can regenerate them).
//   · `docs/calibration/touch-layout.json` — **committed**. The claim "the
//     controls do not occlude the playfield" is a measurement, and a measurement
//     without an artifact is an opinion. The file holds the three boxes and the
//     three pairwise overlaps at every viewport walked.
//
// ## What this script can and cannot prove — read before quoting it
//
// It drives **emulated** touch (Playwright's `hasTouch` + a mobile device
// descriptor) on a desktop GPU. That is enough to prove a layout, a hit target
// and an event path; it is *not* a phone, and nothing here should be reported as
// one. The T9 report's verification table states this per feature. There is no
// gamepad pass at all for the same reason — a fake `navigator.getGamepads` would
// test the fake.
//
// The PWA pass is different in kind: the service worker, the precache manifest
// and the base path are the *real* production artifacts, and `context.setOffline`
// is a real network cut. What it does not prove is installation on a phone's
// home screen.

import { chromium, devices, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
/** The `--mode pages` preview build. Note the base path — it is the point. */
const PWA_BASE =
  process.env.CAPTURE_PWA_URL ?? 'http://localhost:4173/Battle_City_Clone/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T9');
const ARTIFACT = join('docs', 'calibration', 'touch-layout.json');

/** Fixed so the AI, the spawn cycle and the power-up rolls repeat run to run. */
const SEED = 20260802;
/** Fidelity §11.1: a 2 s "STAGE N" curtain before the controls come alive. */
const INTRO_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let shotIndex = 0;
const shots: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  // Art §10's panels fade/slide in over 150 ms, and a locator resolves the
  // instant the node exists — so a shot taken straight after a transition
  // photographs a half-transparent panel. Settle first, always.
  await sleep(400);
  const file = `${String(shotIndex).padStart(2, '0')}-${name}.png`;
  shotIndex++;
  await page.screenshot({ path: join(OUT, file) });
  shots.push(file);
  console.log(`  → ${file}`);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutSample {
  viewport: Box;
  orientation: 'portrait' | 'landscape';
  device: string;
  canvas: Box;
  hud: Box;
  touch: Box | null;
  /** px² of intersection. All three must be 0. */
  overlapCanvasTouch: number;
  overlapCanvasHud: number;
  overlapHudTouch: number;
  /** The three controls' hit boxes — a control smaller than a thumb is a bug. */
  controls: Record<string, Box | null>;
  /** Fraction of the viewport the board still gets. */
  boardAreaFraction: number;
}

interface Results {
  capturedAt: string;
  url: string;
  pwaUrl: string;
  screenshots: string[];
  consoleErrors: string[];
  /** Every viewport walked, keyed by label. */
  layouts: Record<string, LayoutSample>;
  /** What `isTouchDevice` decided, per emulated profile. */
  touchGate: Record<string, boolean>;
  /** The auto-quality probe's pick under a throttled mobile profile. */
  mobileQuality: Record<string, unknown>;
  pwa: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Measurement, taken in the page
// ---------------------------------------------------------------------------

/**
 * Everything measured, straight off the LIVE elements.
 *
 * Live boxes, not the constants the layout was supposed to use: a zone height
 * computed correctly and then applied to the wrong element still measures as an
 * overlap here, which is the whole value of the artifact.
 */
const SELECTORS = [
  ['canvas', 'canvas#game'],
  ['hud', '[data-hud="root"]'],
  ['touch', '[data-touch="root"]'],
  ['stick', '[data-touch="stick"]'],
  ['fire', '[data-touch="fire"]'],
  ['pause', '[data-touch="pause"]'],
] as const;

type BoxKey = (typeof SELECTORS)[number][0];

/**
 * Rectangle intersection in px².
 *
 * Computed HERE rather than in the page, deliberately: `tsx` compiles this file
 * with esbuild's `keepNames`, which rewrites every named function into one that
 * calls a `__name` helper — and that helper does not exist inside the browser,
 * so a named function handed to `page.evaluate` dies with `__name is not
 * defined`. The page therefore only reads rects (an anonymous arrow with no
 * inner declarations); every derived number is Node's.
 */
function overlap(a: Box | null, b: Box | null): number {
  if (a === null || b === null) {
    return 0;
  }
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return Math.round(w * h);
}

const ZERO: Box = { x: 0, y: 0, w: 0, h: 0 };

async function measure(
  page: Page,
  label: string,
  device: string,
  results: Results,
): Promise<LayoutSample> {
  const raw = await page.evaluate(
    (selectors: readonly (readonly string[])[]) => {
      const out: Record<string, Box | null> = {};
      for (const pair of selectors) {
        const el = document.querySelector(pair[1]);
        if (el === null) {
          out[pair[0]] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        out[pair[0]] = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
      return {
        boxes: out,
        viewport: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
      };
    },
    SELECTORS as readonly (readonly string[])[],
  );

  const at = (key: BoxKey): Box | null => raw.boxes[key] ?? null;
  const canvas = at('canvas');
  const hud = at('hud');
  const touch = at('touch');
  const sample: LayoutSample = {
    viewport: raw.viewport,
    device,
    orientation: raw.viewport.w >= raw.viewport.h ? 'landscape' : 'portrait',
    canvas: canvas ?? ZERO,
    hud: hud ?? ZERO,
    touch,
    overlapCanvasTouch: overlap(canvas, touch),
    overlapCanvasHud: overlap(canvas, hud),
    overlapHudTouch: overlap(hud, touch),
    controls: {
      stick: at('stick'),
      fire: at('fire'),
      pause: at('pause'),
    },
    boardAreaFraction:
      canvas === null
        ? 0
        : +((canvas.w * canvas.h) / (raw.viewport.w * raw.viewport.h)).toFixed(
            3,
          ),
  };
  results.layouts[label] = sample;
  console.log(
    `  ${label}: canvas ${sample.canvas.w}x${sample.canvas.h}` +
      ` · touch ${sample.touch === null ? '(none)' : `${sample.touch.w}x${sample.touch.h}`}` +
      ` · overlaps ${sample.overlapCanvasTouch}/${sample.overlapCanvasHud}/${sample.overlapHudTouch} px²`,
  );
  return sample;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async function newPage(
  browser: Browser,
  results: Results,
  options: Parameters<Browser['newContext']>[0],
): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on('pageerror', (e) => {
    results.consoleErrors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push(msg.text());
    }
  });
  return page;
}

// ---------------------------------------------------------------------------
// The touch pass
// ---------------------------------------------------------------------------

/**
 * The emulated profiles.
 *
 * Two mobile ones in both orientations, plus a desktop control — the control is
 * not decoration, it is the proof that the gate in `isTouchDevice` really gates:
 * a build that always mounted the controls would look identical in every mobile
 * shot and only this row would catch it.
 */
const PROFILES = [
  {
    label: 'pixel5-portrait',
    device: 'Pixel 5',
    options: { ...devices['Pixel 5'] },
  },
  {
    label: 'pixel5-landscape',
    device: 'Pixel 5 landscape',
    options: { ...devices['Pixel 5 landscape'] },
  },
  {
    label: 'iphone13-portrait',
    device: 'iPhone 13',
    // Chromium with iPhone metrics: the LAYOUT is the thing under test, and
    // WebKit is out of scope for this project's browser matrix (arch §13).
    options: { ...devices['iPhone 13'], isMobile: true, hasTouch: true },
  },
  {
    label: 'desktop-control',
    device: 'Desktop Chrome (no touch)',
    options: { viewport: { width: 1280, height: 800 }, hasTouch: false },
  },
] as const;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Two thumbs at once: a drag on the stick while fire is held.
 *
 * Through CDP rather than through Playwright's mouse or `dispatchEvent`,
 * because both of those are one pointer and the thing being verified is
 * genuinely two. `Input.dispatchTouchEvent` produces the browser's *own* touch
 * stream, so the page sees real `pointerdown`/`pointermove` with live pointer
 * ids — which is also what makes `setPointerCapture` legal, and a synthetic
 * event is exactly what it is not.
 */
async function twoFingers(page: Page, stick: Rect, fire: Rect): Promise<void> {
  const client = await page.context().newCDPSession(page);
  const sx = stick.x + stick.width / 2;
  const sy = stick.y + stick.height / 2;
  const fx = fire.x + fire.width / 2;
  const fy = fire.y + fire.height / 2;
  const thumb = { x: sx, y: sy, id: 1, radiusX: 12, radiusY: 12, force: 1 };
  const trigger = { x: fx, y: fy, id: 2, radiusX: 12, radiusY: 12, force: 1 };

  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [thumb],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [thumb, trigger],
  });
  // Push the stick right, in steps, so the knob follows a real gesture.
  for (let i = 1; i <= 5; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { ...thumb, x: sx + (stick.width * 0.36 * i) / 5 },
        trigger,
      ],
    });
    await sleep(40);
  }
  await client.detach();
}

async function walkTouch(browser: Browser, results: Results): Promise<void> {
  for (const profile of PROFILES) {
    const page = await newPage(browser, results, {
      ...profile.options,
      deviceScaleFactor: 1,
    });
    await page.addInitScript(() => {
      globalThis.localStorage?.clear();
    });
    // `?stage=` is the dev-only flag that boots straight onto the board
    // (`main.ts`); the flow itself is walked by taps in `walkTouchFlow`.
    await page.goto(`${BASE}?quality=low&seed=${SEED}&stage=3`);
    await page.locator('[data-hud="root"]').waitFor({ timeout: 60_000 });
    await sleep(INTRO_MS + 800);

    results.touchGate[profile.label] = await page.evaluate(
      () => document.querySelector('[data-touch="root"]') !== null,
    );
    // Measured BEFORE anything is touched: the layout claim is about the
    // resting state, and a measurement taken after an interaction that went
    // wrong is a measurement of the wrong page (learned the hard way — a
    // synthetic `pointerdown` threw inside `setPointerCapture`, the global
    // error rail replaced the play screen, and the boxes that came back were
    // the error screen's).
    await measure(page, profile.label, profile.device, results);

    // Now drive the controls, with two real fingers. A shot of an untouched
    // overlay proves it renders, not that it works. (The desktop control has no
    // controls to drive, which is the point of it — `boundingBox()` on a
    // locator that will never resolve would hang for the full timeout.)
    const stick = results.touchGate[profile.label]
      ? await page.locator('[data-touch="stick"]').boundingBox()
      : null;
    const fire = results.touchGate[profile.label]
      ? await page.locator('[data-touch="fire"]').boundingBox()
      : null;
    if (stick !== null && fire !== null) {
      await twoFingers(page, stick, fire);
      await sleep(450);
    }

    await shot(page, `touch-${profile.label}`);
    await page.close();
  }
}

/**
 * The whole flow, walked with taps alone.
 *
 * This is the half a layout screenshot cannot show: GDD §7's touch column says
 * "menu navigate: tap", and the menus were built with a pointer path from the
 * start (`mountMenu`'s `onPick`) — so the question is whether a real touch
 * session can get from the title to a running stage without a keyboard.
 */
async function walkTouchFlow(
  browser: Browser,
  results: Results,
): Promise<void> {
  const page = await newPage(browser, results, {
    ...devices['Pixel 5'],
    deviceScaleFactor: 1,
  });
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  await page.goto(`${BASE}?quality=low&seed=${SEED}`);

  await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });
  await sleep(1200);
  await shot(page, 'touch-flow-1-title');

  // "Press any key **or tap**" (GDD §5) — the title takes the whole viewport.
  await page.locator('[data-screen="title"]').tap();
  await page.locator('[data-screen="menu"]').waitFor({ timeout: 30_000 });
  await shot(page, 'touch-flow-2-menu');

  await page.locator('[data-item="campaign"]').tap();
  await page.locator('[data-screen="stageSelect"]').waitFor();
  await shot(page, 'touch-flow-3-stage-select');

  await page.locator('[data-stage="1"]').first().tap();
  await page.locator('[data-hud="root"]').waitFor({ timeout: 60_000 });
  await sleep(INTRO_MS + 900);
  await shot(page, 'touch-flow-4-playing');
  await measure(
    page,
    'flow-pixel5-portrait',
    'Pixel 5 (walked by tap)',
    results,
  );

  // The pause icon, GDD §7's touch row for pause.
  await page.locator('[data-touch="pause"]').tap();
  await page.locator('[data-screen="pause"]').waitFor({ timeout: 10_000 });
  await shot(page, 'touch-flow-5-paused-by-icon');
  await page.locator('[data-item="resume"]').tap();
  await sleep(600);

  await page.close();
}

/**
 * The auto-quality probe under a throttled mobile profile (the T9 brief's
 * "known trap": a weak phone receiving the High preset is the G4 failure).
 *
 * CPU throttling is a real CDP rate limiter, not a simulation of one — the same
 * `Emulation.setCPUThrottlingRate` devtools' own mobile preset uses. The probe
 * samples a **drawing** frame at High (main.ts's `PROBE_QUALITY`), so the number
 * it reads is what that device actually achieves under the heaviest chain.
 */
async function walkQualityProbe(
  browser: Browser,
  results: Results,
): Promise<void> {
  const profiles = [
    { label: 'pixel5-cpu1x', rate: 1, device: devices['Pixel 5'] },
    { label: 'pixel5-cpu4x', rate: 4, device: devices['Pixel 5'] },
    { label: 'pixel5-cpu6x', rate: 6, device: devices['Pixel 5'] },
    // The control. Without it "the probe picks Low" is ambiguous between "this
    // emulated phone is weak" and "the probe measures the wrong second".
    {
      label: 'desktop-cpu1x',
      rate: 1,
      device: { viewport: { width: 1280, height: 800 } },
    },
  ] as const;

  for (const profile of profiles) {
    const rate = profile.rate;
    const page = await newPage(browser, results, {
      ...profile.device,
      deviceScaleFactor: 1,
    });
    const picks: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().startsWith('auto quality')) {
        picks.push(msg.text());
      }
    });
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate });
    await page.addInitScript(() => {
      globalThis.localStorage?.clear();
    });
    // The window has to be VISIBLE or the answer is meaningless: a backgrounded
    // window stops servicing `requestAnimationFrame` entirely, so the probe
    // reads 0 fps and picks Low for a reason that has nothing to do with the
    // device. (Measured — the first run of this walk reported `fps: 0` at 1x
    // throttling on a machine that holds 60.)
    await page.bringToFront();
    // No `?quality=`: the probe only runs when the setting is Auto, which is
    // the shipped default.
    await page.goto(`${BASE}?seed=${SEED}&stage=1`);
    await page.locator('[data-hud="root"]').waitFor({ timeout: 90_000 });
    // The probe samples for 1 s over the first second of play, then logs.
    await sleep(6000);

    // …and the same measurement again, once the page has warmed up. This is the
    // number the probe *meant* to take: `sampleDevice` starts the moment the
    // module finishes evaluating, which is while the renderer is still
    // compiling its shaders on the first draws. Reporting both is what turns
    // "it picks Low" into a diagnosis instead of an observation.
    // No named inner functions — see `overlap`'s note on esbuild's `__name`.
    const steady = await page.evaluate(async () => {
      const t0 = performance.now();
      let frames = 0;
      while (performance.now() - t0 < 1000) {
        await new Promise((r) => requestAnimationFrame(r));
        frames++;
      }
      const elapsed = performance.now() - t0;
      return +((frames * 1000) / elapsed).toFixed(1);
    });

    results.mobileQuality[profile.label] = {
      cpuThrottleRate: rate,
      bootProbe: picks[0] ?? '(no auto-quality line — did the probe run?)',
      steadyStateFps: steady,
    };
    console.log(
      `  ${profile.label} → ${picks[0] ?? '(none)'} · steady ${steady} fps`,
    );
    if (rate === 6) {
      await shot(page, 'mobile-throttled-6x');
    }
    await client.detach();
    await page.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: BASE,
    pwaUrl: PWA_BASE,
    screenshots: shots,
    consoleErrors: [],
    layouts: {},
    touchGate: {},
    mobileQuality: {},
    pwa: {},
  };

  // Headed, like `capture-play` and `capture-ui`: headless Chromium renders
  // through SwiftShader, and a screenshot of a software rasteriser is not what
  // anybody sees — nor is its frame rate what the quality probe would measure.
  const browser = await chromium.launch({ headless: false });
  try {
    console.log('touch layouts…');
    await walkTouch(browser, results);
    console.log('touch flow…');
    await walkTouchFlow(browser, results);
    console.log('quality probe…');
    await walkQualityProbe(browser, results);
  } finally {
    await browser.close();
  }

  writeFileSync(
    ARTIFACT,
    `${JSON.stringify(
      {
        capturedAt: results.capturedAt,
        note:
          'Emulated touch (Playwright device descriptors) on a desktop GPU — ' +
          'NOT a phone. Boxes are live getBoundingClientRect values; the three ' +
          'overlap fields are rectangle intersections in px² and must all be 0.',
        layouts: results.layouts,
        touchGate: results.touchGate,
        mobileQuality: results.mobileQuality,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(OUT, 'results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  console.log(`\nscreenshots → ${OUT} (${shots.length})`);
  console.log(`layout measurement → ${ARTIFACT}`);
  console.table(results.touchGate);

  let failed = false;
  for (const [label, sample] of Object.entries(results.layouts)) {
    const worst = Math.max(
      sample.overlapCanvasTouch,
      sample.overlapCanvasHud,
      sample.overlapHudTouch,
    );
    if (worst > 0) {
      console.error(`overlap in ${label}: ${worst} px²`);
      failed = true;
    }
  }
  // The gate, both ways: mobile profiles must have the controls and the desktop
  // control must not.
  for (const [label, shown] of Object.entries(results.touchGate)) {
    const expected = !label.startsWith('desktop');
    if (shown !== expected) {
      console.error(
        `touch gate wrong for ${label}: expected ${String(expected)}, got ${String(shown)}`,
      );
      failed = true;
    }
  }
  if (results.consoleErrors.length > 0) {
    console.error('\nconsole errors:', results.consoleErrors);
    failed = true;
  }
  if (failed) {
    process.exitCode = 1;
  }
}

void main();
