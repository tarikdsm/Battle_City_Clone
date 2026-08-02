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
// The four passes are **not the same kind of evidence**, and the T9 report's
// verification table keeps them apart:
//
// - **Touch** is emulated: Playwright's `hasTouch` + a mobile device descriptor,
//   on a desktop GPU, with two fingers dispatched through CDP. Enough to prove a
//   layout, a hit target and an event path. Not a phone.
// - **Gamepad** is a fake `navigator.getGamepads` injected before boot. It tests
//   every line of *ours* between that call and the game — the shared hub, the
//   menu rAF pump, the intent merge, core's pause edge — and nothing whatsoever
//   about whether physical hardware reports button 12 for D-pad up.
// - **The PWA** is real: the service worker, the precache manifest and the base
//   path are the production artifacts of a `--mode pages` build, and
//   `setOffline` after a cleared HTTP cache is a real network cut. What it does
//   not prove is installation on a phone's home screen.
// - **The quality probe** is a real CDP CPU throttle, which is a rate limiter on
//   this machine's cores rather than a phone's thermals and GPU.

import { chromium, devices, type Browser, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  gamepad: Record<string, unknown>;
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
// The gamepad pass
// ---------------------------------------------------------------------------

/**
 * A fake Gamepad API, installed before any app code runs.
 *
 * **Read the category carefully.** `tests/input/gamepad.test.ts` drives the
 * driver with a fake provider and proves the mapping and the latch; this drives
 * the *whole application* — `sharedGamepads`, the rAF pump inside `attachNav`,
 * the screen machine, the merge in `input.ts`, the 60 Hz loop and core's own
 * pause edge — through the same seam a real pad would come in on. That is a
 * strictly stronger claim than the unit tests and a strictly weaker one than a
 * controller: it proves every line of ours between `navigator.getGamepads()` and
 * the game, and nothing at all about whether a physical pad reports button 12
 * for D-pad up.
 *
 * Injected as a source STRING rather than a function: `tsx` compiles this file
 * with esbuild's `keepNames`, and a named function serialized into the page dies
 * on the missing `__name` helper.
 */
const FAKE_PAD = `
  window.__bcPad = {
    connected: false,
    buttons: new Array(17).fill(false),
    axes: [0, 0, 0, 0],
  };
  navigator.getGamepads = function () {
    var s = window.__bcPad;
    if (!s.connected) { return []; }
    return [{
      index: 0,
      id: 'fake standard pad (capture harness)',
      connected: true,
      mapping: 'standard',
      axes: s.axes.slice(),
      buttons: s.buttons.map(function (p) {
        return { pressed: p, touched: p, value: p ? 1 : 0 };
      }),
    }];
  };
`;

/** Hold `button` for `ms`, then release — a press the pump can see. */
async function padPress(page: Page, button: number, ms = 120): Promise<void> {
  await page.evaluate((b: number) => {
    const s = (window as unknown as { __bcPad: { buttons: boolean[] } })
      .__bcPad;
    s.buttons[b] = true;
  }, button);
  await sleep(ms);
  await page.evaluate((b: number) => {
    const s = (window as unknown as { __bcPad: { buttons: boolean[] } })
      .__bcPad;
    s.buttons[b] = false;
  }, button);
  await sleep(200);
}

async function walkGamepad(browser: Browser, results: Results): Promise<void> {
  const page = await newPage(browser, results, {
    viewport: { width: 1280, height: 800 },
  });
  await page.addInitScript({ content: FAKE_PAD });
  await page.addInitScript({ content: 'localStorage.clear();' });
  await page.goto(`${BASE}?quality=low&seed=${SEED}`);
  await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });
  await sleep(1200);

  const log: Record<string, unknown> = {};

  // Hot-plug, mid-session, on the title screen — the pad was not there when the
  // page loaded, which is the case `gamepadconnected` exists for and this
  // driver deliberately does not use.
  await page.evaluate(() => {
    (
      window as unknown as { __bcPad: { connected: boolean } }
    ).__bcPad.connected = true;
  });
  await sleep(400);

  // A (button 0) starts the game: GDD §5's "press any key" reaches a pad.
  await padPress(page, BUTTON_FIRE);
  await page.locator('[data-screen="menu"]').waitFor({ timeout: 15_000 });
  log.titleStartedByPadButton = true;
  await shot(page, 'pad-1-menu-reached-by-pad');

  const focusedId = async (): Promise<string> =>
    await page.evaluate(
      () =>
        document
          .querySelector('.bc-row.is-focused')
          ?.getAttribute('data-item') ?? '(none)',
    );
  const first = await focusedId();
  // D-pad down moves the cursor, once per press — not once per frame.
  await padPress(page, BUTTON_DPAD_DOWN);
  const second = await focusedId();
  await padPress(page, BUTTON_DPAD_UP);
  const third = await focusedId();
  log.menuCursor = { first, afterDown: second, afterUp: third };
  await shot(page, 'pad-2-menu-cursor-moved');

  // B goes back to the title, which is `attachNav`'s `back`.
  await padPress(page, BUTTON_B);
  await page.locator('[data-screen="title"]').waitFor({ timeout: 15_000 });
  log.backReturnedToTitle = true;

  // …and into a stage, to prove the pad reaches the SIMULATION and not just the
  // menus. Start (button 9) is GDD §7's pause, and pause is the one input whose
  // effect is unambiguous from the outside: it goes through core's own press
  // edge (`stepGame`), so an overlay appearing means sample → poll → merge →
  // stepGame all ran on pad input.
  await padPress(page, BUTTON_FIRE); // title → menu
  await page.locator('[data-screen="menu"]').waitFor({ timeout: 15_000 });
  await padPress(page, BUTTON_FIRE); // Campaign
  await page
    .locator('[data-screen="stageSelect"]')
    .waitFor({ timeout: 15_000 });
  await padPress(page, BUTTON_FIRE); // stage 1
  await page.locator('[data-hud="root"]').waitFor({ timeout: 60_000 });
  await sleep(INTRO_MS + 900);
  await shot(page, 'pad-3-playing');

  await padPress(page, BUTTON_START);
  const paused = await page
    .locator('[data-screen="pause"]')
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  log.startPausedTheSimulation = paused;
  await shot(page, 'pad-4-paused-by-start');
  if (paused) {
    await padPress(page, BUTTON_FIRE); // confirm Resume
    await sleep(500);
  }

  // The left STICK, past the dead zone, driving the tank. The board is the only
  // witness, so the assertion is that the picture changed while the stick was
  // held — the same evidence `capture-play` uses for the keyboard.
  const canvas = page.locator('canvas#game');
  const before = await canvas.screenshot();
  await page.evaluate(() => {
    const s = (window as unknown as { __bcPad: { axes: number[] } }).__bcPad;
    s.axes[0] = -1; // full left
  });
  await sleep(900);
  await page.evaluate(() => {
    const s = (window as unknown as { __bcPad: { axes: number[] } }).__bcPad;
    s.axes[0] = 0;
  });
  const after = await canvas.screenshot();
  log.stickMovedTheBoard = Buffer.compare(before, after) !== 0;
  await shot(page, 'pad-5-stick-driven');

  // Unplug: the tank must not keep driving on a direction nobody is holding.
  await page.evaluate(() => {
    (
      window as unknown as { __bcPad: { connected: boolean } }
    ).__bcPad.connected = false;
  });
  await sleep(500);
  log.survivedUnplug = await page.evaluate(
    () => document.querySelector('[data-hud="root"]') !== null,
  );

  results.gamepad = {
    note:
      'A fake Gamepad API injected into the REAL app before boot. Proves every ' +
      'line between navigator.getGamepads() and the game — the shared hub, the ' +
      'menu rAF pump, the intent merge, core’s pause edge. Proves nothing ' +
      'about physical hardware.',
    ...log,
  };
  console.log(`  menu cursor: ${JSON.stringify(log.menuCursor)}`);
  console.log(`  start paused the simulation: ${String(paused)}`);
  console.log(`  stick moved the board: ${String(log.stickMovedTheBoard)}`);
  await page.close();
}

