// tests/render/materials.test.ts — data-only. Runs in the Vitest **node**
// environment: there is no DOM and no WebGL here, so nothing in this file may
// construct a renderer, a canvas or a GL context. It asserts the two frozen
// tables `materials.ts` publishes — the palette (art §3, the hex values are
// binding) and the quality presets (art §7) — and nothing else. Scene-graph
// structure, camera math and lighting are verified visually + by the e2e smoke.

import { describe, expect, it } from 'vitest';

import {
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
} from 'three';

import {
  CALIBRATION,
  ICE_ALPHA,
  PALETTE,
  QUALITY_PRESETS,
  TERRAIN_GLOSS,
  createMaterials,
  graphicSurface,
  litSurface,
  type PaletteKey,
  // Imported from materials, not renderer: `Quality` is *declared* here and
  // only re-exported there (Contract Zero names renderer.ts as its home), and
  // reaching through renderer.ts would drag `HTMLCanvasElement` into a node-env
  // test that has no DOM.
  type Quality,
} from '../../src/render/materials';

// Transcribed from docs/03-art-direction.md §3, top to bottom. This table is the
// spec: if the doc changes, change it here first and let the test go red.
const ART_PALETTE: readonly (readonly [PaletteKey, number])[] = [
  ['board', 0x10121b],
  ['gridLine', 0x191d2b],
  ['boardFrame', 0x262b3d],

  ['brickTop', 0xbf5a33],
  ['brickSide', 0x6f3118],
  ['brickMortar', 0x8f3f20],
  ['brickTopLip', 0xd9744c],

  ['steelTop', 0xb7c0cd],
  ['steelSide', 0x5c6474],
  ['steelRivet', 0xdde3ec],

  ['waterDeep', 0x173f75],
  ['waterWave', 0x4285d8],
  ['waterHighlight', 0x7db1ea],

  ['treesCanopy', 0x2e7d3a],
  ['treesDepth', 0x1c5527],
  ['treesHighlight', 0x46a04f],

  ['ice', 0xcadeed],
  ['iceSheen', 0xe8f4fb],

  ['player1', 0xd99c2b],
  ['player1Accent', 0xf2c14e],
  ['player2', 0x3aa655],
  ['player2Accent', 0x7fd695],

  ['enemyBasic', 0x8a8f9c],
  ['enemyBasicTrim', 0xcf4b4b],
  ['enemyFast', 0xc8a05a],
  ['enemyPower', 0x8f6bd0],
  ['enemyArmor', 0xc3cad6],

  ['powerupGold', 0xffd76b],
  ['spawnAccent', 0x7fc4ff],
  ['danger', 0xe24b4a],
];

/** `0x10121b` → `#10121b` — the form the art doc and the future CSS mirror use. */
function hex(v: number): string {
  return `#${v.toString(16).padStart(6, '0')}`;
}

