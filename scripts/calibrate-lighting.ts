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
  };
  const matsMod = await import(urls.materials);
  const rootMod = await import(urls.sceneRoot);
  const threeUrl = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('/deps/three.js'));
  if (threeUrl === undefined) throw new Error('three module URL not found');
  const THREE = await import(threeUrl);

  const { PALETTE, QUALITY_PRESETS, CALIBRATION, createMaterials, litSurface } =
    matsMod;

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
