// scripts/capture-fx.ts — the visual-verification harness for art §8's VFX
// layer (T4.1 + T4.2): the effect recipes, the scene draw-call budget and the
// real-loop frame cost with particles flying.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:fx
//
// Committed output: `docs/calibration/fx.json`. Screenshots (git-ignored) go to
// `.superpowers/sdd/screens-T4/` unless CAPTURE_OUT says otherwise.
//
// NOT `test-results/`, which Playwright owns and **wipes** at the start of every
// `npx playwright test` (measured, T2.4, after a full capture run vanished).
//
// ## Two halves, because two different questions
//
// **The rig** (like `capture-entities.ts`) owns the field: it builds a real
// `createRenderer` over the dev server, writes tanks directly and pumps
// `GameEvent`s by hand. That is the only way to photograph "a tank explosion at
// its peak" — 90 ms into a 120 ms flash sphere is not a moment you can catch by
// playing. Because `fx/recipes.ts` seeds its randomness from the event itself,
// every one of these frames is reproducible run to run.
//
// **The real page** (like `capture-play.ts`) answers the budget question: the
// actual `main.ts`, the actual loop, keys being pressed, at each preset. Arch
// §11's "Render CPU ≤ 6 ms @High" and art §8's "≤ 60 scene draw calls" are
// claims about *that*, not about a rig, so they are measured there and compared
// against the pre-FX numbers already committed in `docs/calibration/play.json`.
//
// The browser is launched **headed** on purpose: Playwright's headless Chromium
// renders through SwiftShader, and a software rasteriser is not the machine
// anybody plays on.

import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T4');
const ARTIFACT = join('docs', 'calibration', 'fx.json');
/** The pre-FX numbers this task has to be held against. */
const BASELINE = join('docs', 'calibration', 'play.json');

const W = 1600;
const H = 900;
/** Same seed as `capture-play.ts`, so the two runs are the same skirmish. */
const SEED = 20260802;
/** Fidelity §11.1: a 2 s "STAGE N" curtain before the controls come alive. */
const INTRO_MS = 2000;

type Quality = 'low' | 'medium' | 'high';
const QUALITIES: readonly Quality[] = ['high', 'medium', 'low'];

/**
 * Art §8's ruling of 2026-08-02: the entity-material quota is retired and the
 * budget is **total scene draw calls ≤ 60 at High in the play loop**, asserted
 * from a committed artifact. Arch §11's frame budget rides alongside it.
 */
const BUDGET = { sceneDrawCalls: 60, renderCpuMs: 6 };

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

interface FrameCost {
  calls: number;
  ms: number;
  particles: number;
  lights: number;
  activeKinds: number;
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
  viewport: { w: number; h: number };
  gpu: { vendor: string; renderer: string; headless: boolean };
  budget: typeof BUDGET;
  /**
   * The rig's own before/after on one identical board: an idle frame (every FX
   * mesh at `count === 0`, so it draws nothing) against the busiest frame the
   * recipes can produce. The delta IS the FX layer's draw-call cost.
   */
  rig: Record<string, { idle: FrameCost; busy: FrameCost; delta: number }>;
  /** Real loop, this build. Directly comparable to `baseline` below. */
  loop: Record<string, LoopStats>;
  /** Real loop, the pre-FX build, read from `docs/calibration/play.json`. */
  baseline: Record<string, LoopStats> | null;
  baselineCapturedAt: string | null;
  /** Every console error and warning seen, per preset. Errors must stay empty. */
  console: Record<string, { errors: string[]; warnings: string[] }>;
  /**
   * Pass/fail against `budget`, so the artifact carries its own verdict.
   *
   * `drawCallsPass` is keyed on the **play loop**, which is what art §8's
   * ruling actually says ("total scene draw calls ≤ 60 at High *in the play
   * loop*"). `rigBusyCalls` is reported beside it and deliberately NOT part of
   * the verdict: the rig board carries every terrain type at once — water pits,
   * ice, trees, brick and steel — plus seven tanks of six different types, a
   * spawning star, a tier-3 tip, two bullets, the props and a power-up, which
   * is heavier than any stage this game ships. It is the stress number, and its
   * *delta* is the honest measure of what the FX layer costs.
   */
  verdict: {
    highLoopDrawCallsMax: number;
    highLoopMeanMs: number;
    highLoopP95Ms: number;
    rigBusyCalls: number;
    rigFxDelta: number;
    drawCallsPass: boolean;
    frameTimePass: boolean;
    consolePass: boolean;
  };
}

