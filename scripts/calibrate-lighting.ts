// scripts/calibrate-lighting.ts — measures the lighting rig against art §6's
// three calibration targets, and sweeps candidate values when tuning.
//
//   npm run dev                  # in another terminal — the script needs it
//   npm run calibrate:lighting
//
// Why a browser: the targets are statements about *rendered pixels*, and there
// is no WebGL in Vitest. This drives the real `createSceneRoot` + `createMaterials`
// over the Vite dev server, so it measures the code that ships rather than a
// re-implementation of it. Probe points are placed by projecting known world
// coordinates through the real camera, so nothing depends on scanning heuristics.
//
// Sweeping: set CALIBRATE_SWEEP to a JSON array of partial overrides, e.g.
//   CALIBRATE_SWEEP='[{"sky":"0x4a5468","ground":"0x6b6154"},{"fill":18}]'
// Each row is measured with those values patched onto the live lights; nothing
// is written back, so picking a winner means editing CALIBRATION by hand.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const URL = process.env.CALIBRATE_URL ?? 'http://localhost:5173/';

/**
 * Where the measurements are written — and **this one is committed**.
 *
 * Art §6 is amended on the strength of these numbers: the permanent
 * warm-ground decision, the "saturation ≥ 55%" rule and the specific hue errors
 * are all binding doc text sourced from a run of this script. A number that
 * exists only in a console transcript and a task report cannot be re-checked
 * against the doc later, which is exactly what happened at T2.4. The file lives
 * next to the doc it backs so the two are reviewed together, and re-running
 * this turns "did the rig move?" into a diff.
 */
const OUT =
  process.env.CALIBRATE_OUT ?? join('docs', 'calibration', 'lighting.json');
const W = 900;
const H = 760;

/** A partial override of `CALIBRATION`, applied to the live rig for one row. */
interface Candidate {
  key?: number;
  fill?: number;
  sky?: number | string;
  ground?: number | string;
  exposure?: number;
  /**
   * Measure the same probe points **through art §7's post chain** at this
   * preset, instead of straight off the beauty pass.
   *
   * The calibration itself is defined on the raw render — the chain is an
   * authored layer applied to a finished frame, and `post.ts` keeps the beauty
   * pass writing to the drawing buffer untouched so that stays literally true.
   * These extra rows exist so "did the chain move a target?" is a diff against
   * a committed file rather than an opinion: T2.5 added them, and any later
   * change to the vignette or the grade shows up here as a number.
   */
  chain?: 'low' | 'medium' | 'high';
}

interface Row {
  label: string;
  /** `rendered / authored` luminance − 1, as a percentage. */
  boardPct: number;
  framePct: number;
  tankPct: number;
  brickSidePct: number;
  steelSidePct: number;
  shadowPct: number;
  boardHex: string;
  frameHex: string;
  tankHex: string;
  brickSideHex: string;
  steelSideHex: string;
  shadowHex: string;
  // --- T2.3 terrain: the two overridden materials and the uncovered band ---
  /** Glossy water surface, top face — target 1 against `waterDeep`. */
  waterPct: number;
  waterHex: string;
  /** Glossy ice, measured OPAQUE — see the note in `measureInPage`. */
  icePct: number;
  iceHex: string;
  /** The shipping 25%-alpha ice decal over the board. Informational. */
  iceDecalHex: string;
  iceDecalRatio: number;
  /** Canopy apex: normal straight up, so target 1 applies. */
  canopyApexPct: number;
  canopyApexHex: string;
  /** Canopy flanks at 45° normals — art §6's uncovered band. No target. */
  canopyFlankPct: number;
  canopyFlankHex: string;
  canopyShadePct: number;
  canopyShadeHex: string;
  /** Same tokens at litSurface's DEFAULT gloss — attribution controls. */
  waterCtlPct: number;
  iceCtlPct: number;
  // --- T2.4 entities: the six tank tokens and the bullet's gold -------------
  /** One row per tank type, measured on the SHIPPING part geometry. */
  tanks: TankRow[];
  /** The real emissive bullet material on the real capsule. */
  bulletHex: string;
  bulletPct: number;
  /** …and `powerupGold` on a plain `litSurface`, i.e. without the emissive. */
  bulletCtlHex: string;
  bulletCtlPct: number;
  /** Tokens delivered by `instanceColor` rather than by `material.color`. */
  tints: TintRow[];
}

