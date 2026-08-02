// scripts/capture-entities.ts — the visual-verification harness for the entity
// layer: art §4's silhouettes, art §9's animation states, art §11's grayscale
// bar, canopy concealment and the draw-call budget.
//
//   npm run dev            # in another terminal — the script needs it
//   npm run capture:entities
//
// Output goes to `screens/entities/` (git-ignored) unless CAPTURE_OUT says
// otherwise: PNGs plus a `results.json` with every number this prints.
//
// NOT `test-results/`, which Playwright owns and **wipes** at the start of every
// `npx playwright test` — measured, after a full run of this script vanished.
//
// ## Why this is checked in, and what it is for
//
// `calibrate-lighting.ts` answers "is this token the right colour". This answers
// the questions that only pixels can: does a tank read as a tank, do the five
// silhouettes separate **in grayscale** (art §11), does a canopy still hide a
// 12 u Armor tank, and how many draw calls does a full field cost. T2.4 needed
// all of those and none of them was reproducible afterwards; now they are.
//
// Like the calibration harness it drives the **real** `createRenderer` over the
// Vite dev server, so it measures the code that ships rather than a
// re-implementation of it. The simulation is never stepped — the rig owns the
// field and writes tank positions directly, which is what makes every frame
// reproducible.

import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT = process.env.CAPTURE_OUT ?? join('screens', 'entities');

/** Full frames. */
const W = 1600;
const H = 900;
/** Detail pass: ~8 px per world unit, so a 16 u tank is ~130 px. */
const DW = 3200;
const DH = 1800;
/** The crop the detail shots use — one row of tanks across the board. */
const ROW = { x: 700, y: 760, width: 1900, height: 400 };

// --- T3.3: the two static props -------------------------------------------

/**
 * Fidelity §2's base brick ring, as terrain-spec entries. The rig builds its
 * levels with `noAutoBase`, so the nest the eagle sits in has to be asked for.
 */
const BASE_NEST: [number, number, string][] = [
  [5, 11, 'B'],
  [6, 11, 'B'],
  [7, 11, 'B'],
  [5, 12, 'B'],
  [7, 12, 'B'],
];

/**
 * Where a tile lands in the `W × H` frame, in pixels.
 *
 * Written out rather than projected through the camera because the rig's
 * renderer does not expose one — and it is a *fixed* camera (art §2), so this
 * is arithmetic and not a guess. Derived exactly as `sceneRoot.ts` does it:
 * the frustum fits `2·HALF_Y = 222.4 u` into 900 px, the camera aims at
 * `(104, 8, 104)`, and screen height is `y·sin 32° − z·cos 32°`.
 */
const SIN32 = Math.sin((32 * Math.PI) / 180);
const COS32 = Math.cos((32 * Math.PI) / 180);
/** `sceneRoot.ts`'s `HALF_Y`, and the screen height of its camera target. */
const HALF_Y = (224 * COS32) / 2 + (16 * SIN32) / 2 + 12;
const TARGET_HV = 8 * SIN32 - 104 * COS32;

function projector(
  w: number,
  h: number,
): {
  perU: number;
  x(x: number): number;
  y(y: number, z: number): number;
} {
  // Contain-fit: at every viewport this script uses, height is the binding
  // axis, so one number scales both.
  const perU = h / (2 * HALF_Y);
  return {
    perU,
    x: (x) => w / 2 + (x - 104) * perU,
    y: (y, z) => h / 2 - (y * SIN32 - z * COS32 - TARGET_HV) * perU,
  };
}

const VIEW = projector(W, H);
const DETAIL = projector(DW, DH);

/** A box around tile (6,6) big enough for the tallest power-up at full bob. */
const POWERUP_CLIP = {
  x: Math.round(VIEW.x(104 - 9)),
  y: Math.round(VIEW.y(19, 104)),
  w: Math.round(18 * VIEW.perU),
  h: Math.round(VIEW.y(0, 113) - VIEW.y(19, 104)),
};

/** …and one around the eagle's tile (6,12) plus a margin of its brick nest. */
const EAGLE_CLIP = {
  x: Math.round(VIEW.x(104 - 12)),
  y: Math.round(VIEW.y(20, 200)),
  w: Math.round(24 * VIEW.perU),
  h: Math.round(VIEW.y(0, 210) - VIEW.y(20, 200)),
};

/** The same region on the 3200×1800 detail pass, as a Playwright clip. */
const EAGLE_DETAIL = {
  x: Math.round(DETAIL.x(104 - 22)),
  y: Math.round(DETAIL.y(22, 192)),
  width: Math.round(44 * DETAIL.perU),
  height: Math.round(DETAIL.y(0, 214) - DETAIL.y(22, 192)),
};

/** The page-side rig members the prop section uses. */
interface RigProps {
  init(q: string, t?: [number, number, string][]): void;
  render(d?: number): void;
  advance(ms: number, steps?: number): void;
  bullet(x: number, y: number, dir: number): void;
  powerup(type: string | null, tx?: number, ty?: number): void;
  eagle(alive: boolean): void;
  crop(x: number, y: number, w: number, h: number): HTMLCanvasElement;
  sheet(cells: { label: string; canvas: HTMLCanvasElement }[]): void;
  graySheet(on: boolean): void;
}

/** A tank the rig puts on the field. Mirrors `Tank` minus the AI bookkeeping. */
interface TankSpec {
  id?: number;
  kind?: 'player' | 'enemy';
  playerIndex?: 0 | 1;
  enemyType?: 'basic' | 'fast' | 'power' | 'armor';
  ordinal?: number;
  carrier?: boolean;
  tx: number;
  ty: number;
  dir?: 0 | 1 | 2 | 3;
  moving?: boolean;
  hp?: number;
  tier?: 0 | 1 | 2 | 3;
  shieldT?: number;
  stunT?: number;
  spawningT?: number;
}