// ---------------------------------------------------------------------------
// Page-side: the rig
// ---------------------------------------------------------------------------

/**
 * esbuild's `keepNames` rewrites every named function as `__name(fn, "name")`
 * and defines `__name` once per MODULE; Playwright serialises the function body
 * alone, so the helper is missing in the page. Same one-line shim
 * `capture-play.ts` uses, installed before everything else.
 */
const KEEP_NAMES_SHIM = 'globalThis.__name ??= (fn) => fn;';

/** A tank the rig puts on the field. Mirrors `Tank` minus the AI bookkeeping. */
interface TankSpec {
  id?: number;
  kind?: 'player' | 'enemy';
  playerIndex?: 0 | 1;
  enemyType?: 'basic' | 'fast' | 'power' | 'armor';
  ordinal?: number;
  tx: number;
  ty: number;
  dir?: 0 | 1 | 2 | 3;
  moving?: boolean;
  hp?: number;
  tier?: 0 | 1 | 2 | 3;
  spawningT?: number;
}

interface Rig {
  init(quality: string, terrain?: [number, number, string][]): void;
  tank(spec: TankSpec): void;
  bullet(x: number, y: number, dir: number): void;
  powerup(type: string | null, x?: number, y?: number): void;
  eagle(alive: boolean): void;
  event(e: unknown): void;
  render(dt?: number): void;
  advance(ms: number, steps?: number): void;
  cost(): FrameCost;
  overlay(text: string | null): void;
}

