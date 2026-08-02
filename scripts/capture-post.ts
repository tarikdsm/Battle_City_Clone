// scripts/capture-post.ts — the visual-verification harness for the post chain:
// art §7's three presets, the selective-bloom proof, the vignette/grade budget
// and what the chain costs per frame.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:post
//
// PNGs go to `.superpowers/sdd/screens-T2.5/` (POST_SHOTS overrides) and the
// numbers to **`docs/calibration/post.json`**, which is committed for the same
// reason `lighting.json` is: art §7 is amended on the strength of these numbers
// (the bloom threshold), and a measurement that lives only in a task report
// cannot be re-checked later.
//
// NOT `test-results/` — Playwright owns and wipes it at the start of every run.
//
// ## Why this composes the render layer itself
//
// `capture-entities.ts` drives the shipped `createRenderer`, and this script
// still does for the one thing only the shipped composition can answer (the dev
// preview's console at each preset). But the central claim here — *only the
// emissive layer blooms* — needs the SAME frame rendered with the bloom pass on
// and off, and `Renderer` has no switch for that and should not grow one. So
// the rig composes `createMaterials` + `createSceneRoot` + the three views +
// `createPostChain` directly, the way `calibrate-lighting.ts` composes the
// lighting rig, and mirrors `renderer.ts`'s GL settings verbatim.

import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const SHOTS =
  process.env.POST_SHOTS ?? join('.superpowers', 'sdd', 'screens-T2.5');
const OUT = process.env.POST_OUT ?? join('docs', 'calibration', 'post.json');

const W = 1600;
const H = 900;

/** How far from an emissive a changed pixel may be and still count as its glow. */
const DISC_R = 140;

interface Delta {
  /** Pixels whose max channel moved by more than 2/255. */
  changedPx: number;
  /** …and by more than 16/255 — a visible change, not a rounding wobble. */
  strongPx: number;
  /** Of those, how many lie outside every emissive's disc. */
  changedAwayFromEmissivePx: number;
  strongAwayFromEmissivePx: number;
  /** Largest single-channel change anywhere outside the discs. */
  maxDeltaAwayFromEmissive: number;
}

interface Results {
  note: string;
  viewport: { width: number; height: number };
  /** Art §7's bloom threshold against what this scene can actually reach. */
  bloomThreshold: {
    art7: number;
    shipped: number;
    /** Emissive luminance of each material, linear — what the high-pass sees. */
    sourceLuminanceLinear: Record<string, number>;
    /** Peak luminance in the finished High frame, display sRGB. */
    screenPeak: Record<string, number>;
    verdict: string;
  };
  /** The proof: bloom on vs off, same frame, same chain. */
  bloomProof: {
    emissiveDiscRadiusPx: number;
    /** A tier-3 player + a spawning enemy: the two things art §8 lets glow. */
    withEmissives: Delta;
    /** Brick, steel, six tank bodies, a carrier pulse and two tracers — nothing
     *  on the bloom layer. Every count here must be 0. */
    withoutEmissives: Delta;
  };
  /** Vignette + grade, measured rather than eyeballed. */
  vignette: {
    /** Post-on ÷ post-off luminance along the mid scanline, by x fraction. */
    profile: Record<string, number>;
    /**
     * The number art §7's "must not read darker at the corners than the terrain
     * contrast can afford" is actually about: post-on ÷ post-off at the four
     * **playfield** corners and its centre, averaged over a 9×9 window.
     */
    boardCorners: Record<string, number>;
    /** Local contrast (brightest ÷ darkest of the same two pixels). */
    cornerContrastOff: number;
    cornerContrastOn: number;
    centreContrastOff: number;
    centreContrastOn: number;
  };
  /** Draw calls and render CPU per frame, chain off vs on (arch §11). */
  cost: Record<string, { drawCalls: number; msPerFrame: number }>;
  /** `Object3D.add` calls over 240 steady-state frames with the chain on. */
  steadyStateAdds: number;
  /** Live GL objects around six preset switches — a leak climbs. */
  presetSwitch: {
    texturesBefore: number;
    texturesAfter: number;
    geometriesBefore: number;
    geometriesAfter: number;
  };
  /** The REAL dev preview at `?quality=…`, one entry per preset. */
  previewConsole: Record<string, string[] | string>;
}

/** A tank the rig puts on the field. Mirrors `Tank` minus the AI bookkeeping. */
type TankSpec = Record<string, unknown>;

/**
 * Installs `globalThis.P`, the page-side rig. Everything below runs in the
 * browser, so it may only use what the page has: the Vite-served sources and
 * the DOM. The module-shaped fields are typed structurally rather than imported
 * — the import specifiers are dynamic on purpose (see `urls`), so there are no
 * types to import, and a structural type still catches a misspelt call here.
 */