describe('PALETTE (art §3)', () => {
  it.each(ART_PALETTE)('%s is %d', (key, value) => {
    // Compared as `#rrggbb` strings so a mismatch prints the two colours the
    // way the art doc writes them, not as two seven-digit decimals.
    expect(hex(PALETTE[key])).toBe(hex(value));
  });

  it('has exactly the tokens art §3 defines — no more, no less', () => {
    expect(Object.keys(PALETTE).sort()).toEqual(
      ART_PALETTE.map(([k]) => k).sort(),
    );
  });

  it('stores every token as a 24-bit integer', () => {
    for (const [key, value] of Object.entries(PALETTE)) {
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0x000000);
      expect(value, key).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('is frozen — a stray write cannot repaint the game', () => {
    const before = PALETTE.board;
    // The cast is the point: without it this line is a compile error, which is
    // the first line of defence. The freeze is the second, for JS callers and
    // for anything that reaches the object through a widened type.
    const mutable = PALETTE as unknown as Record<string, number>;
    expect(() => {
      mutable.board = 0xff00ff;
    }).toThrow(TypeError); // ES modules are strict mode: the write throws.
    expect(PALETTE.board).toBe(before);
    expect(Object.isFrozen(PALETTE)).toBe(true);
  });

  it('exports the ice alpha separately (art §3: ice @ 25%)', () => {
    expect(ICE_ALPHA).toBe(0.25);
  });
});

describe('QUALITY_PRESETS (art §7)', () => {
  const EXPECTED: readonly (readonly [
    Quality,
    { dprCap: number; shadows: boolean; shadowMapSize: number },
  ])[] = [
    ['high', { dprCap: 2, shadows: true, shadowMapSize: 2048 }],
    ['medium', { dprCap: 1.5, shadows: true, shadowMapSize: 1024 }],
    ['low', { dprCap: 1, shadows: false, shadowMapSize: 0 }],
  ];

  it.each(EXPECTED)('%s', (quality, expected) => {
    expect(QUALITY_PRESETS[quality]).toEqual(expected);
  });

  it('covers exactly the three concrete levels ("auto" is resolved upstream)', () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([
      'high',
      'low',
      'medium',
    ]);
  });

  it('is frozen, table and rows alike', () => {
    expect(Object.isFrozen(QUALITY_PRESETS)).toBe(true);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(Object.isFrozen(preset)).toBe(true);
    }
    const mutable = QUALITY_PRESETS as unknown as Record<
      string,
      { dprCap: number }
    >;
    expect(() => {
      mutable.high = { dprCap: 4 };
    }).toThrow(TypeError);
    expect(QUALITY_PRESETS.high.dprCap).toBe(2);
  });

  it('degrades monotonically — every step down costs resolution', () => {
    expect(QUALITY_PRESETS.high.dprCap).toBeGreaterThan(
      QUALITY_PRESETS.medium.dprCap,
    );
    expect(QUALITY_PRESETS.medium.dprCap).toBeGreaterThan(
      QUALITY_PRESETS.low.dprCap,
    );
    expect(QUALITY_PRESETS.high.shadowMapSize).toBeGreaterThan(
      QUALITY_PRESETS.medium.shadowMapSize,
    );
    // Shadows off is encoded as size 0, so "no shadow map" cannot be confused
    // with "a shadow map of some default size".
    expect(QUALITY_PRESETS.low.shadows).toBe(false);
    expect(QUALITY_PRESETS.low.shadowMapSize).toBe(0);
  });
});