/**
 * A §3.1 token that reaches the screen as an **instance colour** — the armor HP
 * ramp and Fast's orange trim. These are the tokens art §3.0's promise is
 * hardest to keep for, because `material.color` is somebody else's token and
 * this one arrives as a ratio against it. The probe therefore renders the real
 * `InstancedMesh` + real material + real ratio and scores the result against the
 * authored hex: a wrong ratio shows up here and nowhere else.
 */
interface TintRow {
  label: string;
  hex: string;
  pct: number;
}

/**
 * A tank token, measured twice: on the model's highest untinted horizontal face
 * (art §6 target 1) and on its southernmost untinted vertical face.
 *
 * The side row carries **no target** — art §3.1 authors side tokens for brick
 * and steel only. It exists for art §6's re-evaluation trigger, which asks
 * whether several tank tokens read wrong-hued the way steel's do, so the hue is
 * reported next to the token's own.
 */
interface TankRow {
  type: string;
  topHex: string;
  topPct: number;
  sideHex: string;
  /** Side luminance as a percentage of the same tank's lit top face. */
  sideOfTopPct: number;
  /** Rendered hue in degrees, and the authored token's, for comparison. */
  sideHue: number;
  tokenHue: number;
  /** Signed hue error in degrees, wrapped to (−180, 180]. */
  hueErr: number;
}

function parseCandidates(): Candidate[] {
  const raw = process.env.CALIBRATE_SWEEP;
  // The default run measures the rig four times: once raw — which is THE
  // calibration — and once through each of art §7's three chains, so the doc's
  // numbers and the chain's effect on them live in the same artifact.
  if (!raw) {
    return [{}, { chain: 'high' }, { chain: 'medium' }, { chain: 'low' }];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('CALIBRATE_SWEEP must be a JSON array');
  }
  return parsed as Candidate[];
}