async function installRig(): Promise<void> {
  // Held in variables rather than written as literals so tsc treats them as
  // dynamic — a literal would be resolved against the Node program and fail.
  const urls = {
    core: '/src/core/game.ts',
    materials: '/src/render/materials.ts',
    sceneRoot: '/src/render/sceneRoot.ts',
    terrainView: '/src/render/terrainView.ts',
    tankView: '/src/render/tankView.ts',
    bulletView: '/src/render/bulletView.ts',
    post: '/src/render/post.ts',
  };
  const core = await import(urls.core);
  const matsMod = await import(urls.materials);
  const rootMod = await import(urls.sceneRoot);
  const terrainMod = await import(urls.terrainView);
  const tankMod = await import(urls.tankView);
  const bulletMod = await import(urls.bulletView);
  const postMod = await import(urls.post);
  const threeUrl = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/deps/three.js'));
  if (threeUrl === undefined) throw new Error('three module URL not found');
  const THREE = await import(threeUrl);

  // Instrumentation on the prototypes, so nothing is added to production code.
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

  interface GL {
    render(scene: unknown, camera: unknown): void;
    dispose(): void;
    forceContextLoss(): void;
    shadowMap: { enabled: boolean; type: unknown };
    setPixelRatio(r: number): void;
    setSize(w: number, h: number, updateStyle: boolean): void;
    info: { memory: { textures: number; geometries: number } };
  }
  interface Root {
    scene: unknown;
    camera: { projectionMatrix: unknown };
    setViewport(w: number, h: number): void;
    setShadowQuality(preset: unknown): void;
    dispose(): void;
  }
  interface Chain {
    setPreset(preset: unknown): void;
    setSize(w: number, h: number): void;
    render(): void;
    dispose(): void;
  }
  interface Views {
    terrain: {
      build(s: unknown): void;
      update(dt: number): void;
      dispose(): void;
    };
    tanks: {
      update(s: unknown, alpha: number, dt: number): void;
      dispose(): void;
    };
    bullets: { update(s: unknown, alpha: number): void; dispose(): void };
  }
  interface Mats {
    all: { needsUpdate: boolean }[];
    dispose(): void;
  }
  interface State {
    tanks: { alive: boolean; x: number; prevX: number }[];
    bullets: unknown[];
  }

  const rows = (spec: [number, number, string][]): string[] => {
    const g = Array.from({ length: 13 }, () => '.............'.split(''));
    for (const [tx, ty, ch] of spec) g[ty][tx] = ch;
    return g.map((r) => r.join(''));
  };

  const P = {
    gl: undefined as unknown as GL,
    canvas: undefined as unknown as HTMLCanvasElement,
    root: undefined as unknown as Root,
    chain: undefined as unknown as Chain,
    mats: undefined as unknown as Mats,
    views: undefined as unknown as Views,
    state: undefined as unknown as State,
    quality: 'high',
    nextId: 10,

    calls: (): number => calls,
    resetCalls: (): void => {
      calls = 0;
    },
    adds: (): number => adds,
    resetAdds: (): void => {
      adds = 0;
    },

    /**
     * A fresh direct rig. Mirrors `renderer.ts`'s WebGL settings verbatim —
     * tone mapping, exposure, shadow type and clear colour are all part of what
     * art §6 calibrated, so a rig that guessed any of them would be measuring a
     * different game.
     */
    init(quality: string, terrain?: [number, number, string][]): void {
      if (P.chain !== undefined) {
        P.chain.dispose();
        P.views.tanks.dispose();
        P.views.bullets.dispose();
        P.views.terrain.dispose();
        P.root.dispose();
        P.mats.dispose();
        P.gl.dispose();
        // `dispose()` frees three's objects but leaves the WebGL context alive,
        // and this rig builds a dozen of them in one page — past ~16 the
        // browser starts killing the OLDEST context, which is a live one. This
        // hands each context back explicitly instead.
        P.gl.forceContextLoss();
      }
      document.querySelectorAll('canvas.rig').forEach((c) => {
        c.remove();
      });

      const canvas = document.createElement('canvas');
      canvas.className = 'rig';
      canvas.style.cssText =
        `position:fixed;left:0;top:0;` +
        `width:${innerWidth}px;height:${innerHeight}px;z-index:99;`;
      document.body.append(canvas);
      P.canvas = canvas;

      const gl = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
      gl.outputColorSpace = THREE.SRGBColorSpace;
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.toneMappingExposure = matsMod.CALIBRATION.toneMappingExposure;
      gl.shadowMap.type = THREE.PCFShadowMap;
      gl.setClearColor(0x0a0a0a, 1);
      P.gl = gl as GL;

      const mats = matsMod.createMaterials();
      const root = rootMod.createSceneRoot(mats);
      P.mats = mats as Mats;
      P.root = root as Root;
      P.views = {
        terrain: terrainMod.createTerrainView(mats, root),
        tanks: tankMod.createTankView(mats, root),
        bullets: bulletMod.createBulletView(mats, root),
      } as Views;
      P.chain = postMod.createPostChain(gl, root.scene, root.camera) as Chain;

      P.state = core.createGame(
        {
          version: 1,
          id: 'capture-post',
          name: 'capture-post',
          terrain: rows(terrain ?? []),
          enemies: Array.from({ length: 20 }, () => 'basic'),
          noAutoBase: true,
        },
        { players: 2, seed: 1, stageNumber: 1 },
      ) as State;
      // The rig owns the field: the simulation is never stepped, so nothing
      // moves except what these helpers write.
      for (const t of P.state.tanks) {
        t.alive = false;
      }
      P.nextId = 10;
      P.setQuality(quality);
    },

    /** The same four moves `renderer.ts` makes on a preset change. */
    setQuality(quality: string): void {
      P.quality = quality;
      const preset = matsMod.QUALITY_PRESETS[quality];
      if (P.gl.shadowMap.enabled !== preset.shadows) {
        P.gl.shadowMap.enabled = preset.shadows;
        for (const m of P.mats.all) {
          m.needsUpdate = true;
        }
      }
      P.root.setShadowQuality(preset);
      P.gl.setPixelRatio(Math.min(devicePixelRatio || 1, preset.dprCap));
      P.gl.setSize(innerWidth, innerHeight, true);
      P.root.setViewport(innerWidth, innerHeight);
      P.chain.setPreset(postMod.POST_PRESETS[quality]);
      P.chain.setSize(innerWidth, innerHeight);
    },

    /** Patches the current preset — used to isolate one effect at a time. */
    setPostOverride(patch: Record<string, unknown> | null): void {
      const base = postMod.POST_PRESETS[P.quality];
      P.chain.setPreset(patch === null ? base : { ...base, ...patch });
      P.chain.setSize(innerWidth, innerHeight);
    },

    tank(o: TankSpec): TankSpec {
      const tx = o.tx as number;
      const ty = o.ty as number;
      const t: TankSpec = {
        id: (o.id as number | undefined) ?? P.nextId++,
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
      (P.state.tanks as unknown as TankSpec[]).push(t);
      return t;
    },

    bullet(x: number, y: number, dir: number): void {
      P.state.bullets.push({
        id: P.state.bullets.length,
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

    /** One frame. `post: false` stops at the beauty pass — the T2.4 render. */
    frame(dt = 0, post = true): void {
      P.views.terrain.build(P.state);
      P.views.terrain.update(dt);
      P.views.tanks.update(P.state, 1, dt);
      P.views.bullets.update(P.state, 1);
      P.gl.render(P.root.scene, P.root.camera);
      if (post) P.chain.render();
    },

    /** The drawing buffer, read back so nothing depends on the compositor. */
    pixels(): { w: number; h: number; data: Uint8Array } {
      const ctx = P.canvas.getContext('webgl2');
      if (ctx === null) throw new Error('no webgl2 context');
      const w = ctx.drawingBufferWidth;
      const h = ctx.drawingBufferHeight;
      const data = new Uint8Array(w * h * 4);
      ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, data);
      return { w, h, data };
    },

    /** World → drawing-buffer pixel, through the real camera. */
    project(x: number, y: number, z: number): [number, number] {
      const ctx = P.canvas.getContext('webgl2');
      if (ctx === null) throw new Error('no webgl2 context');
      const v = new THREE.Vector3(x, y, z);
      v.project(P.root.camera);
      return [
        Math.round(((v.x + 1) / 2) * ctx.drawingBufferWidth),
        Math.round(((v.y + 1) / 2) * ctx.drawingBufferHeight),
      ];
    },
  };
  (globalThis as unknown as { P: typeof P }).P = P;
}

/**
 * The rig's shape, Node-side. `page.evaluate` serialises its callback, so this
 * type never crosses over — it only keeps the calls below honest.
 */
interface Rig {
  init(q: string, t?: [number, number, string][]): void;
  setQuality(q: string): void;
  setPostOverride(p: Record<string, unknown> | null): void;
  tank(o: TankSpec): TankSpec;
  bullet(x: number, y: number, d: number): void;
  frame(dt?: number, post?: boolean): void;
  pixels(): { w: number; h: number; data: Uint8Array };
  project(x: number, y: number, z: number): [number, number];
  calls(): number;
  resetCalls(): void;
  adds(): number;
  resetAdds(): void;
  gl: { info: { memory: { textures: number; geometries: number } } };
  state: { tanks: { alive: boolean; x: number; prevX: number }[] };
}

async function shot(page: Page, name: string): Promise<void> {
  // One composite after the render, so the screenshot captures this frame.
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The board every full-frame shot uses — all six terrain kinds, art §5. */
const BOARD_ROWS: readonly string[] = [
  '...B.....B...',
  '..SS.....SS..',
  '.BBB.....BBB.',
  '.B.........B.',
  '.B..WWWWW..B.',
  '....W...W....',
  'TTT.WW.WW.TTT',
  '....W...W....',
  'IIII.....IIII',
  '.S.........S.',
  '.S...BBB...S.',
  '.....B.B.....',
  '.............',
];

const FULL_BOARD: [number, number, string][] = [];
for (let ty = 0; ty < BOARD_ROWS.length; ty++) {
  for (let tx = 0; tx < BOARD_ROWS[ty].length; tx++) {
    const ch = BOARD_ROWS[ty][tx];
    if (ch !== '.') FULL_BOARD.push([tx, ty, ch]);
  }
}

/** The bloom test board: brick and steel either side, nothing emissive. */
const PROOF_TERRAIN: [number, number, string][] = [
  [2, 4, 'B'],
  [4, 4, 'S'],
  [10, 4, 'B'],
  [12, 4, 'S'],
];

/** A tier-3 player and a spawning enemy: the ONLY two things art §8 lets glow. */
const EMISSIVE_SCENE: TankSpec[] = [
  { kind: 'player', playerIndex: 0, tx: 3, ty: 6, id: 0, tier: 3, dir: 1 },
  { enemyType: 'basic', tx: 9, ty: 6, ordinal: 1, spawningT: 1.3 },
];

/** Everything bright that must NOT glow: bodies, carrier pulse, tracers. */
const NON_EMISSIVE_SCENE: TankSpec[] = [
  { kind: 'player', playerIndex: 0, tx: 1, ty: 6, id: 0, dir: 1 },
  { kind: 'player', playerIndex: 1, tx: 3, ty: 6, id: 1, dir: 1 },
  { enemyType: 'basic', tx: 5, ty: 6, ordinal: 1, carrier: true },
  { enemyType: 'fast', tx: 7, ty: 6, ordinal: 2 },
  { enemyType: 'power', tx: 9, ty: 6, ordinal: 3 },
  { enemyType: 'armor', tx: 11, ty: 6, hp: 4, ordinal: 4 },
];

/** The populated board the preset shots and the cost table share. */
function populate(P: Rig): void {
  P.tank({
    kind: 'player',
    playerIndex: 0,
    tx: 6,
    ty: 11,
    id: 0,
    tier: 3,
    dir: 0,
    moving: true,
  });
  P.tank({ kind: 'player', playerIndex: 1, tx: 8, ty: 11, id: 1, dir: 0 });
  P.tank({ enemyType: 'basic', tx: 0, ty: 0, ordinal: 1, spawningT: 1.3 });
  P.tank({ enemyType: 'fast', tx: 6, ty: 0, ordinal: 2, dir: 2, moving: true });
  P.tank({ enemyType: 'power', tx: 12, ty: 0, ordinal: 3, dir: 2 });
  P.tank({
    enemyType: 'armor',
    tx: 2,
    ty: 3,
    hp: 4,
    ordinal: 4,
    dir: 1,
    carrier: true,
  });
  P.bullet(6 * 16 + 8, 9 * 16, 0);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });

  const results = { viewport: { width: W, height: H } } as Results;

  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const noise: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      noise.push(`${m.type()}: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    // tsx compiles this file with esbuild's `keepNames`, which wraps every
    // function in a `__name(...)` call — a helper that exists only in the Node
    // bundle, so the browser needs an identity stand-in.
    (globalThis as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
  });
  await page.goto(URL, { waitUntil: 'load', timeout: 20_000 }).catch(() => {
    throw new Error(`cannot reach ${URL} — is \`npm run dev\` running?`);
  });
  // Vite discovers `three/addons/*` on the first load of a cold dev server,
  // pre-bundles them, and then **force-reloads the page** — which destroys the
  // execution context in the middle of whatever `evaluate` is running. One
  // deliberate reload against a now-warm cache costs a second and removes a
  // failure that only ever appears on a fresh clone.
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'load', timeout: 20_000 });
  await page.evaluate(installRig);

  // --- 1. the same full board at each preset, plus the chain-off control ----
  for (const quality of ['high', 'medium', 'low']) {
    await page.evaluate(
      (a: { quality: string; board: [number, number, string][] }) => {
        const P = (globalThis as unknown as { P: Rig }).P;
        P.init(a.quality, a.board);
        P.tank({
          kind: 'player',
          playerIndex: 0,
          tx: 6,
          ty: 11,
          id: 0,
          tier: 3,
          dir: 0,
        });
        P.tank({
          kind: 'player',
          playerIndex: 1,
          tx: 8,
          ty: 11,
          id: 1,
          dir: 0,
        });
        P.tank({
          enemyType: 'basic',
          tx: 0,
          ty: 0,
          ordinal: 1,
          spawningT: 1.3,
        });
        P.tank({ enemyType: 'fast', tx: 6, ty: 0, ordinal: 2, dir: 2 });
        P.tank({ enemyType: 'power', tx: 12, ty: 0, ordinal: 3, dir: 2 });
        P.tank({
          enemyType: 'armor',
          tx: 2,
          ty: 3,
          hp: 4,
          ordinal: 4,
          dir: 1,
          carrier: true,
        });
        P.bullet(6 * 16 + 8, 9 * 16, 0);
        P.frame(200);
        P.frame(0);
      },
      { quality, board: FULL_BOARD },
    );
    await shot(page, `board-${quality}`);
    if (quality === 'high') {
      await page.evaluate(() => {
        (globalThis as unknown as { P: Rig }).P.frame(0, false);
      });
      await shot(page, 'board-high-post-off');
    }
  }

  // --- 2. the bloom proof --------------------------------------------------
  results.bloomProof = await page.evaluate(
    (a: {
      emissive: TankSpec[];
      plain: TankSpec[];
      terrain: [number, number, string][];
      R: number;
    }) => {
      const P = (globalThis as unknown as { P: Rig }).P;

      const measure = (
        tanks: TankSpec[],
        discs: [number, number][],
        withBullets: boolean,
      ): Delta => {
        P.init('high', a.terrain);
        for (const t of tanks) P.tank(t);
        if (withBullets) {
          P.bullet(4 * 16 + 8, 8 * 16, 0);
          P.bullet(8 * 16 + 8, 8 * 16, 0);
        }
        // Past the spawn animation's first frames so the star is at full size.
        P.frame(200);

        // Bloom OFF: same chain, same scene, bloom pass removed.
        P.setPostOverride({ bloom: null });
        P.frame(0);
        const off = P.pixels();
        P.setPostOverride(null);
        P.frame(0);
        const on = P.pixels();

        const centres = discs.map(([wx, wz]) => P.project(wx, 8, wz));
        let changed = 0;
        let strong = 0;
        let changedAway = 0;
        let strongAway = 0;
        let maxAway = 0;
        for (let i = 0; i < off.data.length; i += 4) {
          const d = Math.max(
            Math.abs(off.data[i] - on.data[i]),
            Math.abs(off.data[i + 1] - on.data[i + 1]),
            Math.abs(off.data[i + 2] - on.data[i + 2]),
          );
          if (d <= 2) continue;
          const p = i / 4;
          const x = p % off.w;
          const y = Math.floor(p / off.w);
          let near = false;
          for (const c of centres) {
            if ((x - c[0]) ** 2 + (y - c[1]) ** 2 <= a.R * a.R) {
              near = true;
              break;
            }
          }
          changed++;
          if (d > 16) strong++;
          if (!near) {
            changedAway++;
            if (d > 16) strongAway++;
            if (d > maxAway) maxAway = d;
          }
        }
        return {
          changedPx: changed,
          strongPx: strong,
          changedAwayFromEmissivePx: changedAway,
          strongAwayFromEmissivePx: strongAway,
          maxDeltaAwayFromEmissive: maxAway,
        };
      };

      return {
        emissiveDiscRadiusPx: a.R,
        // Discs on the tier-3 tank's barrel tip and the spawning enemy's star.
        withEmissives: measure(
          a.emissive,
          [
            [3 * 16 + 8, 6 * 16 + 8],
            [9 * 16 + 8, 6 * 16 + 8],
          ],
          false,
        ),
        // No discs at all: every changed pixel counts as "away".
        withoutEmissives: measure(a.plain, [], true),
      };
    },
    {
      emissive: EMISSIVE_SCENE,
      plain: NON_EMISSIVE_SCENE,
      terrain: PROOF_TERRAIN,
      R: DISC_R,
    },
  );

  // The same pair, for the eye.
  await page.evaluate(
    (a: { tanks: TankSpec[]; terrain: [number, number, string][] }) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      P.init('high', a.terrain);
      for (const t of a.tanks) P.tank(t);
      P.frame(200);
      P.setPostOverride({ bloom: null });
      P.frame(0);
    },
    { tanks: EMISSIVE_SCENE, terrain: PROOF_TERRAIN },
  );
  await shot(page, 'bloom-off');
  await page.evaluate(() => {
    const P = (globalThis as unknown as { P: Rig }).P;
    P.setPostOverride(null);
    P.frame(0);
  });
  await shot(page, 'bloom-on');

  await page.evaluate(
    (a: { tanks: TankSpec[]; terrain: [number, number, string][] }) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      P.init('high', a.terrain);
      for (const t of a.tanks) P.tank(t);
      P.bullet(4 * 16 + 8, 8 * 16, 0);
      P.bullet(8 * 16 + 8, 8 * 16, 0);
      P.frame(0);
    },
    { tanks: NON_EMISSIVE_SCENE, terrain: PROOF_TERRAIN },
  );
  await shot(page, 'bloom-on-nothing-emissive');

  // --- 3. what the bloom threshold can actually reach ----------------------
  // Two questions, both answered in the BEAUTY frame — the image a full-frame
  // bloom (art §7's reading) would run its high-pass over:
  //   a) does the emissive core cross 0.85, and by how many pixels;
  //   b) does anything NON-emissive cross it — brick, steel, ice, tank bodies.
  const screenPeak = await page.evaluate(
    (a: {
      emissive: TankSpec[];
      plain: TankSpec[];
      board: [number, number, string][];
    }) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      const scan = (): { peak: number; above85: number } => {
        const px = P.pixels();
        let peak = 0;
        let above = 0;
        for (let i = 0; i < px.data.length; i += 4) {
          const l =
            (0.2126 * px.data[i] +
              0.7152 * px.data[i + 1] +
              0.0722 * px.data[i + 2]) /
            255;
          if (l > peak) peak = l;
          if (l >= 0.85) above++;
        }
        return { peak: +peak.toFixed(4), above85: above };
      };

      // A full board with every terrain kind and six tank bodies, and NOTHING
      // emissive: no tier-3 tip, no spawn star, no bullet in flight.
      P.init('high', a.board);
      for (const t of a.plain) P.tank(t);
      P.frame(0, false);
      const plain = scan();

      // The same, plus the two emissives art §8 lets glow.
      P.init('high', a.board);
      for (const t of a.emissive) P.tank(t);
      P.frame(200, false);
      P.frame(0, false);
      const withEmissives = scan();

      return {
        beautyPeakNonEmissive: plain.peak,
        beautyPixelsOver85NonEmissive: plain.above85,
        beautyPeakWithEmissives: withEmissives.peak,
        beautyPixelsOver85WithEmissives: withEmissives.above85,
      };
    },
    { emissive: EMISSIVE_SCENE, plain: NON_EMISSIVE_SCENE, board: FULL_BOARD },
  );

  const sourceLuminanceLinear = await page.evaluate(async () => {
    // Held in a variable so tsc treats the specifier as dynamic — a literal
    // would be resolved against the Node program and fail.
    const url = '/src/render/materials.ts';
    const mod = await import(url);
    const mats = mod.createMaterials();
    const lumOf = (m: {
      emissive: { r: number; g: number; b: number };
      emissiveIntensity: number;
    }): number =>
      +(
        (0.2126 * m.emissive.r +
          0.7152 * m.emissive.g +
          0.0722 * m.emissive.b) *
        m.emissiveIntensity
      ).toFixed(4);
    const out = {
      spawnStar: lumOf(mats.spawnStar),
      tierTip: lumOf(mats.tierTip),
      bullet: lumOf(mats.bullet),
      bulletTrail: lumOf(mats.bulletTrail),
    };
    mats.dispose();
    return out;
  });

  const starLum = sourceLuminanceLinear.spawnStar;
  const tipLum = sourceLuminanceLinear.tierTip;
  results.bloomThreshold = {
    art7: 0.85,
    shipped: 0,
    sourceLuminanceLinear,
    screenPeak,
    verdict:
      starLum >= 0.85 || tipLum >= 0.85
        ? 'the layer-isolated source reaches 0.85 — the deviation is no longer needed'
        : `on the layer-isolated source art §7's 0.85 catches nothing: the two ` +
          `emissive materials peak at ${starLum} (spawn star) and ${tipLum} ` +
          `(tier tip) linear. In the beauty frame — where a full-frame bloom ` +
          `would run — ${screenPeak.beautyPixelsOver85WithEmissives} px cross ` +
          `0.85 with the emissives present and ` +
          `${screenPeak.beautyPixelsOver85NonEmissive} px without them.`,
  };

  // --- 4. vignette + grade -------------------------------------------------
  results.vignette = await page.evaluate(
    (board: [number, number, string][]) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      P.init('high', board);
      P.frame(0, false);
      const off = P.pixels();
      P.frame(0, true);
      const on = P.pixels();

      const lum = (d: Uint8Array, i: number): number =>
        0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

      const profile: Record<string, number> = {};
      const midY = Math.floor(off.h / 2);
      for (const fx of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
        const x = Math.floor(fx * (off.w - 1));
        const i = (midY * off.w + x) * 4;
        const a = lum(off.data, i);
        profile[`x${Math.round(fx * 100)}`] =
          a > 0 ? +(lum(on.data, i) / a).toFixed(4) : 0;
      }

      /** Mean luminance in a 9×9 window around a world point, on ÷ off. */
      const ratioAt = (wx: number, wz: number): number => {
        const [cx, cy] = P.project(wx, 0, wz);
        let sumOff = 0;
        let sumOn = 0;
        let n = 0;
        for (let y = cy - 4; y <= cy + 4; y++) {
          for (let x = cx - 4; x <= cx + 4; x++) {
            if (x < 0 || y < 0 || x >= off.w || y >= off.h) continue;
            const i = (y * off.w + x) * 4;
            sumOff += lum(off.data, i);
            sumOn += lum(on.data, i);
            n++;
          }
        }
        return n > 0 && sumOff > 0 ? +(sumOn / sumOff).toFixed(4) : 0;
      };
      // The playfield is 208 u square; these are its four corner tiles' centres
      // and its middle, all of them bare board in BOARD_ROWS.
      const boardCorners = {
        nw: ratioAt(8, 8),
        ne: ratioAt(200, 8),
        sw: ratioAt(8, 200),
        se: ratioAt(200, 200),
        centre: ratioAt(104, 104),
      };

      /**
       * Local contrast in a window: the brightest and darkest pixels are chosen
       * in the **post-off** frame and then looked up again in the post-on one,
       * so the pair is the same two surfaces in both. A multiplicative chain
       * leaves their ratio alone; an additive lift would crush it, which is
       * what art §3.0 says the near-black board cannot afford.
       *
       * The window is anchored to a WORLD position, not to a fraction of the
       * viewport: the board is letterboxed inside a 16:9 frame, so "16% across"
       * lands outside the playfield and would measure the clear colour.
       */
      const contrast = (
        wx: number,
        wz: number,
        r: number,
      ): [number, number] => {
        const [cx, cy] = P.project(wx, 0, wz);
        let lo = Infinity;
        let hi = -Infinity;
        let loI = 0;
        let hiI = 0;
        for (let y = cy - r; y < cy + r; y++) {
          for (let x = cx - r; x < cx + r; x++) {
            if (x < 0 || y < 0 || x >= off.w || y >= off.h) continue;
            const i = (y * off.w + x) * 4;
            const l = lum(off.data, i);
            if (l < lo) {
              lo = l;
              loI = i;
            }
            if (l > hi) {
              hi = l;
              hiI = i;
            }
          }
        }
        const offLo = lum(off.data, loI);
        const onLo = lum(on.data, loI);
        return [
          offLo > 0 ? +(lum(off.data, hiI) / offLo).toFixed(4) : 0,
          onLo > 0 ? +(lum(on.data, hiI) / onLo).toFixed(4) : 0,
        ];
      };

      // The board is 13×16 = 208 u square. A window on its north-west corner
      // tiles (brick, per BOARD_ROWS) and one on the middle of the field.
      const corner = contrast(24, 24, 60);
      const centre = contrast(104, 104, 60);
      return {
        profile,
        boardCorners,
        cornerContrastOff: corner[0],
        cornerContrastOn: corner[1],
        centreContrastOff: centre[0],
        centreContrastOn: centre[1],
      };
    },
    FULL_BOARD,
  );

  // --- 5. cost: draw calls and render CPU, chain off vs on ------------------
  results.cost = await page.evaluate(
    (a: { board: [number, number, string][]; populate: string }) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      const fill = new Function('P', a.populate) as (r: Rig) => void;
      const out: Record<string, { drawCalls: number; msPerFrame: number }> = {};
      for (const quality of ['high', 'medium', 'low']) {
        for (const post of [false, true]) {
          P.init(quality, a.board);
          fill(P);
          P.frame(16, post); // warm-up: shader compilation and first uploads
          P.frame(16, post);
          P.resetCalls();
          P.frame(16, post);
          const drawCalls = P.calls();
          const N = 120;
          const t0 = performance.now();
          for (let i = 0; i < N; i++) {
            for (const t of P.state.tanks) {
              if (!t.alive) continue;
              t.prevX = t.x;
              t.x += 0.5;
            }
            P.frame(16, post);
          }
          out[`${quality}-post-${post ? 'on' : 'off'}`] = {
            drawCalls,
            msPerFrame: +((performance.now() - t0) / N).toFixed(3),
          };
        }
      }
      return out;
    },
    {
      board: FULL_BOARD,
      // The body only — `page.evaluate` cannot carry a closure across, and the
      // populated field has to be identical in all six runs.
      populate: `(${populate.toString()})(P);`,
    },
  );

  // --- 6. steady state and a preset switch ---------------------------------
  const steady = await page.evaluate(
    (a: { board: [number, number, string][]; populate: string }) => {
      const P = (globalThis as unknown as { P: Rig }).P;
      const fill = new Function('P', a.populate) as (r: Rig) => void;
      P.init('high', a.board);
      fill(P);
      P.frame(16);
      P.resetAdds();
      for (let i = 0; i < 240; i++) {
        for (const t of P.state.tanks) {
          if (!t.alive) continue;
          t.prevX = t.x;
          t.x += 0.5;
        }
        P.frame(16);
      }
      const adds = P.adds();

      // Six preset switches. `WebGLInfo.memory` counts LIVE GL objects, so a
      // chain that dropped a render target instead of disposing it shows up as
      // a texture count that keeps climbing.
      P.frame(16);
      const before = {
        textures: P.gl.info.memory.textures,
        geometries: P.gl.info.memory.geometries,
      };
      for (const q of ['low', 'medium', 'high', 'medium', 'low', 'high']) {
        P.setQuality(q);
        P.frame(16);
      }
      const after = {
        textures: P.gl.info.memory.textures,
        geometries: P.gl.info.memory.geometries,
      };
      return { adds, before, after };
    },
    {
      board: FULL_BOARD,
      populate: `(${populate.toString()})(P);`,
    },
  );
  results.steadyStateAdds = steady.adds;
  results.presetSwitch = {
    texturesBefore: steady.before.textures,
    texturesAfter: steady.after.textures,
    geometriesBefore: steady.before.geometries,
    geometriesAfter: steady.after.geometries,
  };

  await page.close();

  // --- 7. the REAL dev preview's console, one page per preset --------------
  results.previewConsole = { rig: noise.length > 0 ? noise : '(clean)' };
  for (const quality of ['low', 'medium', 'high']) {
    // DPR 1 on purpose. This is a live page whose rAF loop runs the whole
    // chain, and the capture browser rasterises on the CPU (swiftshader): at
    // DPR 2 the High preset's 2560×1440 SMAA + bloom starves the main thread
    // hard enough that `page.screenshot` times out. What this page is here to
    // answer — does the SHIPPED composition boot clean at each preset — does
    // not depend on the pixel ratio.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const p = await ctx.newPage();
    const found: string[] = [];
    p.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        found.push(`${m.type()}: ${m.text()}`);
      }
    });
    p.on('pageerror', (e) => found.push(`pageerror: ${e.message}`));
    await p.goto(`${URL}?quality=${quality}`, {
      waitUntil: 'load',
      timeout: 20_000,
    });
    await p.waitForTimeout(6000);
    await p.screenshot({
      path: join(SHOTS, `preview-live-${quality}.png`),
      timeout: 60_000,
    });
    results.previewConsole[quality] = found.length > 0 ? found : '(clean)';
    await ctx.close();
  }

  results.note =
    'Generated by `npm run capture:post`. Committed on purpose: art §7’s bloom ' +
    'threshold is amended on the strength of `bloomThreshold`, and ' +
    '`bloomProof.withoutEmissives` is the evidence that only the emissive ' +
    'layer blooms. Re-run and diff after any change to post.ts, to an emissive ' +
    'material, or to which meshes carry BLOOM_LAYER.';
  writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');

  console.log(`\nscreenshots → ${SHOTS}\nresults → ${OUT}\n`);
  console.table(results.cost);
  console.log('bloom threshold:', results.bloomThreshold);
  console.table([
    { scene: 'with emissives', ...results.bloomProof.withEmissives },
    { scene: 'without emissives', ...results.bloomProof.withoutEmissives },
  ]);
  console.log('vignette:', results.vignette);
  console.log('preset switch:', results.presetSwitch);
  console.log('steady-state Object3D.add:', results.steadyStateAdds);
  console.log('console:', results.previewConsole);

  await browser.close();
}

await main();
