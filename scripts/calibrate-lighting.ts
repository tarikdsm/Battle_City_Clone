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

const URL = process.env.CALIBRATE_URL ?? 'http://localhost:5173/';
const W = 900;
const H = 760;

/** A partial override of `CALIBRATION`, applied to the live rig for one row. */
interface Candidate {
  key?: number;
  fill?: number;
  sky?: number | string;
  ground?: number | string;
  exposure?: number;
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
}

function parseCandidates(): Candidate[] {
  const raw = process.env.CALIBRATE_SWEEP;
  if (!raw) return [{}];
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
    ]);
  }
  console.log('\nconsole:', noise.length > 0 ? noise : '(clean)');
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
  };
  const matsMod = await import(urls.materials);
  const rootMod = await import(urls.sceneRoot);
  const terrainMod = await import(urls.terrain);
  const threeUrl = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/deps/three.js'));
  if (threeUrl === undefined) throw new Error('three module URL not found');
  const THREE = await import(threeUrl);

  const { PALETTE, QUALITY_PRESETS, CALIBRATION, createMaterials, litSurface } =
    matsMod;
  const { CANOPY_PROBE } = terrainMod;

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
  };

  const rows: Row[] = [];
  for (const c of candidates) {
    keyLight.intensity = c.key ?? CALIBRATION.keyIntensity;
    fillLight.intensity = c.fill ?? CALIBRATION.fillIntensity;
    fillLight.color.set(normalise(c.sky) ?? CALIBRATION.fillSky);
    fillLight.groundColor.set(normalise(c.ground) ?? CALIBRATION.fillGround);
    gl.toneMappingExposure = c.exposure ?? CALIBRATION.toneMappingExposure;
    gl.render(root.scene, root.camera);
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
    });
  }

  function normalise(x: number | string | undefined): number | undefined {
    if (x === undefined) return undefined;
    return typeof x === 'number' ? x : Number(x);
  }

  gl.dispose();
  canvas.remove();
  return rows;
}

await main();