async function main(): Promise<void> {
  const candidates = parseCandidates();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const noise: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      noise.push(`${m.type()}: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));

  // tsx compiles this file with esbuild's `keepNames`, which wraps every
  // function in a `__name(...)` call. That helper exists only in the Node
  // bundle, but `page.evaluate` serialises `measureInPage` *after* the
  // transform — so the browser needs an identity stand-in or the call throws
  // `ReferenceError: __name is not defined` before a single pixel is read.
  await page.addInitScript(() => {
    (globalThis as unknown as { __name: <T>(fn: T) => T }).__name = (fn) => fn;
  });

  try {
    await page.goto(URL, { waitUntil: 'load', timeout: 15_000 });
  } catch {
    await browser.close();
    throw new Error(`cannot reach ${URL} — is \`npm run dev\` running?`);
  }

  const rows = await page.evaluate(measureInPage, { candidates, W, H });

  const pct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
  const verdict = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');
  for (const r of rows) {
    console.log(`\n--- ${r.label} ---`);
    console.table([
      {
        target: '1 board  ±10%',
        rendered: r.boardHex,
        delta: pct(r.boardPct),
        result: verdict(Math.abs(r.boardPct) <= 10),
      },
      {
        target: '1 frame  ±10%',
        rendered: r.frameHex,
        delta: pct(r.framePct),
        result: verdict(Math.abs(r.framePct) <= 10),
      },
      {
        target: '1 tank   ±10%',
        rendered: r.tankHex,
        delta: pct(r.tankPct),
        result: verdict(Math.abs(r.tankPct) <= 10),
      },
      {
        target: '3 brick side ±20%',
        rendered: r.brickSideHex,
        delta: pct(r.brickSidePct),
        result: verdict(Math.abs(r.brickSidePct) <= 20),
      },
      {
        target: '3 steel side ±20%',
        rendered: r.steelSideHex,
        delta: pct(r.steelSidePct),
        result: verdict(Math.abs(r.steelSidePct) <= 20),
      },
      {
        target: '2 shadow 15-35%',
        rendered: r.shadowHex,
        delta: `${r.shadowPct.toFixed(1)}% of lit`,
        result: verdict(r.shadowPct >= 15 && r.shadowPct <= 35),
      },
      // T2.3. Water and ice override `litSurface`'s calibrated roughness, which
      // is a calibration change (materials.ts) — hence a probe each. The canopy
      // rows cover art §6's "uncovered band": its apex is a normal target 1
      // reaches, its flank is not, and the flank is reported rather than tuned.
      {
        target: '1 water  ±10%',
        rendered: r.waterHex,
        delta: pct(r.waterPct),
        result: verdict(Math.abs(r.waterPct) <= 10),
      },
      {
        target: '1 ice    ±10%',
        rendered: r.iceHex,
        delta: pct(r.icePct),
        result: verdict(Math.abs(r.icePct) <= 10),
      },
      {
        target: '1 canopy ±10%',
        rendered: r.canopyApexHex,
        delta: pct(r.canopyApexPct),
        result: verdict(Math.abs(r.canopyApexPct) <= 10),
      },
      {
        target: '- canopy 45° lit',
        rendered: r.canopyFlankHex,
        delta: pct(r.canopyFlankPct),
        result: 'no target',
      },
      {
        target: '- canopy 45° shade',
        rendered: r.canopyShadeHex,
        delta: pct(r.canopyShadePct),
        result: 'no target',
      },
      {
        target: '- water @default',
        rendered: '(control)',
        delta: pct(r.waterCtlPct),
        result: 'no target',
      },
      {
        target: '- ice @default',
        rendered: '(control)',
        delta: pct(r.iceCtlPct),
        result: 'no target',
      },
      {
        target: '- ice decal @25%',
        rendered: r.iceDecalHex,
        delta: `${r.iceDecalRatio.toFixed(2)}× board`,
        result: 'no target',
      },
      // T2.4. The bullet is emissive by art §4, so target 1 does not describe
      // it — the control below is the same token WITHOUT the emissive term, and
      // that one is a genuine target-1 measurement of `powerupGold`.
      {
        target: '1 bullet ±10%',
        rendered: r.bulletHex,
        delta: pct(r.bulletPct),
        result: 'emissive — no target',
      },
      {
        target: '1 gold @lit ±10%',
        rendered: r.bulletCtlHex,
        delta: pct(r.bulletCtlPct),
        result: verdict(Math.abs(r.bulletCtlPct) <= 10),
      },
      ...r.tints.map((t) => ({
        target: `1 ${t.label} ±10%`,
        rendered: t.hex,
        delta: pct(t.pct),
        result: verdict(Math.abs(t.pct) <= 10),
      })),
    ]);

    // The six tank tokens, on the shipping part geometry.
    console.table(
      r.tanks.map((t) => ({
        tank: t.type,
        'top ±10%': t.topHex,
        delta: pct(t.topPct),
        result: verdict(Math.abs(t.topPct) <= 10),
        side: t.sideHex,
        'side/top': `${t.sideOfTopPct.toFixed(1)}%`,
        'hue °': t.sideHue < 0 ? 'grey' : t.sideHue.toFixed(0),
        'token °': t.tokenHue < 0 ? 'grey' : t.tokenHue.toFixed(0),
        'Δhue °':
          t.sideHue < 0
            ? '—'
            : `${t.hueErr >= 0 ? '+' : ''}${t.hueErr.toFixed(0)}`,
      })),
    );
  }
  console.log('\nconsole:', noise.length > 0 ? noise : '(clean)');

  // The artifact. Every number this printed, plus the inputs it was measured
  // at, so art §6's text can be diffed against a file rather than against a
  // memory of a terminal.
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        note:
          'Generated by `npm run calibrate:lighting`. Committed on purpose: ' +
          'art §6 cites these numbers. Re-run and diff after any change to ' +
          'CALIBRATION, to a material, or to the geometry a probe samples. ' +
          'The row with `chain:off` IS the calibration — art §6 is defined on ' +
          'the raw render. The three `chain:` rows measure the same probes ' +
          'through art §7’s post chain, so a regression in the chain shows up ' +
          'as a diff here instead of as an opinion.',
        viewport: { width: W, height: H },
        targets: {
          '1 lit horizontal vs its token': '±10%',
          '2 shadowed ground vs lit ground': '15–35%',
          '3 vertical face vs its side token': '±20%',
        },
        rows,
        console: noise.length > 0 ? noise : '(clean)',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`results → ${OUT}`);
  await browser.close();
}