// Constructing a Material or a Color touches no GL context — which is exactly
// why `createMaterials()` is a factory — so the round-2 rulings (art §3.0's
// tone-mapping policy and §6's calibration) are assertable right here, in the
// node environment, with no DOM and no WebGL.
describe('art §3.0 — the flat-graphic tone-mapping policy', () => {
  const FLAT: readonly ('board' | 'boardFrame' | 'gridLine')[] = [
    'board',
    'boardFrame',
    'gridLine',
  ];
  const LIT: readonly (
    | 'terrainBrick'
    | 'terrainSteel'
    | 'terrainWater'
    | 'terrainTrees'
    | 'terrainIce'
    | 'player1'
    | 'player2'
    | 'enemyBasic'
    | 'enemyFast'
    | 'enemyPower'
    | 'enemyArmor'
    | 'bullet'
  )[] = [
    // Art §6's definitive list puts ALL terrain on the lit path. Terrain is
    // something the light falls on, not part of the board's diagram.
    'terrainBrick',
    'terrainSteel',
    'terrainWater',
    'terrainTrees',
    'terrainIce',
    'player1',
    'player2',
    'enemyBasic',
    'enemyFast',
    'enemyPower',
    'enemyArmor',
    'bullet',
  ];

  it.each(FLAT)('%s opts out of tone mapping', (key) => {
    const mats = createMaterials();
    // The single strongest regression risk in this task: drop this flag and the
    // ACES curve crushes the token (the grid measured 1.07× the board's
    // luminance — invisible — before the policy landed).
    expect(mats[key].toneMapped).toBe(false);
    mats.dispose();
  });

  it.each(LIT)('%s stays on the ACES path', (key) => {
    const mats = createMaterials();
    expect(mats[key].toneMapped).toBe(true);
    mats.dispose();
  });

  it('flat graphics are Lambert, lit surfaces are Standard', () => {
    const mats = createMaterials();
    // Not cosmetic: a standard material adds a specular term that does not
    // scale with albedo, which put the frame wall 27% below its token when the
    // rig was calibrated against the near-black board. "Simplifying" these back
    // to MeshStandardMaterial silently decalibrates the whole flat path.
    expect(mats.board).toBeInstanceOf(MeshLambertMaterial);
    expect(mats.boardFrame).toBeInstanceOf(MeshLambertMaterial);
    // The lattice became thin quads in T2.3, so it needs a *mesh* material —
    // but it stays UNLIT (`MeshBasicMaterial`, the mesh analogue of
    // `LineBasicMaterial`), which is what keeps the rendered pixel identical to
    // the exact `#191d2b` T2.2 measured. Promoting it to `graphicSurface()`
    // would put it on the lighting model and re-open that calibration.
    expect(mats.gridLine).toBeInstanceOf(MeshBasicMaterial);
    expect(mats.gridLine).not.toBeInstanceOf(MeshLambertMaterial);
    for (const key of LIT) {
      expect(mats[key], key).toBeInstanceOf(MeshStandardMaterial);
    }
    mats.dispose();
  });

  it('terrain carries its authored TOP token as albedo, never a side token', () => {
    // Art §5's reversed ruling: a side token says what a side *reads as*, and
    // feeding it as base colour renders sides at ~20% of the top face. The rig
    // produces the sides, and `calibrate-lighting.ts` scores exactly that — so
    // a future "fix" that assigns `brickSide`/`steelSide` here has to fail.
    const mats = createMaterials();
    expect(mats.terrainBrick.color.getHexString()).toBe('bf5a33'); // brickTop
    expect(mats.terrainSteel.color.getHexString()).toBe('b7c0cd'); // steelTop
    expect(mats.terrainWater.color.getHexString()).toBe('173f75'); // waterDeep
    expect(mats.terrainTrees.color.getHexString()).toBe('2e7d3a'); // treesCanopy
    expect(mats.terrainIce.color.getHexString()).toBe('cadeed'); // ice
    mats.dispose();
  });

  it('brick and steel carry their detail tokens as VERTEX colours', () => {
    // Mortar, top lip, bevel and rivet are per-face colours baked into one
    // geometry so each kind stays a single draw call. The flag has to be on or
    // the attribute is silently ignored and every face renders flat.
    const mats = createMaterials();
    expect(mats.terrainBrick.vertexColors).toBe(true);
    expect(mats.terrainSteel.vertexColors).toBe(true);
    mats.dispose();
  });

  it('only water and ice override the calibrated gloss, and only roughness', () => {
    const mats = createMaterials();
    for (const key of [
      'terrainBrick',
      'terrainSteel',
      'terrainTrees',
    ] as const) {
      expect(mats[key].roughness, key).toBe(CALIBRATION.litRoughness);
      expect(mats[key].metalness, key).toBe(CALIBRATION.litMetalness);
    }
    expect(mats.terrainWater.roughness).toBe(TERRAIN_GLOSS.water.roughness);
    expect(mats.terrainIce.roughness).toBe(TERRAIN_GLOSS.ice.roughness);
    // Glossier than the calibrated default, which is the whole point of the
    // override — but only as far as target 1 allows. Measured: water hits +0.1%
    // at 0.34 and +16.0% at 0.40; ice falls to −14.1% at 0.08. See TERRAIN_GLOSS
    // for the sweep, and re-run `npm run calibrate:lighting` before moving them.
    expect(mats.terrainWater.roughness).toBeLessThan(CALIBRATION.litRoughness);
    expect(mats.terrainIce.roughness).toBeLessThan(CALIBRATION.litRoughness);
    // Metalness deliberately NOT raised: it lerps the diffuse lobe toward zero,
    // so "high specular" via metalness costs luminance in direct proportion and
    // put ice 21% below its token — outside art §6 target 1. See TERRAIN_GLOSS.
    expect(mats.terrainWater.metalness).toBe(CALIBRATION.litMetalness);
    expect(mats.terrainIce.metalness).toBe(CALIBRATION.litMetalness);
    expect(Object.isFrozen(TERRAIN_GLOSS)).toBe(true);
    mats.dispose();
  });

  it('trees and ice are the only transparent terrain (art §5 / §3)', () => {
    const mats = createMaterials();
    expect(mats.terrainTrees.transparent).toBe(true);
    expect(mats.terrainTrees.opacity).toBe(0.95); // art §5 "alpha ~0.95"
    // Canopies conceal a tank; blending 4 overlapping spheres correctly needs
    // the depth write, so it stays on.
    expect(mats.terrainTrees.depthWrite).toBe(true);
    expect(mats.terrainIce.transparent).toBe(true);
    expect(mats.terrainIce.opacity).toBe(ICE_ALPHA); // art §3 "ice @ 25%"
    // Flush with the board: writing depth would let a 0.03 u decal occlude the
    // tanks standing on it.
    expect(mats.terrainIce.depthWrite).toBe(false);
    for (const key of [
      'terrainBrick',
      'terrainSteel',
      'terrainWater',
    ] as const) {
      expect(mats[key].transparent, key).toBe(false);
    }
    mats.dispose();
  });

  it('carries the authored token through to the material colour', () => {
    const mats = createMaterials();
    // `new Color(hex)` converts sRGB → the linear working space, so this also
    // pins the round-trip the whole palette promise rests on.
    expect(mats.board.color.getHexString()).toBe('10121b');
    expect(mats.boardFrame.color.getHexString()).toBe('262b3d');
    expect(mats.gridLine.color.getHexString()).toBe('191d2b');
    expect(mats.player1.color.getHexString()).toBe('d99c2b');
    expect(mats.enemyArmor.color.getHexString()).toBe('c3cad6');
    mats.dispose();
  });

  it('exports both factories, and they carry the policy (art §6)', () => {
    const flat = graphicSurface(PALETTE.brickTop);
    const lit = litSurface(PALETTE.brickTop);
    expect(flat).toBeInstanceOf(MeshLambertMaterial);
    expect(flat.toneMapped).toBe(false);
    expect(lit).toBeInstanceOf(MeshStandardMaterial);
    expect(lit.toneMapped).toBe(true);
    // The calibrated specular response the exposure was fit through.
    expect(lit.roughness).toBe(CALIBRATION.litRoughness);
    expect(lit.metalness).toBe(CALIBRATION.litMetalness);
    // Overridable, because water and ice want gloss (art §5) — but doing so is
    // a calibration change, which is why it has to be spelled out.
    const glossy = litSurface(PALETTE.waterDeep, {
      roughness: 0.1,
      metalness: 0.4,
    });
    expect(glossy.roughness).toBe(0.1);
    expect(glossy.metalness).toBe(0.4);
    flat.dispose();
    lit.dispose();
    glossy.dispose();
  });

  it('registers every material in `all` exactly once', () => {
    const mats = createMaterials();
    // `all` drives both the shadow-toggle recompile sweep and disposal, so a
    // material missing from it fails silently twice over. It is derived from
    // the role record precisely so this cannot drift — this asserts the
    // derivation, not a hand-kept list.
    const roles = Object.keys(mats).filter(
      (k) => k !== 'all' && k !== 'dispose',
    );
    expect(mats.all).toHaveLength(roles.length);
    expect(new Set(mats.all).size).toBe(roles.length);
    for (const role of roles) {
      const m = (mats as unknown as Record<string, unknown>)[role];
      expect(mats.all, role).toContain(m);
    }
    mats.dispose();
  });
});