/** Standard-mapping indices, repeated here so the harness asserts them too. */
const BUTTON_FIRE = 0;
const BUTTON_B = 1;
const BUTTON_START = 9;
const BUTTON_DPAD_UP = 12;
const BUTTON_DPAD_DOWN = 13;

// ---------------------------------------------------------------------------
// The PWA pass
// ---------------------------------------------------------------------------

/**
 * Install, go offline, reload, and check the game still runs — against the
 * **`--mode pages` build**, which is the only build whose base path is the one
 * that ships.
 *
 * Three things are proved here and each has its own evidence:
 *
 * 1. **The service worker really serves the shell.** The browser's HTTP cache is
 *    cleared through CDP *before* the network is cut, so a page that still loads
 *    cannot have come from anywhere else — and the navigation timing entry is
 *    read back for `workerStart > 0` and `transferSize === 0`, which is the
 *    browser's own statement that a service worker answered it.
 * 2. **The base path is respected everywhere.** Every URL the page requests is
 *    collected and checked against the base, and the registration scope, the
 *    manifest `start_url`/`scope` and the precache keys are recorded verbatim.
 * 3. **It looks right installed.** `display-mode: standalone` is emulated
 *    through CDP, which is what an installed app's CSS sees.
 */
async function walkPwa(browser: Browser, results: Results): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const requested: string[] = [];
  page.on('request', (r) => {
    requested.push(r.url());
  });
  page.on('pageerror', (e) => {
    results.consoleErrors.push(`pwa pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push(`pwa: ${msg.text()}`);
    }
  });

  await page.goto(PWA_BASE);
  await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });

  // The worker has to be ACTIVE, not merely registered: `serviceWorker.ready`
  // resolves on activation, which is when the precache is written.
  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return {
      scope: reg.scope,
      scriptUrl: reg.active?.scriptURL ?? '(none)',
      controlled: navigator.serviceWorker.controller !== null,
    };
  });

  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="manifest"]',
    );
    if (link === null) {
      return { href: '(none)', body: null };
    }
    const res = await fetch(link.href);
    return { href: link.href, body: (await res.json()) as unknown };
  });

  // What the precache actually holds, read from Cache Storage rather than from
  // the build log — the build says what it *meant* to write.
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const out: Record<string, string[]> = {};
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      out[name] = keys.map((r) => new URL(r.url).pathname).sort();
    }
    return out;
  });

  await shot(page, 'pwa-1-online-title');

  // --- offline ------------------------------------------------------------
  const client = await context.newCDPSession(page);
  // Without this the reload could legitimately come out of the HTTP cache and
  // prove nothing at all about the service worker.
  await client.send('Network.clearBrowserCache');
  await context.setOffline(true);
  requested.length = 0;

  await page.reload({ waitUntil: 'load' });
  await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });
  await sleep(1500);
  await shot(page, 'pwa-2-offline-reload');

  const offline = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const fonts = (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    )
      .filter((r) => r.name.endsWith('.woff2'))
      .map((r) => ({
        name: new URL(r.name).pathname,
        // `workerStart > 0` is the browser's own statement that a service
        // worker answered this request; `transferSize === 0` says no byte of it
        // crossed the network.
        workerStart: Math.round(r.workerStart),
        transferSize: r.transferSize,
      }));
    return {
      online: navigator.onLine,
      controlled: navigator.serviceWorker.controller !== null,
      navigationWorkerStart:
        nav === undefined ? -1 : Math.round(nav.workerStart),
      navigationTransferSize: nav?.transferSize ?? -1,
      fonts,
      canvas: document.querySelector('canvas#game') !== null,
      titleShown: document.querySelector('[data-screen="title"]') !== null,
    };
  });

  // …and it is not just a shell: the game runs. Walked by tap, offline, in a
  // production bundle where the `?stage=` shortcut does not exist.
  await page.locator('[data-screen="title"]').tap();
  await page.locator('[data-screen="menu"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-item="campaign"]').tap();
  await page.locator('[data-stage="1"]').first().tap();
  await page.locator('[data-hud="root"]').waitFor({ timeout: 60_000 });
  await sleep(INTRO_MS + 1200);
  await shot(page, 'pwa-3-offline-playing');
  await measure(page, 'pwa-offline-portrait', 'offline pages build', results);

  // --- a first, cheap attempt at the installed context ---------------------
  // Recorded even though it does not work, because "we tried and it does not"
  // is the honest thing for the report to say. `Emulation.setEmulatedMedia`
  // takes arbitrary media FEATURES, but `display-mode` is not one Chromium
  // lets you override — it is derived from how the window was opened.
  await client
    .send('Emulation.setEmulatedMedia', {
      features: [{ name: 'display-mode', value: 'standalone' }],
    })
    .catch(() => undefined);
  const standaloneByEmulation = await page.evaluate(
    () => window.matchMedia('(display-mode: standalone)').matches,
  );
  await sleep(600);
  await shot(page, 'pwa-4-offline-portrait');

  await context.setOffline(false);
  await client.detach();

  const offBase = requested.filter(
    (u) => u.startsWith('http') && !u.includes(new URL(PWA_BASE).pathname),
  );

  results.pwa = {
    note:
      'Real production artifacts from `vite build --mode pages`, served by ' +
      '`vite preview --mode pages`. The HTTP cache was cleared through CDP ' +
      'before the network was cut, so an offline load can only have come from ' +
      'the service worker. NOT verified: installation on a real phone home ' +
      'screen, or any iOS behaviour.',
    baseUrl: PWA_BASE,
    registration,
    manifestHref: manifest.href,
    manifest: manifest.body,
    caches: cached,
    offline,
    standaloneMediaMatches: standaloneByEmulation,
    requestsOutsideBasePath: offBase,
  };

  console.log(`  sw scope: ${registration.scope}`);
  console.log(`  offline reload: controlled=${String(offline.controlled)}`);
  console.log(
    `  navigation workerStart=${offline.navigationWorkerStart} transferSize=${offline.navigationTransferSize}`,
  );
  console.log(`  requests outside base path: ${offBase.length}`);
  await page.close();
  await context.close();
}

/**
 * The **installed** context, for real.
 *
 * `display-mode: standalone` cannot be emulated (see above): Chromium derives it
 * from how the window was opened, so the only way to see what an installed app
 * sees is to open one. `--app=<url>` is exactly that window — no tab strip, no
 * omnibox, `display-mode: standalone` matching — and it is the same window an
 * installed PWA is launched into. It needs its own browser process, hence a
 * separate launch rather than a context on the shared one.
 *
 * Still short of the real thing in one way the report states: this is a desktop
 * app window, not a phone's home-screen launch.
 */
async function walkStandalone(results: Results): Promise<void> {
  const profile = join(tmpdir(), `bc-t9-standalone-${String(Date.now())}`);
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--app=${PWA_BASE}`],
    viewport: { width: 480, height: 900 },
  });
  try {
    // The app window IS the first page; `newPage()` here would open a tab in a
    // window that has no tab strip.
    const page = context.pages()[0] ?? (await context.newPage());
    await page.waitForLoadState('load');
    await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });
    await sleep(1500);

    const modes = await page.evaluate(() => ({
      standalone: window.matchMedia('(display-mode: standalone)').matches,
      browser: window.matchMedia('(display-mode: browser)').matches,
      url: location.href,
      controlled: navigator.serviceWorker.controller !== null,
    }));
    results.pwa = {
      ...(results.pwa as Record<string, unknown>),
      standaloneWindow: modes,
    };
    console.log(
      `  app window: display-mode standalone=${String(modes.standalone)}`,
    );
    await shot(page, 'pwa-5-standalone-window');

    // …and offline in the installed window too, which is the state a player who
    // installed it and then lost signal is actually in.
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-screen="title"]').waitFor({ timeout: 60_000 });
    await sleep(1200);
    await shot(page, 'pwa-6-standalone-offline');
    await context.setOffline(false);
  } finally {
    await context.close();
    // Created by this run, removed by this run.
    rmSync(profile, { recursive: true, force: true });
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
    gamepad: {},
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
    console.log('gamepad (fake API in the real app)…');
    await walkGamepad(browser, results);
    console.log('quality probe…');
    await walkQualityProbe(browser, results);
    console.log('pwa…');
    await walkPwa(browser, results);
    console.log('standalone window…');
    await walkStandalone(results);
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
        gamepad: results.gamepad,
        pwa: results.pwa,
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