async function installRig(): Promise<void> {
  // Held in variables rather than written as literals so tsc treats them as
  // dynamic — a literal would be resolved against the Node program and fail.
  const urls = {
    core: '/src/core/game.ts',
    renderer: '/src/render/renderer.ts',
  };
  const core = await import(urls.core);
  const rend = await import(urls.renderer);

  // Instrumentation on the prototype, so nothing is added to production code.
  // The count is definitionally `renderer.info.render.calls` — three increments
  // `WebGLInfo` from these same entry points.
  let calls = 0;
  const gl2 = WebGL2RenderingContext.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  for (const k of [
    'drawElements',
    'drawArrays',
    'drawElementsInstanced',
    'drawArraysInstanced',
  ]) {
    const orig = gl2[k];
    gl2[k] = function (this: unknown, ...a: unknown[]): unknown {
      calls++;
      return orig.apply(this, a);
    };
  }

  const rows = (spec: [number, number, string][]): string[] => {
    const g = Array.from({ length: 13 }, () => '.............'.split(''));
    for (const [tx, ty, ch] of spec) g[ty][tx] = ch;
    return g.map((r) => r.join(''));
  };

  let lastCalls = 0;
  let lastMs = 0;
  let panel: HTMLElement | null = null;

  const H = {
    renderer: undefined as unknown,
    canvas: undefined as unknown as HTMLCanvasElement,
    state: undefined as unknown,
    nextId: 10,

    init(quality: string, terrain?: [number, number, string][]): void {
      document.querySelectorAll('canvas.rig').forEach((c) => {
        c.remove();
      });
      if (H.renderer) (H.renderer as { dispose(): void }).dispose();
      const canvas = document.createElement('canvas');
      canvas.className = 'rig';
      canvas.style.cssText =
        `position:fixed;left:0;top:0;` +
        `width:${innerWidth}px;height:${innerHeight}px;z-index:99;`;
      document.body.append(canvas);
      H.canvas = canvas;
      const r = rend.createRenderer(canvas, quality);
      r.resize(innerWidth, innerHeight);
      H.renderer = r;
      H.state = core.createGame(
        {
          version: 1,
          id: 'fx',
          name: 'fx',
          terrain: rows(terrain ?? []),
          enemies: Array.from({ length: 20 }, () => 'basic'),
          noAutoBase: true,
        },
        { players: 2, seed: 1, stageNumber: 1 },
      );
      // The rig owns the field: the simulation is never stepped, so nothing
      // moves except what these helpers write.
      for (const t of (H.state as { tanks: { alive: boolean }[] }).tanks) {
        t.alive = false;
      }
      H.nextId = 10;
    },

    tank(o: Record<string, unknown>): void {
      const tx = o.tx as number;
      const ty = o.ty as number;
      (H.state as { tanks: unknown[] }).tanks.push({
        id: (o.id as number | undefined) ?? H.nextId++,
        alive: true,
        kind: o.kind ?? 'enemy',
        playerIndex: o.playerIndex,
        enemyType: o.enemyType,
        spawnOrdinal: o.ordinal ?? 1,
        carrier: false,
        x: tx * 16,
        y: ty * 16,
        prevX: tx * 16,
        prevY: ty * 16,
        dir: o.dir ?? 0,
        moving: o.moving ?? false,
        sliding: false,
        slideV: 0,
        hp: o.hp ?? 1,
        tier: o.tier ?? 0,
        shieldT: 0,
        stunT: 0,
        frozenT: 0,
        spawningT: o.spawningT ?? 0,
        bulletsAirborne: 0,
        fireHeld: false,
        aiTimerT: 0,
        aiTileX: 0,
        aiTileY: 0,
      });
    },

    bullet(x: number, y: number, dir: number): void {
      (H.state as { bullets: unknown[] }).bullets.push({
        id: (H.state as { bullets: unknown[] }).bullets.length,
        alive: true,
        x,
        y,
        prevX: x,
        prevY: y,
        dir,
        speed: 120,
        fromTankId: 0,
        byPlayer: true,
        playerIndex: 0,
        canHurtSteel: false,
      });
    },

    powerup(type: string | null, x = 96, y = 96): void {
      (H.state as { powerup: unknown }).powerup =
        type === null ? null : { type, x, y };
    },

    eagle(alive: boolean): void {
      (H.state as { eagleAlive: boolean }).eagleAlive = alive;
    },

    event(e: unknown): void {
      (H.renderer as { onEvent(e: unknown): void }).onEvent(e);
    },

    render(dt = 0): void {
      const before = calls;
      const t0 = performance.now();
      (H.renderer as { render(s: unknown, a: number, d: number): void }).render(
        H.state,
        1,
        dt,
      );
      lastMs = performance.now() - t0;
      lastCalls = calls - before;
    },

    /** `ms` of animation, in `steps` frames. */
    advance(ms: number, steps = 1): void {
      for (let i = 0; i < steps; i++) H.render(ms / steps);
    },

    cost(): Record<string, number> {
      const fx = (
        H.renderer as {
          fxStats(): {
            particles: number;
            lights: number;
            activeKinds: number;
          };
        }
      ).fxStats();
      return {
        calls: lastCalls,
        ms: Math.round(lastMs * 1000) / 1000,
        particles: fx.particles,
        lights: fx.lights,
        activeKinds: fx.activeKinds,
      };
    },

    /**
     * The measured numbers, drawn ON the frame. Art §8's budget is the point of
     * shots 5 and 6, and a number in a JSON file beside a picture is a weaker
     * claim than the same number printed on the picture.
     */
    overlay(text: string | null): void {
      if (panel === null) {
        panel = document.createElement('div');
        panel.style.cssText =
          'position:fixed;left:16px;top:16px;z-index:100;' +
          'font:600 15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
          'color:#e8f4fb;background:rgba(16,18,27,0.86);' +
          'border:1px solid #262b3d;border-radius:6px;padding:10px 14px;' +
          'white-space:pre;pointer-events:none;';
        document.body.append(panel);
      }
      panel.style.display = text === null ? 'none' : 'block';
      if (text !== null) panel.textContent = text;
    },
  };
  (globalThis as unknown as { H: typeof H }).H = H;
}

// ---------------------------------------------------------------------------
// Page-side: the real loop's frame instrumentation (same shape as capture-play)
// ---------------------------------------------------------------------------

interface FrameSample {
  ms: number;
  calls: number;
}

interface PerfHook {
  start(): void;
  stop(): FrameSample[];
}