describe('CALIBRATION (art §6)', () => {
  it('is frozen — the five values are one solution, not five knobs', () => {
    expect(Object.isFrozen(CALIBRATION)).toBe(true);
    const mutable = CALIBRATION as unknown as Record<string, number>;
    expect(() => {
      mutable.keyIntensity = 99;
    }).toThrow(TypeError);
    expect(CALIBRATION.keyIntensity).toBe(3.8);
  });

  it('holds the measured values (re-run npm run calibrate:lighting to change)', () => {
    // Pinned so a stray edit is a failing test rather than a silent visual
    // regression nobody notices until a screenshot looks wrong.
    expect(CALIBRATION).toEqual({
      keyIntensity: 3.8,
      fillIntensity: 16.0,
      fillSky: 0x303543,
      fillGround: 0x8f6b3d,
      toneMappingExposure: 0.7,
      litRoughness: 0.55,
      litMetalness: 0.15,
    });
  });

  it('keeps exposure off art §6’s superseded 1.1', () => {
    // Exposure reaches only the ACES path; 1.1 predates the §3.0 split and
    // measured +20.9% on a tank. Guarded because "restoring the documented
    // value" is exactly the kind of well-meaning edit that would break it.
    expect(CALIBRATION.toneMappingExposure).not.toBe(1.1);
  });
});