interface PairSeparation {
  outlineIouPct: number;
  grayMeanDelta: number;
  strongDiffPct: number;
}

interface Concealment {
  openPx: number;
  underPx: number;
  concealedPct: number;
}

interface Silhouette {
  areaPx: Record<string, number>;
  screenHeightPx: Record<string, number>;
  pairs: Record<string, PairSeparation>;
}

/** T3.3: what the two static props measure. */
interface Props {
  /** Every pair of the six power-ups, scored on the same bar as the tanks. */
  powerupPairs: Record<string, PairSeparation>;
  /** Lit area of each power-up's crop, in px — the size half of readability. */
  powerupAreaPx: Record<string, number>;
  /**
   * The eagle's own before/after, over the tile it occupies: how much of the
   * base's screen area changes when it falls, and how much darker it gets.
   * This is the game-over signal, quantified.
   */
  eagleLoss: {
    intactAreaPx: number;
    destroyedAreaPx: number;
    changedPx: number;
    strongDiffPct: number;
    intactMeanGray: number;
    destroyedMeanGray: number;
    /** Peak brightness in the tile — the emblem, and then what replaces it. */
    intactMaxGray: number;
    destroyedMaxGray: number;
  };
}

interface Results {
  /** Keyed by facing — art §4's barrel rule is "reads from all four facings". */
  silhouette: Record<string, Silhouette>;
  concealment: Record<string, Concealment>;
  drawCalls: Record<string, number>;
  props: Props;
  steadyState: { objectAdds: number; msPerFrame: number };
  midPoolDeath: { changedPx: number; changedOutsideTheDeadTankPx: number };
  previewConsole: Record<string, string[] | string>;
}

/**
 * Installs `globalThis.H`, the page-side rig. Everything below runs in the
 * browser, so it may only use what the page has: the Vite-served sources and
 * the DOM.
 */
async function installRig(): Promise<void> {
  // Held in variables rather than written as literals so tsc treats them as
  // dynamic — a literal would be resolved against the Node program and fail.
  const urls = {
    core: '/src/core/game.ts',
    renderer: '/src/render/renderer.ts',
  };
  const core = await import(urls.core);
  const rend = await import(urls.renderer);
  const threeUrl = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/deps/three.js'));
  if (threeUrl === undefined) throw new Error('three module URL not found');
  const THREE = await import(threeUrl);

  // Instrumentation on the prototypes, so nothing is added to production code.
  // The draw count is definitionally `renderer.info.render.calls` — three
  // increments `WebGLInfo` from these same call sites.
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
  let adds = 0;
  const origAdd = THREE.Object3D.prototype.add;
  THREE.Object3D.prototype.add = function (this: unknown, ...a: unknown[]) {
    adds++;
    return origAdd.apply(this, a);
  };

  const rows = (spec: [number, number, string][]): string[] => {
    const g = Array.from({ length: 13 }, () => '.............'.split(''));
    for (const [tx, ty, ch] of spec) g[ty][tx] = ch;
    return g.map((r) => r.join(''));
  };

  const H = {
    renderer: undefined as unknown,
    canvas: undefined as unknown as HTMLCanvasElement,
    state: undefined as unknown,
    nextId: 10,

    calls: () => calls,
    resetCalls: () => {
      calls = 0;
    },
    adds: () => adds,
    resetAdds: () => {
      adds = 0;
    },

    /** A fresh renderer + a fresh, un-stepped game on `terrain`. */
    init(quality: string, terrain?: [number, number, string][]): void {
      document.querySelectorAll('canvas.rig').forEach((c) => c.remove());
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
          id: 'capture',
          name: 'capture',
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

    tank(o: Record<string, unknown>): Record<string, unknown> {
      const tx = o.tx as number;
      const ty = o.ty as number;
      const t: Record<string, unknown> = {
        id: (o.id as number | undefined) ?? H.nextId++,
        alive: true,
        kind: o.kind ?? 'enemy',
        playerIndex: o.playerIndex,
        enemyType: o.enemyType,
        spawnOrdinal: o.ordinal ?? 1,
        carrier: o.carrier ?? false,
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
        shieldT: o.shieldT ?? 0,
        stunT: o.stunT ?? 0,
        frozenT: 0,
        spawningT: o.spawningT ?? 0,
        bulletsAirborne: 0,
        fireHeld: false,
        aiTimerT: 0,
        aiTileX: 0,
        aiTileY: 0,
      };
      (H.state as { tanks: unknown[] }).tanks.push(t);
      return t;
    },

    /** T3.3: put a power-up on the field (fidelity §8 — at most one). */
    powerup(type: string | null, tx = 0, ty = 0): void {
      const s = H.state as {
        powerup: { type: string; x: number; y: number } | null;
      };
      s.powerup = type === null ? null : { type, x: tx * 16, y: ty * 16 };
    },

    /** T3.3: the eagle's state flag — the view's source of truth. */
    eagle(alive: boolean): void {
      (H.state as { eagleAlive: boolean }).eagleAlive = alive;
    },

    /**
     * A copy of a region of the drawing buffer as an ordinary 2D canvas.
     *
     * `readPixels` is bottom-left origin and the row order is therefore
     * upside down; this flips it. Used to build the six-up power-up sheet,
     * which cannot be a single render — the core allows exactly one power-up on
     * the field, so the six have to be rendered one at a time and assembled.
     */
    crop(x: number, y: number, w: number, h: number): HTMLCanvasElement {
      const gl = H.canvas.getContext('webgl2');
      if (gl === null) throw new Error('no webgl2 context');
      const bh = gl.drawingBufferHeight;
      const data = new Uint8Array(w * h * 4);
      // y is given top-down; readPixels wants the bottom edge.
      gl.readPixels(x, bh - (y + h), w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      const img = ctx.createImageData(w, h);
      for (let row = 0; row < h; row++) {
        const src = (h - 1 - row) * w * 4;
        img.data.set(data.subarray(src, src + w * 4), row * w * 4);
      }
      ctx.putImageData(img, 0, 0);
      return out;
    },

    /** Lays crops out in a labelled row for one screenshot. */
    sheet(cells: { label: string; canvas: HTMLCanvasElement }[]): void {
      document.querySelectorAll('.sheet').forEach((n) => {
        n.remove();
      });
      const box = document.createElement('div');
      box.className = 'sheet';
      box.style.cssText =
        'position:fixed;left:0;top:0;z-index:100;display:flex;gap:8px;' +
        'padding:12px;background:#10121b;font:12px monospace;color:#cfd6e4;';
      for (const c of cells) {
        const cell = document.createElement('div');
        cell.style.cssText = 'text-align:center;';
        cell.append(c.canvas);
        const tag = document.createElement('div');
        tag.textContent = c.label;
        cell.append(tag);
        box.append(cell);
      }
      document.body.append(box);
    },

    graySheet(on: boolean): void {
      const box = document.querySelector('.sheet');
      if (box instanceof HTMLElement) {
        box.style.filter = on ? 'grayscale(1)' : 'none';
      }
    },

    bullet(x: number, y: number, dir: number): void {
      const bullets = (H.state as { bullets: unknown[] }).bullets;
      bullets.push({
        id: bullets.length,
        alive: true,
        x,
        y,
        prevX: x,
        prevY: y,
        dir,
        speed: 120,
        fromTankId: 0,
        byPlayer: true,
        canHurtSteel: false,
      });
    },

    event(e: unknown): void {
      (H.renderer as { onEvent(e: unknown): void }).onEvent(e);
    },
    render(dt = 0): void {
      (
        H.renderer as {
          render(s: unknown, a: number, d: number): void;
        }
      ).render(H.state, 1, dt);
    },
    /** `ms` of animation, in `steps` frames. */
    advance(ms: number, steps = 1): void {
      for (let i = 0; i < steps; i++) H.render(ms / steps);
    },
    gray(on: boolean): void {
      H.canvas.style.filter = on ? 'grayscale(1)' : 'none';
    },
    /** The drawing buffer, read back so nothing depends on the compositor. */
    pixels(): { w: number; h: number; data: Uint8Array } {
      const gl = H.canvas.getContext('webgl2');
      if (gl === null) throw new Error('no webgl2 context');
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const data = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return { w, h, data };
    },
  };
  (globalThis as unknown as { H: typeof H }).H = H;
}

async function shot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
  gray = false,
): Promise<void> {
  await page.evaluate((g: boolean) => {
    const H = (
      globalThis as unknown as {
        H: { gray(b: boolean): void; render(d?: number): void };
      }
    ).H;
    H.gray(g);
    H.render(0);
  }, gray);
  // One composite after the render, so the screenshot captures this frame.
  await page.waitForTimeout(120);
  // Playwright's 30 s default is not enough for the 3200×1800 detail pass under
  // SwiftShader — it timed out mid-run on the T3.3 machine and cost the whole
  // capture, results.json included, because the artifact is written last.
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    clip,
    timeout: 180_000,
  });
  await page.evaluate(() => {
    (globalThis as unknown as { H: { gray(b: boolean): void } }).H.gray(false);
  });
}