function instrument(): void {
  const draws = { n: 0 };
  const g = globalThis as unknown as {
    WebGL2RenderingContext?: { prototype: object };
    requestAnimationFrame: (cb: (t: number) => void) => number;
    __bcfx?: PerfHook;
  };
  if (g.WebGL2RenderingContext) {
    const p = g.WebGL2RenderingContext.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    for (const k of [
      'drawElements',
      'drawArrays',
      'drawElementsInstanced',
      'drawArraysInstanced',
    ]) {
      const orig = p[k];
      if (typeof orig !== 'function') continue;
      p[k] = function (this: unknown, ...a: unknown[]): unknown {
        draws.n++;
        return orig.apply(this, a);
      };
    }
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
      if (draws.n === c0) return;
      if (recording) samples.push({ ms, calls: draws.n - c0 });
    });

  g.__bcfx = {
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
// Rig scenes
// ---------------------------------------------------------------------------

/** Fidelity §2's base brick ring — the rig builds with `noAutoBase`. */
const BASE_NEST: [number, number, string][] = [
  [5, 11, 'B'],
  [6, 11, 'B'],
  [7, 11, 'B'],
  [5, 12, 'B'],
  [7, 12, 'B'],
];

async function costOf(page: Page): Promise<FrameCost> {
  return (await page.evaluate(() =>
    (globalThis as unknown as { H: Rig }).H.cost(),
  )) as unknown as FrameCost;
}

async function shot(page: Page, name: string): Promise<void> {
  // The canvas has no `preserveDrawingBuffer`, so give the compositor a beat to
  // present the frame the rig just drew before Playwright grabs it.
  await sleep(150);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

/** Two rows of brick, so a hit has a wall to come out of. */
const BRICK_WALL: [number, number, string][] = [
  [4, 5, 'B'],
  [5, 5, 'B'],
  [6, 5, 'B'],
  [7, 5, 'B'],
  [8, 5, 'B'],
  [4, 6, 'B'],
  [5, 6, 'B'],
  [6, 6, 'B'],
  [7, 6, 'B'],
  [8, 6, 'B'],
];

/**
 * A board with brick, steel, trees and ice, six tanks and a base — the same
 * scene for the idle measurement and the busy one, so the delta is only FX.
 */
const BUSY_TERRAIN: [number, number, string][] = [
  ...BASE_NEST,
  [2, 3, 'B'],
  [3, 3, 'B'],
  [4, 3, 'B'],
  [2, 4, 'B'],
  [8, 3, 'S'],
  [9, 3, 'S'],
  [8, 4, 'S'],
  [10, 7, 'T'],
  [11, 7, 'T'],
  [2, 8, 'I'],
  [3, 8, 'I'],
  [6, 6, 'W'],
  [7, 6, 'W'],
];

// ---------------------------------------------------------------------------
// Part A — the rig
// ---------------------------------------------------------------------------

/**
 * Everything a rig scene needs, passed **in** rather than closed over:
 * `page.evaluate` serialises the callback's source, so an outer `const` it
 * mentions simply does not exist in the page.
 */
interface SceneArgs {
  quality: string;
  terrain: [number, number, string][];
}

async function rigPass(
  browser: Browser,
  results: Results,
  quality: Quality,
  shots: boolean,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript({ content: KEEP_NAMES_SHIM });
  await page.goto(URL, { waitUntil: 'load', timeout: 30_000 });
  await page.evaluate(installRig);

  if (shots) {
    // --- 1. a brick wall mid-destruction ----------------------------------
    await page.evaluate(
      (a: SceneArgs) => {
        const H = (globalThis as unknown as { H: Rig }).H;
        H.init('high', a.terrain);
        H.tank({ kind: 'player', playerIndex: 0, id: 0, tx: 6, ty: 8, dir: 0 });
        H.render(16);
        for (const tx of [4, 6, 8]) {
          H.event({
            t: 'brickHit',
            tx,
            ty: 6,
            removedMask: 3,
            x: tx * 16 + 6,
            y: 6 * 16 + 14,
            dir: 0,
          });
        }
        // ~180 ms in: past the launch, before the first bounce lands.
        H.advance(180, 11);
      },
      { quality: 'high', terrain: BRICK_WALL } satisfies SceneArgs,
    );
    await shot(page, '1-brick-mid-destruction');

    // --- 2. a tank explosion at its peak ----------------------------------
    await page.evaluate(
      (a: SceneArgs) => {
        const H = (globalThis as unknown as { H: Rig }).H;
        H.init('high', a.terrain);
        H.tank({ kind: 'player', playerIndex: 0, id: 0, tx: 3, ty: 9, dir: 1 });
        H.tank({ enemyType: 'armor', tx: 9, ty: 9, hp: 4, ordinal: 2 });
        H.render(16);
        // Clear board, deliberately: the first cut put this over the water pit
        // (recessed −3 u) and the debris fell into a hole.
        H.event({
          t: 'tankDestroyed',
          tankId: 11,
          kind: 'enemy',
          enemyType: 'power',
          points: 300,
          x: 5 * 16 + 6,
          y: 8 * 16 + 6,
        });
        // Art §8: "flash sphere scale 1→2.2 over 120 ms". The *peak* is a
        // trade — the flare grows for the whole window but fades as it goes —
        // and 48 ms is where it is both wide and still bright.
        H.advance(48, 3);
      },
      { quality: 'high', terrain: BUSY_TERRAIN } satisfies SceneArgs,
    );
    await shot(page, '2-tank-explosion-peak');

    // --- 3. the base explosion --------------------------------------------
    await page.evaluate(
      (a: SceneArgs) => {
        const H = (globalThis as unknown as { H: Rig }).H;
        H.init('high', a.terrain);
        H.tank({ kind: 'player', playerIndex: 0, id: 0, tx: 3, ty: 9, dir: 1 });
        H.render(16);
        H.eagle(false);
        H.event({ t: 'baseDestroyed' });
        // Far enough in for the second shockwave ring to have separated from the
        // first and for the smoke column to have stood up.
        H.advance(320, 20);
      },
      { quality: 'high', terrain: BUSY_TERRAIN } satisfies SceneArgs,
    );
    await shot(page, '3-base-explosion');
  }

  // --- 5 / 6. the busy frame: idle first, then everything at once ----------
  await page.evaluate(
    (a: SceneArgs) => {
      const H = (globalThis as unknown as { H: Rig }).H;
      H.init(a.quality, a.terrain);
      H.tank({ kind: 'player', playerIndex: 0, id: 0, tx: 6, ty: 9, dir: 0, tier: 3, moving: true }); // prettier-ignore
      H.tank({ kind: 'player', playerIndex: 1, id: 1, tx: 4, ty: 9, dir: 1, moving: true }); // prettier-ignore
      H.tank({ enemyType: 'basic', tx: 2, ty: 1, ordinal: 1 });
      H.tank({ enemyType: 'fast', tx: 10, ty: 2, ordinal: 2 });
      H.tank({ enemyType: 'power', tx: 6, ty: 2, ordinal: 3 });
      H.tank({ enemyType: 'armor', tx: 11, ty: 5, hp: 4, ordinal: 4 });
      H.tank({ enemyType: 'basic', tx: 1, ty: 5, ordinal: 5, spawningT: 1 });
      H.bullet(3 * 16 + 6, 7 * 16 + 6, 1);
      H.bullet(9 * 16 + 6, 4 * 16 + 6, 2);
      H.powerup('star', 8 * 16, 8 * 16);
      // Two frames: the first builds the terrain, the second is the honest idle.
      H.render(16);
      H.render(16);
    },
    { quality, terrain: BUSY_TERRAIN } satisfies SceneArgs,
  );
  const idle = await costOf(page);

  await page.evaluate(() => {
    const H = (globalThis as unknown as { H: Rig }).H;
    // Everything art §8 can throw at one frame, thrown at one frame.
    for (let i = 0; i < 3; i++) {
      H.event({ t: 'brickHit', tx: 2 + i, ty: 3, removedMask: 3, x: (2 + i) * 16 + 6, y: 3 * 16 + 6, dir: 2 }); // prettier-ignore
    }
    H.event({ t: 'steelHit', tx: 8, ty: 3, removedMask: 15, destroyed: true, x: 8 * 16 + 6, y: 3 * 16 + 6, dir: 1 }); // prettier-ignore
    H.event({ t: 'steelHit', tx: 9, ty: 3, removedMask: 0, destroyed: false, x: 9 * 16 + 6, y: 3 * 16 + 6, dir: 1 }); // prettier-ignore
    H.event({ t: 'tankDestroyed', tankId: 12, kind: 'enemy', enemyType: 'fast', points: 200, x: 10 * 16 + 6, y: 2 * 16 + 6 }); // prettier-ignore
    H.event({ t: 'tankDestroyed', tankId: 13, kind: 'enemy', enemyType: 'power', points: 300, x: 6 * 16 + 6, y: 2 * 16 + 6 }); // prettier-ignore
    H.event({ t: 'shotFired', tankId: 0, x: 6 * 16 + 6, y: 8 * 16, dir: 0, byPlayer: true }); // prettier-ignore
    H.event({ t: 'shotFired', tankId: 1, x: 5 * 16, y: 9 * 16 + 6, dir: 1, byPlayer: true }); // prettier-ignore
    H.event({ t: 'enemySpawnStarted', spawnOrdinal: 5, x: 16, y: 5 * 16, enemyType: 'basic', carrier: false }); // prettier-ignore
    H.event({ t: 'powerupSpawned', type: 'star', x: 8 * 16, y: 8 * 16 });
    H.event({ t: 'iceSkidStarted', tankId: 1 });
    H.event({ t: 'treeEntered', tankId: 10 });
    H.event({ t: 'playerStunned', playerIndex: 1, durS: 3 });
    H.eagle(false);
    H.event({ t: 'baseDestroyed' });
    // 200 ms in: chunks in flight, both shockwaves alive, smoke standing up.
    H.advance(200, 12);
  });
  const busy = await costOf(page);

  results.rig[quality] = { idle, busy, delta: busy.calls - idle.calls };

  await page.evaluate(
    (text: string) => {
      (globalThis as unknown as { H: Rig }).H.overlay(text);
    },
    overlayText(quality, idle, busy),
  );
  await shot(
    page,
    quality === 'high' ? '5-busy-frame-high' : `6-busy-${quality}`,
  );
  await page.close();
  await context.close();
}

/** The measured numbers, printed on the frame they were measured in. */
function overlayText(
  quality: Quality,
  idle: FrameCost,
  busy: FrameCost,
): string {
  return [
    `preset        ${quality}`,
    `scene draws   ${busy.calls}   (idle ${idle.calls}, budget ${BUDGET.sceneDrawCalls})`,
    `render CPU    ${busy.ms.toFixed(2)} ms   (budget ${BUDGET.renderCpuMs} ms)`,
    `particles     ${busy.particles}`,
    `lights        ${busy.lights}`,
    `fx meshes     ${busy.activeKinds}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Part B — the real page
// ---------------------------------------------------------------------------

/** The same scripted skirmish `capture-play.ts` drives, so the two compare. */
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

function stats(samples: FrameSample[], elapsed: number): LoopStats {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const calls = samples.map((s) => s.calls).sort((a, b) => a - b);
  const pick = (xs: number[], q: number): number =>
    xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;
  const total = ms.reduce((a, b) => a + b, 0);
  const round = (n: number): number => +n.toFixed(3);
  return {
    frames: samples.length,
    meanMs: round(total / Math.max(1, ms.length)),
    medianMs: round(pick(ms, 0.5)),
    p95Ms: round(pick(ms, 0.95)),
    maxMs: round(ms[ms.length - 1] ?? 0),
    fps: +((samples.length * 1000) / Math.max(1, elapsed)).toFixed(1),
    drawCalls: {
      min: calls[0] ?? 0,
      median: pick(calls, 0.5),
      max: calls[calls.length - 1] ?? 0,
    },
  };
}

async function loopPass(
  browser: Browser,
  results: Results,
  quality: Quality,
  shots: boolean,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning')
      warnings.push(msg.text().replace(/\s+/g, ' ').trim());
  });
  await page.addInitScript({ content: KEEP_NAMES_SHIM });
  await page.addInitScript(instrument);
  await page.goto(`${URL}?quality=${quality}&seed=${SEED}`);
  await page.locator('[data-hud="root"]').waitFor();
  await sleep(INTRO_MS + 500);

  // Warm up, so the measured window is a busy board rather than an empty one.
  await play(page, 6000);

  await page.evaluate(() => {
    (globalThis as unknown as { __bcfx: PerfHook }).__bcfx.start();
  });
  const windowMs = 8000;
  const t0 = Date.now();
  const playing = play(page, windowMs);

  if (shots) {
    // A burst while the board is at its busiest: one of these has a muzzle
    // flash and a tracer in it, which is the frame the report needs.
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      await page.screenshot({ path: join(OUT, `4-play-${quality}-${i}.png`) });
    }
  }
  await playing;
  const elapsed = Date.now() - t0;

  const samples = await page.evaluate(() =>
    (globalThis as unknown as { __bcfx: PerfHook }).__bcfx.stop(),
  );
  results.loop[quality] = stats(samples, elapsed);
  results.console[quality] = { errors, warnings };

  if (shots) {
    results.gpu = {
      ...(await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2');
        if (!gl) return { vendor: '(no webgl2)', renderer: '(no webgl2)' };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext)
          return {
            vendor: '(masked)',
            renderer: gl.getParameter(gl.RENDERER) as string,
          };
        return {
          vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string,
          renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string,
        };
      })),
      headless: false,
    };
  }

  await page.close();
  await context.close();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: URL,
    viewport: { w: W, h: H },
    gpu: { vendor: '', renderer: '', headless: false },
    budget: BUDGET,
    rig: {},
    loop: {},
    baseline: null,
    baselineCapturedAt: null,
    console: {},
    verdict: {
      highLoopDrawCallsMax: 0,
      highLoopMeanMs: 0,
      highLoopP95Ms: 0,
      rigBusyCalls: 0,
      rigFxDelta: 0,
      drawCallsPass: false,
      frameTimePass: false,
      consolePass: false,
    },
  };

  // The pre-FX numbers, read from the artifact T3.2 committed rather than
  // quoted from a report — "a measurement is evidence only if an artifact
  // backs it" cuts both ways.
  if (existsSync(BASELINE)) {
    const prior = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
      loop: Record<string, LoopStats>;
      capturedAt: string;
    };
    results.baseline = prior.loop;
    results.baselineCapturedAt = prior.capturedAt;
  }

  const browser = await chromium.launch({ headless: false });
  try {
    await rigPass(browser, results, 'high', true);
    await rigPass(browser, results, 'low', false);
    for (const quality of QUALITIES) {
      await loopPass(browser, results, quality, quality === 'high');
    }
  } finally {
    await browser.close();
  }

  const high = results.loop.high;
  const rigHigh = results.rig.high;
  results.verdict = {
    highLoopDrawCallsMax: high?.drawCalls.max ?? 0,
    highLoopMeanMs: high?.meanMs ?? 0,
    highLoopP95Ms: high?.p95Ms ?? 0,
    rigBusyCalls: rigHigh?.busy.calls ?? 0,
    rigFxDelta: rigHigh?.delta ?? 0,
    drawCallsPass: (high?.drawCalls.max ?? Infinity) <= BUDGET.sceneDrawCalls,
    // Mean AND p95: a mean inside budget with a p95 outside it is a stutter,
    // and the first run of this script found exactly that (a shader-recompile
    // storm from toggling `PointLight.visible`).
    frameTimePass:
      (high?.meanMs ?? Infinity) <= BUDGET.renderCpuMs &&
      (high?.p95Ms ?? Infinity) <= BUDGET.renderCpuMs,
    consolePass: QUALITIES.every(
      (q) => (results.console[q]?.errors.length ?? 1) === 0,
    ),
  };

  writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nscreenshots → ${OUT}`);
  console.log(`measurements → ${ARTIFACT}\n`);
  console.log(`GPU: ${results.gpu.vendor} / ${results.gpu.renderer}`);
  console.table(
    Object.entries(results.rig).map(([q, r]) => ({
      preset: q,
      idleCalls: r.idle.calls,
      busyCalls: r.busy.calls,
      delta: r.delta,
      busyMs: r.busy.ms,
      particles: r.busy.particles,
      lights: r.busy.lights,
      fxMeshes: r.busy.activeKinds,
    })),
  );
  console.table(results.loop);
  if (results.baseline !== null) console.table(results.baseline);
  console.log('verdict:', results.verdict);
  for (const q of QUALITIES) {
    const c = results.console[q];
    console.log(
      `console ${q}: ${c.errors.length} error(s), ${c.warnings.length} warning(s)`,
    );
  }
  if (
    !results.verdict.drawCallsPass ||
    !results.verdict.frameTimePass ||
    !results.verdict.consolePass
  ) {
    // A non-zero exit so this can never be "green" in a log nobody read.
    console.error('\nFX budget FAILED — see docs/calibration/fx.json');
    process.exitCode = 1;
  }
}

void main();