/**
 * Runs in the page. Builds the real scene root, adds probe boxes for the tokens
 * that have authored *side* colours (brick, steel), and samples projected points.
 */
async function measureInPage(args: {
  candidates: Candidate[];
  W: number;
  H: number;
}): Promise<Row[]> {
  const { candidates, W, H } = args;
  // Vite serves the TS sources, so these resolve at runtime in the browser.
  // Held in variables rather than written as literals so tsc treats them as
  // dynamic (a literal would be resolved against the Node program and fail).
  const urls = {
    materials: '/src/render/materials.ts',
    sceneRoot: '/src/render/sceneRoot.ts',
    terrain: '/src/render/terrainView.ts',
    models: '/src/render/models.ts',
    post: '/src/render/post.ts',
  };
  const matsMod = await import(urls.materials);
  const rootMod = await import(urls.sceneRoot);
  const terrainMod = await import(urls.terrain);
  const modelsMod = await import(urls.models);
  const postMod = await import(urls.post);
  const threeUrl = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/deps/three.js'));
  if (threeUrl === undefined) throw new Error('three module URL not found');
  const THREE = await import(threeUrl);

  const { PALETTE, QUALITY_PRESETS, CALIBRATION, createMaterials, litSurface } =
    matsMod;
  const { CANOPY_PROBE } = terrainMod;
  const {
    TANK_MODELS,
    TANK_PROBE,
    TANK_TYPES,
    ARMOR_HP_TINT,
    ARMOR_HP_TOKEN,
    createPartGeometry,
    createBulletGeometry,
    isOverlayRole,
  } = modelsMod;

  const canvas = document.createElement('canvas');
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.append(canvas);

  // The same settings renderer.ts applies, plus preserveDrawingBuffer so the
  // framebuffer survives until readPixels.
  const gl = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFShadowMap;
  gl.setClearColor(0x0a0a0a, 1);
  gl.setPixelRatio(1);
  gl.setSize(W, H, false);

  const mats = createMaterials();
  const root = rootMod.createSceneRoot(mats);
  root.setViewport(W, H);
  // castShadow lives on the preset, not on construction — renderer.ts applies
  // it. Without this the key casts nothing and every shadow probe reads lit.
  root.setShadowQuality(QUALITY_PRESETS.high);

  // Probe boxes, 16×16×10 like a placeholder tank, on clear mid-board tiles.
  const box = new THREE.BoxGeometry(16, 10, 16);
  const addProbe = (hex: number, x: number, z: number, mat?: unknown) => {
    const mesh = new THREE.Mesh(box, mat ?? litSurface(hex));
    mesh.position.set(x + 8, 5, z + 8);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.entities.add(mesh);
    return mesh;
  };
  addProbe(PALETTE.player1, 48, 48, mats.player1); // tank, shares the real skin
  addProbe(PALETTE.brickTop, 112, 48);
  addProbe(PALETTE.steelTop, 112, 112);

  // --- T2.3 terrain probes -------------------------------------------------
  // Water and ice are the two materials that OVERRIDE litSurface's calibrated
  // roughness (art §5 wants gloss), so each gets its own target-1 probe rather
  // than inheriting the tank's deviation — the ACES curve is non-linear and the
  // specular response is exactly what the exposure was fit through.
  addProbe(PALETTE.waterDeep, 48, 112, mats.terrainWater);

  // Ice is measured OPAQUE, on a clone with `transparent` off. The shipping
  // decal is `#cadeed` at 25% over a near-black board, so "within ±10% of its
  // token" is arithmetically impossible for it — 75% of what you see is board.
  // The clone isolates the thing the target is actually about (how the rig
  // renders this albedo at this gloss); the real decal is measured separately
  // below and reported without a target.
  const iceOpaque = mats.terrainIce.clone();
  iceOpaque.transparent = false;
  iceOpaque.opacity = 1;
  iceOpaque.depthWrite = true;
  iceOpaque.vertexColors = false;
  addProbe(PALETTE.ice, 176, 48, iceOpaque);

  // The real decal, over the real board, with the real material.
  const iceDecal = new THREE.Mesh(
    terrainMod.createIceGeometry(),
    mats.terrainIce,
  );
  iceDecal.position.set(176 + 8, 0, 112 + 8);
  root.entities.add(iceDecal);

  // The canopy — art §6's "uncovered band". Built from the SHIPPING geometry so
  // the measurement is of the spheres that are on screen, not of a stand-in.
  const canopy = new THREE.Mesh(
    terrainMod.createTreesGeometry(),
    mats.terrainTrees,
  );
  // The shipping view places a tile instance at the tile CENTRE, and the
  // geometry is built around its own origin — so the probe mesh goes to the
  // centre while `CANOPY_PROBE` is stated from the tile's north-west corner.
  canopy.position.set(112 + 8, 0, 176 + 8);
  canopy.castShadow = true;
  root.entities.add(canopy);

  // --- T2.4 entity probes ---------------------------------------------------
  // Built from the SHIPPING part table and the SHIPPING part geometry, so this
  // measures the boxes that are on screen rather than a stand-in — the same
  // discipline the canopy probe follows. Plain `Mesh`es rather than the
  // `InstancedMesh` the view uses: the only difference between the two is
  // `instanceColor`, and both sample points sit on parts whose tint is exactly
  // (1, 1, 1), so the pixel is identical.
  //
  // Tier hardware (`p.tier !== undefined`) is skipped: a tier-0 player has no
  // rings and no gold tip. Overlays (spawn star, shield frame, stun stars) are
  // skipped for the same reason — none of them is on screen at rest.
  const partGeo = createPartGeometry();
  const TANK_TILE: Record<string, [number, number]> = {
    p1: [16, 16],
    p2: [48, 16],
    basic: [80, 16],
    fast: [112, 16],
    power: [144, 16],
    armor: [176, 16],
  };
  for (const type of TANK_TYPES as string[]) {
    const model = TANK_MODELS[type];
    const [tx, tz] = TANK_TILE[type];
    for (const p of model.parts) {
      if (isOverlayRole(p.role) || p.tier !== undefined) continue;
      const mesh = new THREE.Mesh(partGeo, mats[model.material]);
      mesh.scale.set(p.w, p.h, p.d);
      mesh.position.set(tx + 8 + p.x, p.y, tz + 8 + p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.entities.add(mesh);
    }
  }

  // The bullet, on its real emissive material and real capsule, plus a control
  // of the same token on a plain lit surface — art §4 makes the bullet emissive,
  // so target 1 describes the control and not the shipping material.
  const BULLET_TILE: [number, number] = [80, 144];
  const bulletMesh = new THREE.Mesh(createBulletGeometry(), mats.bullet);
  bulletMesh.position.set(BULLET_TILE[0] + 8, 8, BULLET_TILE[1] + 8);
  root.entities.add(bulletMesh);
  addProbe(PALETTE.powerupGold, 144, 144, litSurface(PALETTE.powerupGold));

  // Tokens that arrive as an INSTANCE COLOUR rather than as `material.color`:
  // art §3.1's armor HP ramp (on `enemyArmor`) and Fast's orange trim (on
  // `enemyFast`). Probed through the real `InstancedMesh` + real material +
  // real ratio, because that composition is the thing that can be wrong — each
  // material's own token is already covered by the six rows above.
  const TINT_ROW_Z = 80;
  const tintProbes: { label: string; token: number; x: number }[] = [];
  const addTinted = (
    material: unknown,
    entries: { label: string; token: number; tint: readonly number[] }[],
  ): void => {
    const mesh = new THREE.InstancedMesh(partGeo, material, entries.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    for (let i = 0; i < entries.length; i++) {
      const x = 16 + tintProbes.length * 32;
      m.makeScale(16, 10, 16);
      m.setPosition(x + 8, 5, TINT_ROW_Z + 8);
      mesh.setMatrixAt(i, m);
      c.r = entries[i].tint[0];
      c.g = entries[i].tint[1];
      c.b = entries[i].tint[2];
      mesh.setColorAt(i, c);
      tintProbes.push({ label: entries[i].label, token: entries[i].token, x });
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    root.entities.add(mesh);
  };
  addTinted(
    mats.enemyArmor,
    (ARMOR_HP_TOKEN as number[]).map((token: number, i: number) => ({
      label: `armor hp${4 - i}`,
      token,
      tint: ARMOR_HP_TINT[i],
    })),
  );
  addTinted(mats.enemyFast, [
    {
      label: 'fast orange',
      token: PALETTE.enemyFastTrim,
      tint: matsMod.faceTint(PALETTE.enemyFastTrim, PALETTE.enemyFast),
    },
  ]);

  // Controls: the SAME two tokens at `litSurface`'s calibrated defaults. Without
  // these a deviation on water or ice is unattributable — art §6's fit is
  // two-point and non-linear, so a dark token can miss target 1 for reasons that
  // have nothing to do with the gloss override this task introduced.
  addProbe(PALETTE.waterDeep, 176, 176, litSurface(PALETTE.waterDeep));
  addProbe(PALETTE.ice, 16, 176, litSurface(PALETTE.ice));

  let key: { intensity: number } | null = null;
  let fill: {
    intensity: number;
    color: { set(v: number | string): void };
    groundColor: { set(v: number | string): void };
  } | null = null;
  root.scene.traverse((o: Record<string, unknown>) => {
    if (o.isDirectionalLight === true) key = o as never;
    if (o.isHemisphereLight === true) fill = o as never;
  });
  if (key === null || fill === null) throw new Error('lights not found');
  const keyLight: { intensity: number } = key;
  const fillLight: {
    intensity: number;
    color: { set(v: number | string): void };
    groundColor: { set(v: number | string): void };
  } = fill;

  const buf = new Uint8Array(W * H * 4);
  const ctx = gl.getContext();
  const read = (): void => {
    ctx.readPixels(0, 0, W, H, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
  };
  const v = new THREE.Vector3();
  // readPixels' origin is bottom-left, which matches NDC, so no flip.
  const px = (x: number, y: number, z: number): [number, number] => {
    v.set(x, y, z).project(root.camera);
    return [Math.round(((v.x + 1) / 2) * W), Math.round(((v.y + 1) / 2) * H)];
  };
  const at = ([x, y]: [number, number]): [number, number, number] => {
    const i = (y * W + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const lum = (p: [number, number, number]): number =>
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const hex = (p: [number, number, number]): string =>
    '#' + p.map((c) => c.toString(16).padStart(2, '0')).join('');
  const tokenRgb = (t: number): [number, number, number] => [
    (t >> 16) & 255,
    (t >> 8) & 255,
    t & 255,
  ];

  // Art §7's chain, over the same rig. It reads the finished drawing buffer, so
  // a row with `chain` unset is bit-for-bit the measurement T2.2–T2.4 made.
  const chain = postMod.createPostChain(gl, root.scene, root.camera);
  chain.setSize(W, H);

  // One render so the camera's matrices exist before projecting.
  gl.render(root.scene, root.camera);

  const P = {
    // Mid-tile board, nothing above it.
    board: px(104, 0, 104),
    // West frame wall, top face.
    frame: px(-4, 6, 104),
    // Probe tops (y = 10) and their south-facing vertical faces — the box at
    // (x, z) spans x…x+16 / z…z+16, so its south face is the plane z + 16.
    // Under a yaw-0 camera the south face is the ONLY vertical one with any
    // projected area, and the key (north-west) never reaches it, so this is the
    // shade side the player actually sees.
    tankTop: px(56, 10, 56),
    brickSide: px(120, 5, 64),
    steelSide: px(120, 5, 128),
    // Board the player probe occludes: 10/tan(50°) = 8.4 u along (0.573, 0.819).
    shadow: px(58, 0, 68),
    // T2.3 terrain.
    water: px(56, 10, 120),
    ice: px(184, 10, 56),
    iceDecal: px(184, 0.04, 120),
    canopyApex: px(
      112 + CANOPY_PROBE.apex[0],
      CANOPY_PROBE.apex[1],
      176 + CANOPY_PROBE.apex[2],
    ),
    canopyFlank: px(
      112 + CANOPY_PROBE.flankWest[0],
      CANOPY_PROBE.flankWest[1],
      176 + CANOPY_PROBE.flankWest[2],
    ),
    canopyShade: px(
      112 + CANOPY_PROBE.flankSouth[0],
      CANOPY_PROBE.flankSouth[1],
      176 + CANOPY_PROBE.flankSouth[2],
    ),
    waterCtl: px(184, 10, 184),
    iceCtl: px(24, 10, 184),
    // The bullet capsule's apex (normal straight up) and the gold control's top.
    bullet: px(BULLET_TILE[0] + 8, 8 + 2, BULLET_TILE[1] + 8),
    bulletCtl: px(152, 10, 152),
  };

  // Two points per tank, projected through the real camera from the model's own
  // probe table.
  const tankPx: Record<
    string,
    { top: [number, number]; side: [number, number] }
  > = {};
  for (const type of TANK_TYPES as string[]) {
    const [tx, tz] = TANK_TILE[type];
    const probe = TANK_PROBE[type];
    tankPx[type] = {
      top: px(tx + 8 + probe.top[0], probe.top[1], tz + 8 + probe.top[2]),
      side: px(tx + 8 + probe.side[0], probe.side[1], tz + 8 + probe.side[2]),
    };
  }

  // Probe row for the instance-coloured tokens, top faces.
  const tintPx = tintProbes.map((t) => px(t.x + 8, 10, TINT_ROW_Z + 8));

  /** Hue in degrees, or −1 for an achromatic sample. */
  const hueOf = (p: [number, number, number]): number => {
    const r = p[0] / 255;
    const g = p[1] / 255;
    const b = p[2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (d < 0.02) return -1;
    let h: number;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };
  const hueErrOf = (a: number, b: number): number => {
    if (a < 0 || b < 0) return 0;
    let d = a - b;
    while (d > 180) d -= 360;
    while (d <= -180) d += 360;
    return d;
  };

  const rows: Row[] = [];
  for (const c of candidates) {
    keyLight.intensity = c.key ?? CALIBRATION.keyIntensity;
    fillLight.intensity = c.fill ?? CALIBRATION.fillIntensity;
    fillLight.color.set(normalise(c.sky) ?? CALIBRATION.fillSky);
    fillLight.groundColor.set(normalise(c.ground) ?? CALIBRATION.fillGround);
    gl.toneMappingExposure = c.exposure ?? CALIBRATION.toneMappingExposure;
    gl.render(root.scene, root.camera);
    if (c.chain !== undefined) {
      chain.setPreset(postMod.POST_PRESETS[c.chain]);
      chain.setSize(W, H);
      chain.render();
    }
    read();

    const board = at(P.board);
    const boardLum = lum(board);
    const rel = (p: [number, number, number], token: number): number =>
      (lum(p) / lum(tokenRgb(token)) - 1) * 100;

    rows.push({
      label: JSON.stringify({
        key: keyLight.intensity,
        fill: fillLight.intensity,
        sky: (normalise(c.sky) ?? CALIBRATION.fillSky).toString(16),
        ground: (normalise(c.ground) ?? CALIBRATION.fillGround).toString(16),
        exposure: gl.toneMappingExposure,
        chain: c.chain ?? 'off',
      }),
      boardHex: hex(board),
      boardPct: rel(board, PALETTE.board),
      frameHex: hex(at(P.frame)),
      framePct: rel(at(P.frame), PALETTE.boardFrame),
      tankHex: hex(at(P.tankTop)),
      tankPct: rel(at(P.tankTop), PALETTE.player1),
      brickSideHex: hex(at(P.brickSide)),
      brickSidePct: rel(at(P.brickSide), PALETTE.brickSide),
      steelSideHex: hex(at(P.steelSide)),
      steelSidePct: rel(at(P.steelSide), PALETTE.steelSide),
      shadowHex: hex(at(P.shadow)),
      shadowPct: (lum(at(P.shadow)) / boardLum) * 100,
      waterHex: hex(at(P.water)),
      waterPct: rel(at(P.water), PALETTE.waterDeep),
      iceHex: hex(at(P.ice)),
      icePct: rel(at(P.ice), PALETTE.ice),
      iceDecalHex: hex(at(P.iceDecal)),
      iceDecalRatio: lum(at(P.iceDecal)) / boardLum,
      canopyApexHex: hex(at(P.canopyApex)),
      canopyApexPct: rel(at(P.canopyApex), PALETTE.treesCanopy),
      canopyFlankHex: hex(at(P.canopyFlank)),
      canopyFlankPct: rel(at(P.canopyFlank), PALETTE.treesCanopy),
      canopyShadeHex: hex(at(P.canopyShade)),
      canopyShadePct: rel(at(P.canopyShade), PALETTE.treesCanopy),
      waterCtlPct: rel(at(P.waterCtl), PALETTE.waterDeep),
      iceCtlPct: rel(at(P.iceCtl), PALETTE.ice),
      bulletHex: hex(at(P.bullet)),
      bulletPct: rel(at(P.bullet), PALETTE.powerupGold),
      bulletCtlHex: hex(at(P.bulletCtl)),
      bulletCtlPct: rel(at(P.bulletCtl), PALETTE.powerupGold),
      tints: tintProbes.map((t, i) => ({
        label: t.label,
        hex: hex(at(tintPx[i])),
        pct: rel(at(tintPx[i]), t.token),
      })),
      tanks: (TANK_TYPES as string[]).map((type) => {
        const token = TANK_MODELS[type].token;
        const top = at(tankPx[type].top);
        const side = at(tankPx[type].side);
        const sideHue = hueOf(side);
        const tokenHue = hueOf(tokenRgb(token));
        return {
          type,
          topHex: hex(top),
          topPct: rel(top, token),
          sideHex: hex(side),
          sideOfTopPct: (lum(side) / lum(top)) * 100,
          sideHue,
          tokenHue,
          hueErr: hueErrOf(sideHue, tokenHue),
        };
      }),
    });
  }

  function normalise(x: number | string | undefined): number | undefined {
    if (x === undefined) return undefined;
    return typeof x === 'number' ? x : Number(x);
  }

  chain.dispose();
  gl.dispose();
  canvas.remove();
  return rows;
}

await main();