/** A line-up of every silhouette art §4 defines, two tiles apart. */
function lineUp(dir: 0 | 1 = 0, tier: 0 | 1 | 2 | 3 = 0): TankSpec[] {
  return [
    { kind: 'player', playerIndex: 0, tx: 0, ty: 6, id: 0, dir, tier },
    { kind: 'player', playerIndex: 1, tx: 2, ty: 6, id: 1, dir, tier },
    { enemyType: 'basic', tx: 4, ty: 6, ordinal: 1, dir },
    { enemyType: 'fast', tx: 6, ty: 6, ordinal: 2, dir },
    { enemyType: 'power', tx: 8, ty: 6, ordinal: 3, dir },
    { enemyType: 'armor', tx: 10, ty: 6, hp: 4, ordinal: 5, dir },
  ];
}

async function setScene(
  page: Page,
  quality: string,
  tanks: TankSpec[],
  terrain: [number, number, string][] = [],
): Promise<void> {
  await page.evaluate(
    (a: {
      quality: string;
      tanks: TankSpec[];
      terrain: [number, number, string][];
    }) => {
      const H = (
        globalThis as unknown as {
          H: {
            init(q: string, t?: [number, number, string][]): void;
            tank(o: Record<string, unknown>): unknown;
            render(d?: number): void;
          };
        }
      ).H;
      H.init(a.quality, a.terrain);
      for (const t of a.tanks) H.tank(t as unknown as Record<string, unknown>);
      H.render(0);
    },
    { quality, tanks, terrain },
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });

  const results = {} as Results;

  // --- full frames --------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.addInitScript(() => {
    // tsx compiles this file with esbuild's `keepNames`, which wraps every
    // function in a `__name(...)` call — a helper that exists only in the Node
    // bundle. The browser needs an identity stand-in or every evaluated
    // function throws `ReferenceError: __name is not defined`.
    (globalThis as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
  });
  await page.goto(URL, { waitUntil: 'load', timeout: 20_000 }).catch(() => {
    throw new Error(`cannot reach ${URL} — is \`npm run dev\` running?`);
  });
  await page.evaluate(installRig);

  await setScene(page, 'high', [
    ...lineUp(),
    { enemyType: 'basic', tx: 12, ty: 6, ordinal: 4, carrier: true },
  ]);
  await shot(page, 'lineup-colour');
  await shot(page, 'lineup-grayscale', undefined, true);

  await setScene(
    page,
    'high',
    ([0, 1, 2, 3] as const).map((tier) => ({
      kind: 'player' as const,
      playerIndex: 0 as const,
      tx: 1 + tier * 3,
      ty: 6,
      tier,
    })),
  );
  await shot(page, 'tiers-0-3');

  await setScene(
    page,
    'high',
    [0, 1, 2, 3].map((i) => ({
      enemyType: 'armor' as const,
      tx: 1 + i * 3,
      ty: 6,
      hp: 4 - i,
      ordinal: i + 1,
    })),
  );
  await page.evaluate(() => {
    // Past the 150 ms crossfade, so every plate has landed on its tint.
    (
      globalThis as unknown as { H: { advance(ms: number, n: number): void } }
    ).H.advance(400, 8);
  });
  await shot(page, 'armor-hp');

  await setScene(page, 'high', [
    { enemyType: 'basic', tx: 5, ty: 5, ordinal: 4, carrier: true },
    { enemyType: 'basic', tx: 7, ty: 5, ordinal: 1 },
  ]);
  await shot(page, 'carrier-pulse-on');
  await page.evaluate(() => {
    (
      globalThis as unknown as { H: { advance(ms: number, n: number): void } }
    ).H.advance(130, 4);
  });
  await shot(page, 'carrier-pulse-off');

  await setScene(page, 'high', [
    { enemyType: 'basic', tx: 3, ty: 6, ordinal: 1, spawningT: 1.3 },
    { kind: 'player', playerIndex: 0, tx: 6, ty: 6, shieldT: 3, id: 0 },
    { kind: 'player', playerIndex: 1, tx: 9, ty: 6, stunT: 3, id: 1 },
  ]);
  await page.evaluate(() => {
    (
      globalThis as unknown as { H: { advance(ms: number, n: number): void } }
    ).H.advance(200, 8);
  });
  await shot(page, 'spawn-shield-stun');

  // --- T3.3: the two static props -----------------------------------------
  //
  // The eagle first, in its own brick nest and at gameplay scale — the whole
  // point of the task is that "does defending the base feel right" cannot be
  // judged from a detail crop, so the full frame is the deliverable and the
  // crop is the follow-up.
  for (const alive of [true, false]) {
    await setScene(
      page,
      'high',
      [
        { kind: 'player', playerIndex: 0, tx: 4, ty: 12, id: 0 },
        { enemyType: 'basic', tx: 6, ty: 9, ordinal: 1, dir: 2 },
      ],
      BASE_NEST,
    );
    await page.evaluate((a: boolean) => {
      (globalThis as unknown as { H: RigProps }).H.eagle(a);
    }, alive);
    await shot(page, alive ? 'eagle-intact' : 'eagle-destroyed');
  }

  // The six power-ups, side by side. They cannot be one render — fidelity §8
  // allows exactly one on the field — so each is rendered on its own and its
  // crop is assembled into a contact sheet, which is then shot in colour and
  // again through a grayscale filter (art §11's bar).
  results.props = {} as Props;
  const sheetMeasure = await page.evaluate(
    (a: { clip: { x: number; y: number; w: number; h: number } }) => {
      const H = (globalThis as unknown as { H: RigProps }).H;
      const TYPES = ['star', 'helmet', 'clock', 'shovel', 'grenade', 'tank'];
      // Low, so shadows are off: a shadow is not part of a silhouette.
      H.init('low');
      H.eagle(true);
      H.powerup(null);
      H.render(0);
      const empty = H.crop(a.clip.x, a.clip.y, a.clip.w, a.clip.h);
      const ectx = empty.getContext('2d');
      if (ectx === null) throw new Error('no 2d context');
      const ref = ectx.getImageData(0, 0, a.clip.w, a.clip.h).data;

      const cells: { label: string; canvas: HTMLCanvasElement }[] = [];
      const masks: Record<
        string,
        { m: Uint8Array; n: number; lum: Float32Array }
      > = {};
      for (const type of TYPES) {
        H.powerup(type, 6, 6);
        // A third of the way into the bob and a fifth of a turn: neither the
        // top nor the bottom of the arc, so the sheet shows the shape in the
        // pose a player usually meets it in rather than a lucky one.
        H.advance(400, 8);
        const c = H.crop(a.clip.x, a.clip.y, a.clip.w, a.clip.h);
        cells.push({ label: type, canvas: c });
        const ctx = c.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        const px = ctx.getImageData(0, 0, a.clip.w, a.clip.h).data;
        const m = new Uint8Array(a.clip.w * a.clip.h);
        const lum = new Float32Array(m.length);
        let n = 0;
        for (let i = 0; i < m.length; i++) {
          const j = i * 4;
          lum[i] = 0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2];
          const d = Math.max(
            Math.abs(ref[j] - px[j]),
            Math.abs(ref[j + 1] - px[j + 1]),
            Math.abs(ref[j + 2] - px[j + 2]),
          );
          if (d > 16) {
            m[i] = 1;
            n++;
          }
        }
        masks[type] = { m, n, lum };
      }
      H.sheet(cells);

      const pairs: Record<string, unknown> = {};
      for (const a1 of TYPES) {
        for (const b1 of TYPES) {
          if (a1 >= b1) continue;
          let inter = 0;
          let uni = 0;
          let sum = 0;
          let strong = 0;
          for (let i = 0; i < masks[a1].m.length; i++) {
            const x = masks[a1].m[i];
            const y = masks[b1].m[i];
            if (x | y) {
              uni++;
              const d = Math.abs(masks[a1].lum[i] - masks[b1].lum[i]);
              sum += d;
              if (d > 40) strong++;
            }
            if (x & y) inter++;
          }
          pairs[`${a1}|${b1}`] = {
            outlineIouPct: +((inter / uni) * 100).toFixed(1),
            grayMeanDelta: +(sum / uni).toFixed(1),
            strongDiffPct: +((strong / uni) * 100).toFixed(1),
          };
        }
      }
      const areaPx: Record<string, number> = {};
      for (const t of TYPES) areaPx[t] = masks[t].n;
      return { pairs, areaPx };
    },
    { clip: POWERUP_CLIP },
  );
  results.props.powerupPairs = sheetMeasure.pairs as Record<
    string,
    PairSeparation
  >;
  results.props.powerupAreaPx = sheetMeasure.areaPx;

  await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, 'powerups-colour.png') });
  await page.evaluate(() => {
    (globalThis as unknown as { H: RigProps }).H.graySheet(true);
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, 'powerups-grayscale.png') });
  await page.evaluate(() => {
    document.querySelectorAll('.sheet').forEach((n) => {
      n.remove();
    });
  });

  // How much of the base's own tile changes when it falls — the game-over
  // signal, as a number rather than as an opinion.
  results.props.eagleLoss = await page.evaluate(
    (a: {
      clip: { x: number; y: number; w: number; h: number };
      nest: [number, number, string][];
    }) => {
      const H = (globalThis as unknown as { H: RigProps }).H;
      const read = (alive: boolean | null): Uint8ClampedArray => {
        H.init('low', a.nest);
        if (alive !== null) H.eagle(alive);
        H.render(0);
        const c = H.crop(a.clip.x, a.clip.y, a.clip.w, a.clip.h);
        const ctx = c.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        return ctx.getImageData(0, 0, a.clip.w, a.clip.h).data;
      };
      // Both states are read over the same crop — the base's tile plus a
      // margin of its nest — and compared against each other rather than
      // against an empty board: what is being measured is what a player sees
      // change, and the brick around it does not.
      const intact = read(true);
      const ruin = read(false);
      const gray = (d: Uint8ClampedArray, i: number): number =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      let changed = 0;
      let strong = 0;
      let n = 0;
      let sumI = 0;
      let sumR = 0;
      let maxI = 0;
      let maxR = 0;
      let areaI = 0;
      let areaR = 0;
      for (let i = 0; i < intact.length; i += 4) {
        n++;
        const gi = gray(intact, i);
        const gr = gray(ruin, i);
        sumI += gi;
        sumR += gr;
        if (gi > maxI) maxI = gi;
        if (gr > maxR) maxR = gr;
        // "Lit" = brighter than the near-black board, i.e. something is there.
        if (gi > 30) areaI++;
        if (gr > 30) areaR++;
        const d = Math.abs(gi - gr);
        if (d > 16) changed++;
        if (d > 40) strong++;
      }
      return {
        intactAreaPx: areaI,
        destroyedAreaPx: areaR,
        changedPx: changed,
        strongDiffPct: +((100 * strong) / n).toFixed(1),
        intactMeanGray: +(sumI / n).toFixed(1),
        destroyedMeanGray: +(sumR / n).toFixed(1),
        intactMaxGray: +maxI.toFixed(1),
        destroyedMaxGray: +maxR.toFixed(1),
      };
    },
    { clip: EAGLE_CLIP, nest: BASE_NEST },
  );

  // …and the same scene in play: a populated board with a power-up on it,
  // mid-bob, at gameplay scale.
  await setScene(
    page,
    'high',
    [
      { kind: 'player', playerIndex: 0, tx: 4, ty: 10, id: 0, dir: 0 },
      { enemyType: 'basic', tx: 2, ty: 4, ordinal: 1, dir: 2 },
      { enemyType: 'fast', tx: 9, ty: 3, ordinal: 2, dir: 1, carrier: true },
      { enemyType: 'armor', tx: 6, ty: 6, hp: 4, ordinal: 3, dir: 2 },
    ],
    [
      ...BASE_NEST,
      [3, 7, 'B'],
      [4, 7, 'B'],
      [8, 7, 'S'],
      [9, 7, 'S'],
      [1, 9, 'T'],
      [11, 5, 'W'],
    ],
  );
  await page.evaluate(() => {
    const H = (globalThis as unknown as { H: RigProps }).H;
    H.powerup('helmet', 8, 9);
    H.bullet(4 * 16 + 6, 9 * 16, 0);
    // Mid-bob and mid-spin: 400 ms is a third of art §9's 1.2 s arc.
    H.advance(400, 8);
  });
  await shot(page, 'play-powerup');

  // --- draw calls ---------------------------------------------------------
  results.drawCalls = await page.evaluate(() => {
    const H = (
      globalThis as unknown as {
        H: {
          init(q: string): void;
          tank(o: Record<string, unknown>): unknown;
          bullet(x: number, y: number, d: number): void;
          powerup(type: string | null, tx?: number, ty?: number): void;
          render(d?: number): void;
          calls(): number;
          resetCalls(): void;
        };
      }
    ).H;
    const count = (quality: string, populate: () => void): number => {
      H.init(quality);
      populate();
      H.render(0); // warm-up: shader compilation and the first upload
      H.resetCalls();
      H.render(0);
      return H.calls();
    };
    const none = (): void => undefined;
    // Worst case: two players and four DISTINCT enemy types alive at once, so
    // all six tank materials draw — plus both of art §8's shared emissive
    // meshes, which only draw while something is spawning (the star) or
    // somebody is at tier 3 (the tip), plus T3.3's two prop meshes, which draw
    // whenever there is a base (always) and a power-up on the field.
    const worst = (): void => {
      H.tank({ kind: 'player', playerIndex: 0, tx: 0, ty: 6, id: 0, tier: 3 });
      H.tank({ kind: 'player', playerIndex: 1, tx: 2, ty: 6, id: 1 });
      H.tank({ enemyType: 'basic', tx: 4, ty: 6, ordinal: 1, spawningT: 1.3 });
      H.tank({ enemyType: 'fast', tx: 6, ty: 6, ordinal: 2 });
      H.tank({ enemyType: 'power', tx: 8, ty: 6, ordinal: 3 });
      H.tank({ enemyType: 'armor', tx: 10, ty: 6, hp: 4, ordinal: 4 });
      for (let i = 0; i < 4; i++) H.bullet(40 + i * 20, 100, 0);
      H.powerup('star', 3, 9);
    };
    // Typical: enemies share a type most of the time, and there is no power-up
    // on the field — so the gold prop mesh is at `count === 0` and draws
    // nothing, exactly like the two emissive tank meshes.
    const typical = (): void => {
      H.tank({ kind: 'player', playerIndex: 0, tx: 0, ty: 6, id: 0 });
      for (let i = 0; i < 4; i++) {
        H.tank({ enemyType: 'basic', tx: 4 + i * 2, ty: 6, ordinal: i + 1 });
      }
      H.bullet(40, 100, 0);
    };
    return {
      highEmpty: count('high', none),
      highTypical: count('high', typical),
      highWorst: count('high', worst),
      lowEmpty: count('low', none),
      lowTypical: count('low', typical),
      lowWorst: count('low', worst),
    };
  });

  // --- steady state -------------------------------------------------------
  results.steadyState = await page.evaluate(() => {
    const H = (
      globalThis as unknown as {
        H: {
          init(q: string): void;
          tank(o: Record<string, unknown>): unknown;
          bullet(x: number, y: number, d: number): void;
          render(d?: number): void;
          state: { tanks: { alive: boolean; x: number; prevX: number }[] };
          adds(): number;
          resetAdds(): void;
        };
      }
    ).H;
    H.init('high');
    H.tank({
      kind: 'player',
      playerIndex: 0,
      tx: 0,
      ty: 6,
      id: 0,
      moving: true,
      shieldT: 3,
    });
    H.tank({
      enemyType: 'armor',
      tx: 4,
      ty: 6,
      hp: 4,
      ordinal: 1,
      moving: true,
    });
    H.tank({
      enemyType: 'fast',
      tx: 8,
      ty: 6,
      ordinal: 2,
      moving: true,
      carrier: true,
    });
    H.bullet(40, 100, 0);
    H.render(16);
    H.resetAdds();
    const t0 = performance.now();
    for (let i = 0; i < 240; i++) {
      for (const t of H.state.tanks) {
        if (!t.alive) continue;
        t.prevX = t.x;
        t.x += 0.5;
      }
      H.render(16);
    }
    return {
      objectAdds: H.adds(),
      msPerFrame: (performance.now() - t0) / 240,
    };
  });

  // --- grayscale separation, concealment, the mid-pool death ---------------
  const measured = await page.evaluate(() => {
    const H = (
      globalThis as unknown as {
        H: {
          init(q: string, t?: [number, number, string][]): void;
          tank(o: Record<string, unknown>): Record<string, unknown>;
          render(d?: number): void;
          pixels(): { w: number; h: number; data: Uint8Array };
        };
      }
    ).H;
    /** Max per-channel difference above which a pixel counts as changed. */
    const THRESH = 16;

    interface Mask {
      m: Uint8Array;
      n: number;
      lum: Float32Array;
      hPx: number;
    }
    /**
     * The tank's own silhouette, at Low so shadows are off — a canopy does not
     * hide a shadow, and a shadow is not part of a silhouette.
     */
    const maskOf = (
      spec: Record<string, unknown>,
      terrain: [number, number, string][] = [],
    ): Mask => {
      H.init('low', terrain);
      H.render(0);
      const empty = H.pixels();
      H.tank({ ...spec, tx: 6, ty: 6 });
      H.render(0);
      const shown = H.pixels();
      const m = new Uint8Array(empty.data.length / 4);
      const lum = new Float32Array(m.length);
      let n = 0;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < m.length; i++) {
        const j = i * 4;
        lum[i] =
          0.2126 * shown.data[j] +
          0.7152 * shown.data[j + 1] +
          0.0722 * shown.data[j + 2];
        const d = Math.max(
          Math.abs(empty.data[j] - shown.data[j]),
          Math.abs(empty.data[j + 1] - shown.data[j + 1]),
          Math.abs(empty.data[j + 2] - shown.data[j + 2]),
        );
        if (d > THRESH) {
          m[i] = 1;
          n++;
          const row = Math.floor(i / empty.w);
          if (row < y0) y0 = row;
          if (row > y1) y1 = row;
        }
      }
      return { m, n, lum, hPx: y1 - y0 + 1 };
    };

    const TYPES: [string, Record<string, unknown>][] = [
      ['p1', { kind: 'player', playerIndex: 0, id: 0 }],
      ['basic', { enemyType: 'basic' }],
      ['fast', { enemyType: 'fast' }],
      ['power', { enemyType: 'power' }],
      ['armor', { enemyType: 'armor', hp: 4 }],
    ];
    const names = TYPES.map(([n]) => n);

    // Both facings, because art §4's ruling on Power rests on a barrel reading
    // from every facing while turret height does not. Up is the tightest case
    // (a barrel points away from the camera and foreshortens); east is the
    // loosest (x is unforeshortened under a yaw-0 camera).
    const silhouette: Record<string, unknown> = {};
    for (const [facing, dir] of [
      ['up', 0],
      ['east', 1],
    ] as [string, number][]) {
      const masks: Record<string, Mask> = {};
      for (const [name, spec] of TYPES) masks[name] = maskOf({ ...spec, dir });

      const pairs: Record<string, unknown> = {};
      for (const a of names) {
        for (const b of names) {
          if (a >= b) continue;
          let inter = 0;
          let uni = 0;
          let sum = 0;
          let strong = 0;
          for (let i = 0; i < masks[a].m.length; i++) {
            const x = masks[a].m[i];
            const y = masks[b].m[i];
            if (x | y) {
              uni++;
              const d = Math.abs(masks[a].lum[i] - masks[b].lum[i]);
              sum += d;
              if (d > 40) strong++;
            }
            if (x & y) inter++;
          }
          pairs[`${a}|${b}`] = {
            // Outlines SHOULD overlap: art §4 gives every type the same 16×16
            // footprint. What separates them is what is inside, which is the
            // next two columns.
            outlineIouPct: +((inter / uni) * 100).toFixed(1),
            grayMeanDelta: +(sum / uni).toFixed(1),
            // …and how much of the shape is unambiguously different (>40 of
            // 255). A mean under-reports a localised cue like Power's brake.
            strongDiffPct: +((strong / uni) * 100).toFixed(1),
          };
        }
      }
      const areaPx: Record<string, number> = {};
      const screenHeightPx: Record<string, number> = {};
      for (const n of names) {
        areaPx[n] = masks[n].n;
        screenHeightPx[n] = masks[n].hPx;
      }
      silhouette[facing] = { areaPx, screenHeightPx, pairs };
    }

    // --- concealment: art §5's canopy against a 12 u Armor tank -------------
    const TREE: [number, number, string][] = [[6, 6, 'T']];
    const concealment: Record<string, unknown> = {};
    for (const [name, spec] of [
      ['armor12u', { enemyType: 'armor', hp: 4, ordinal: 1 }],
      ['player10u', { kind: 'player', playerIndex: 0, id: 0 }],
      ['basic10u', { enemyType: 'basic', ordinal: 1 }],
    ] as [string, Record<string, unknown>][]) {
      const open = maskOf(spec).n;
      const under = maskOf(spec, TREE).n;
      concealment[name] = {
        openPx: open,
        underPx: under,
        concealedPct: +((1 - under / open) * 100).toFixed(2),
      };
    }

    // --- a mid-pool death, in pixels ---------------------------------------
    H.init('low');
    const made: Record<string, unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      made.push(
        H.tank({ enemyType: 'basic', tx: 1 + i * 3, ty: 6, ordinal: i + 1 }),
      );
    }
    H.render(0);
    // Four different distances, chosen so their tread PARITIES differ too.
    for (let f = 0; f < 4; f++) {
      for (let i = 0; i < made.length; i++) {
        made[i].prevX = made[i].x;
        (made[i].x as number) = (made[i].x as number) + (i + 1) * 5;
      }
      H.render(16);
    }
    const before = H.pixels();
    made[1].alive = false;
    // dt 0 and no movement: nothing else in the scene has any reason to change,
    // so a changed pixel outside the dead tank's column is a state migration.
    H.render(0);
    const after = H.pixels();
    const lo = ((made[0].x as number) + (made[1].x as number)) / 2 + 8;
    const hi = ((made[1].x as number) + (made[2].x as number)) / 2 + 8;
    // The frustum fits the 224 u board-plus-frame to the short axis.
    const uPerPx = 224 / before.w;
    const originU = -(224 - 208) / 2;
    let changed = 0;
    let outside = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      const d = Math.max(
        Math.abs(before.data[i] - after.data[i]),
        Math.abs(before.data[i + 1] - after.data[i + 1]),
        Math.abs(before.data[i + 2] - after.data[i + 2]),
      );
      if (d <= THRESH) continue;
      changed++;
      const worldX = originU + ((i / 4) % before.w) * uPerPx;
      if (worldX < lo || worldX > hi) outside++;
    }

    return {
      silhouette,
      concealment,
      midPoolDeath: {
        changedPx: changed,
        changedOutsideTheDeadTankPx: outside,
      },
    };
  });
  results.silhouette = measured.silhouette as Results['silhouette'];

  results.concealment = measured.concealment as Results['concealment'];
  results.midPoolDeath = measured.midPoolDeath;
  await page.close();

  // --- detail crops -------------------------------------------------------
  const detail = await browser.newPage({ viewport: { width: DW, height: DH } });
  await detail.addInitScript(() => {
    (globalThis as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
  });
  await detail.goto(URL, { waitUntil: 'load', timeout: 20_000 });
  await detail.evaluate(installRig);

  await setScene(detail, 'high', lineUp());
  await shot(detail, 'detail-lineup-colour', ROW);
  await shot(detail, 'detail-lineup-grayscale', ROW, true);

  // Turned east, where the barrels read side-on and P2 shows its tier rings.
  await setScene(detail, 'high', lineUp(1, 3));
  await shot(detail, 'detail-facing-right', ROW);
  await shot(detail, 'detail-facing-right-grayscale', ROW, true);

  await setScene(
    detail,
    'high',
    ([0, 1, 2, 3] as const).map((tier) => ({
      kind: 'player' as const,
      playerIndex: 0 as const,
      tx: 1 + tier * 3,
      ty: 6,
      tier,
    })),
  );
  await shot(detail, 'detail-tiers', ROW);

  await setScene(
    detail,
    'high',
    [0, 1, 2, 3].map((i) => ({
      enemyType: 'armor' as const,
      tx: 1 + i * 3,
      ty: 6,
      hp: 4 - i,
      ordinal: i + 1,
    })),
  );
  await detail.evaluate(() => {
    (
      globalThis as unknown as { H: { advance(ms: number, n: number): void } }
    ).H.advance(400, 8);
  });
  await shot(detail, 'detail-armor-hp', ROW);

  await setScene(detail, 'high', [
    { enemyType: 'basic', tx: 2, ty: 6, ordinal: 1, spawningT: 1.3 },
    { kind: 'player', playerIndex: 0, tx: 5, ty: 6, shieldT: 3, id: 0 },
    { kind: 'player', playerIndex: 1, tx: 8, ty: 6, stunT: 3, id: 1 },
    { enemyType: 'basic', tx: 11, ty: 6, ordinal: 4, carrier: true },
  ]);
  await detail.evaluate(() => {
    (
      globalThis as unknown as { H: { advance(ms: number, n: number): void } }
    ).H.advance(200, 8);
  });
  await shot(detail, 'detail-overlays', ROW);

  // Recoil: at rest, then at the 24 ms peak of art §9's 80 ms out-back curve.
  await setScene(detail, 'high', [
    { kind: 'player', playerIndex: 0, tx: 3, ty: 6, id: 0, dir: 1 },
    { enemyType: 'power', tx: 8, ty: 6, ordinal: 3, dir: 1 },
  ]);
  await shot(detail, 'detail-recoil-rest', ROW);
  await detail.evaluate(() => {
    const H = (
      globalThis as unknown as {
        H: {
          state: { tanks: { alive: boolean; id: number }[] };
          event(e: unknown): void;
          advance(ms: number, n: number): void;
          bullet(x: number, y: number, d: number): void;
        };
      }
    ).H;
    for (const t of H.state.tanks) {
      if (!t.alive) continue;
      H.event({
        t: 'shotFired',
        tankId: t.id,
        x: 0,
        y: 0,
        dir: 1,
        byPlayer: true,
      });
    }
    H.advance(24, 1);
    H.bullet(3 * 16 + 40, 6 * 16 + 6, 1);
    H.bullet(8 * 16 + 60, 6 * 16 + 6, 1);
  });
  await shot(detail, 'detail-recoil-peak', ROW);

  // Track scroll: two consecutive visual steps, 8 u apart (art §9).
  await setScene(detail, 'high', [
    {
      kind: 'player',
      playerIndex: 0,
      tx: 3,
      ty: 6,
      id: 0,
      dir: 1,
      moving: true,
    },
  ]);
  for (const step of [1, 2]) {
    await detail.evaluate(() => {
      const H = (
        globalThis as unknown as {
          H: {
            state: { tanks: { alive: boolean; y: number; prevY: number }[] };
            render(d?: number): void;
          };
        }
      ).H;
      const a = H.state.tanks.find((t) => t.alive);
      if (a === undefined) throw new Error('no live tank');
      a.prevY = a.y;
      a.y += 8;
      H.render(16);
    });
    await shot(detail, `detail-tracks-step${step}`, ROW);
  }

  // Concealment, visually: Armor under a canopy, a player under a canopy, and
  // an Armor tank in the open for comparison.
  await setScene(
    detail,
    'high',
    [
      { enemyType: 'armor', tx: 5, ty: 6, hp: 4, ordinal: 1 },
      { kind: 'player', playerIndex: 0, tx: 8, ty: 6, id: 0 },
      { enemyType: 'armor', tx: 11, ty: 6, hp: 4, ordinal: 2 },
    ],
    [
      [5, 6, 'T'],
      [8, 6, 'T'],
    ],
  );
  await shot(detail, 'detail-canopy-armor', ROW);

  // T3.3: the eagle, close enough to read the emblem and the break. The full
  // frames above are the deliverable — "does defending the base feel right" is
  // a gameplay-scale question — and these are the follow-up.
  for (const alive of [true, false]) {
    await setScene(detail, 'high', [], BASE_NEST);
    await detail.evaluate((a: boolean) => {
      (globalThis as unknown as { H: RigProps }).H.eagle(a);
    }, alive);
    await shot(
      detail,
      alive ? 'detail-eagle-intact' : 'detail-eagle-destroyed',
      EAGLE_DETAIL,
    );
    await shot(
      detail,
      alive
        ? 'detail-eagle-intact-grayscale'
        : 'detail-eagle-destroyed-grayscale',
      EAGLE_DETAIL,
      true,
    );
  }
  await detail.close();

  // --- the REAL dev preview's console, at DPR 1 / 2 / 3 -------------------
  results.previewConsole = {};
  for (const dpr of [1, 2, 3]) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: dpr,
    });
    const p = await ctx.newPage();
    const noise: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        noise.push(`${m.type()}: ${m.text()}`);
      }
    });
    p.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));
    await p.goto(URL, { waitUntil: 'load', timeout: 20_000 });
    await p.waitForTimeout(5000);
    if (dpr === 2) await p.screenshot({ path: join(OUT, 'preview-live.png') });
    results.previewConsole[`dpr${dpr}`] = noise.length > 0 ? noise : '(clean)';
    await ctx.close();
  }

  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nscreenshots + results.json → ${OUT}\n`);
  console.table(results.drawCalls);
  for (const facing of Object.keys(results.silhouette)) {
    console.log(`
silhouette separation — facing ${facing}`);
    console.table(results.silhouette[facing].pairs);
  }
  console.table(results.concealment);
  console.log('\npower-up separation (art §11 bar, same as the tanks)');
  console.table(results.props.powerupPairs);
  console.log('power-up lit area, px:', results.props.powerupAreaPx);
  console.log('eagle intact vs destroyed:', results.props.eagleLoss);
  console.log('steady state:', results.steadyState);
  console.log('mid-pool death:', results.midPoolDeath);
  console.log('dev preview console:', results.previewConsole);

  await browser.close();
}

await main();
