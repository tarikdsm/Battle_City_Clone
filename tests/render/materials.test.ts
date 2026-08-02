// tests/render/materials.test.ts — data-only. Runs in the Vitest **node**
// environment: there is no DOM and no WebGL here, so nothing in this file may
// construct a renderer, a canvas or a GL context. It asserts the two frozen
// tables `materials.ts` publishes — the palette (art §3, the hex values are
// binding) and the quality presets (art §7) — and nothing else. Scene-graph
// structure, camera math and lighting are verified visually + by the e2e smoke.

import { describe, expect, it } from 'vitest';

import {
  AdditiveBlending,
  Color,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
} from 'three';

import {
  CALIBRATION,
  HIGH_CONTRAST,
  ICE_ALPHA,
  PALETTE,
  QUALITY_PRESETS,
  SMOKE_ALPHA,
  TANK_SKIN_KEYS,
  TERRAIN_GLOSS,
  applyHighContrast,
  createMaterials,
  faceTint,
  graphicSurface,
  litSurface,
  luma601,
  scaleToken,
  tankToken,
  worstPlayerEnemySeparation,
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
  ['enemyFastTrim', 0xe08b3a],
  ['enemyPower', 0x8f6bd0],
  ['enemyArmor', 0xc3cad6],
  ['enemyArmorHp3', 0x9fbb84],
  ['enemyArmorHp2', 0xb8963c],
  ['enemyArmorHp1', 0x6e7684],

  // Art §3.1 gained this row with T3.3: §4 asks the eagle for a "stone
  // pedestal" and §3.1 authored a colour for its emblem and none for the stone.
  ['eagleStone', 0x8d94a3],

  // …and this one with T4.1/T4.2, by the same rule: art §8 asks for smoke in
  // five of its twelve rows and §3.1 authored no colour for it.
  ['smoke', 0x7a808f],

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

  it('caps smoke at art §11’s 0.35, in the material itself', () => {
    // Art §11's readability rule, delivered by construction: `InstancedMesh`
    // has no per-instance alpha, so every puff on the board shares this one
    // number and no combination of events can push one past the cap.
    expect(SMOKE_ALPHA).toBe(0.35);
    const mats = createMaterials();
    expect(mats.fxSmoke.opacity).toBe(SMOKE_ALPHA);
    expect(mats.fxSmoke.transparent).toBe(true);
    mats.dispose();
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
    | 'bulletTrail'
    | 'spawnStar'
    | 'tierTip'
    | 'propStone'
    | 'propGold'
    | 'fxDebris'
    | 'fxSmoke'
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
    'bulletTrail',
    'spawnStar',
    'tierTip',
    // Art §6's definitive list: "props and power-ups" are lit objects.
    'propStone',
    'propGold',
    // T4.1/T4.2: debris and smoke are things the light falls on — a brick chunk
    // is a piece of the wall it came out of, and a smoke puff lit by an
    // explosion is the whole point of art §1's second pillar.
    'fxDebris',
    'fxSmoke',
  ];

  /**
   * The FX surfaces that ARE light rather than objects lit by it. Art §8's
   * spawn-star ruling is the precedent: unlit + `toneMapped = false`, so ACES
   * at the calibrated 0.70 exposure cannot desaturate a spark before art §7's
   * bloom sees it.
   */
  const ADDITIVE: readonly (
    'fxSpark' | 'fxRing' | 'fxFlash' | 'fxScreenFlash'
  )[] = ['fxSpark', 'fxRing', 'fxFlash', 'fxScreenFlash'];

  it.each(ADDITIVE)('%s is an unlit additive light graphic', (key) => {
    const mats = createMaterials();
    const m = mats[key];
    expect(m).toBeInstanceOf(MeshBasicMaterial);
    expect(m.toneMapped).toBe(false);
    expect(m.blending).toBe(AdditiveBlending);
    expect(m.transparent).toBe(true);
    // Additive has no ordering requirement, but writing depth would let one
    // spark occlude the next; testing depth is what keeps a spark behind a
    // steel wall behind it.
    expect(m.depthWrite).toBe(false);
    expect(m.depthTest).toBe(key !== 'fxScreenFlash');
    mats.dispose();
  });

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

describe('entity materials (art §4)', () => {
  it('keeps vertexColors OFF on every tank skin', () => {
    // T2.4's mechanism: a tank is one `InstancedMesh` per type whose instances
    // are PARTS, and all trim rides on `instanceColor`. Turning this on would
    // make three declare an `attribute vec3 color` the shared part geometry
    // does not carry — an unbound attribute reads (0,0,0) in WebGL2, so every
    // tank would render black.
    const mats = createMaterials();
    for (const key of [
      'player1',
      'player2',
      'enemyBasic',
      'enemyFast',
      'enemyPower',
      'enemyArmor',
    ] as const) {
      expect(mats[key].vertexColors, key).toBe(false);
    }
    mats.dispose();
  });

  it('gives the tracer its own dimmer, additive material', () => {
    // It cannot share the bullet's: three applies vertex/instance colour to
    // `diffuseColor` only and never to `emissive`, so a trail drawn as extra
    // instances of the head mesh would glow at the head's brightness however it
    // was tinted. The falloff has to come from the material.
    const mats = createMaterials();
    expect(mats.bulletTrail.emissiveIntensity).toBeLessThan(
      mats.bullet.emissiveIntensity,
    );
    expect(mats.bulletTrail.blending).toBe(AdditiveBlending);
    expect(mats.bulletTrail.transparent).toBe(true);
    expect(mats.bulletTrail.depthWrite).toBe(false);
    // Same authored token as the head — it is the same tracer, fading.
    expect(mats.bulletTrail.color.getHexString()).toBe('ffd76b');
    expect(mats.bullet.depthWrite).toBe(true);
    mats.dispose();
  });
});

describe('faceTint — the ratio that keeps material.color the authored token', () => {
  it('multiplies the base back onto the detail token', () => {
    // The property every consumer rests on: `base × faceTint(detail, base)` is
    // `detail`, in the linear space the shader multiplies in.
    const base = new Color(PALETTE.enemyArmor);
    const detail = new Color(PALETTE.powerupGold);
    const t = faceTint(PALETTE.powerupGold, PALETTE.enemyArmor);
    expect(base.r * t[0]).toBeCloseTo(detail.r, 6);
    expect(base.g * t[1]).toBeCloseTo(detail.g, 6);
    expect(base.b * t[2]).toBeCloseTo(detail.b, 6);
  });

  it('is 1 for a token against itself, and never divides by zero', () => {
    expect(faceTint(PALETTE.brickTop, PALETTE.brickTop)).toEqual([1, 1, 1]);
    // A channel the base does not carry cannot be reached by a multiplier, so
    // the ratio degrades to "leave it alone" rather than to Infinity.
    expect(faceTint(0xffffff, 0x000000)).toEqual([1, 1, 1]);
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

describe('high-contrast mode (art §11 — required, not optional)', () => {
  // The scale every number in this block is quoted on: ITU-R BT.601 luma over
  // the gamma-encoded sRGB bytes, 0–255. It is the scale art §11's own finding
  // ("~18 luminance points") is on — see `luma601`'s comment for the three
  // other scales that give three other answers for the same pair.
  const PLAYERS = ['player1', 'player2'] as const;
  const ENEMIES = [
    'enemyBasic',
    'enemyFast',
    'enemyPower',
    'enemyArmor',
  ] as const;

  it('reproduces art §11’s measurement, so the scale is the doc’s', () => {
    const gap = Math.abs(
      luma601(PALETTE.player1) - luma601(PALETTE.enemyBasic),
    );
    expect(gap).toBeCloseTo(18.4, 1);
  });

  it('finds a worse pair than the one §11 quotes', () => {
    // §11 cites gold-vs-gunmetal at ~18. Gold against enemy SAND is 2.6 — the
    // two are nearly the same value, and a grayscale frame cannot tell a
    // player's tank from a Fast enemy at all.
    const gap = Math.abs(luma601(PALETTE.player1) - luma601(PALETTE.enemyFast));
    expect(gap).toBeLessThan(3);
    expect(worstPlayerEnemySeparation(false)).toBeCloseTo(gap, 6);
  });

  it('measurably fixes the separation', () => {
    const before = worstPlayerEnemySeparation(false);
    const after = worstPlayerEnemySeparation(true);
    expect(before).toBeLessThan(3);
    expect(after).toBeGreaterThan(55);
    // The bar this mode exists to clear: every player reads brighter than every
    // enemy, by a margin no hue confusion can close.
    expect(after / before).toBeGreaterThan(20);
  });

  it('puts every player above every enemy, in value alone', () => {
    for (const p of PLAYERS) {
      for (const e of ENEMIES) {
        expect(
          luma601(tankToken(p, true)),
          `${p} must out-value ${e}`,
        ).toBeGreaterThan(luma601(tankToken(e, true)) + 55);
      }
    }
  });

  it('keeps players inside the authored palette', () => {
    // Not invented colours: each player wears its own §3.1 accent token, i.e.
    // the brightest value the palette already authors for that tank's family.
    expect(tankToken('player1', true)).toBe(PALETTE.player1Accent);
    expect(tankToken('player2', true)).toBe(PALETTE.player2Accent);
  });

  it('scales all four enemies by one factor, preserving hue and order', () => {
    for (const e of ENEMIES) {
      expect(tankToken(e, true)).toBe(
        scaleToken(PALETTE[e], HIGH_CONTRAST.ENEMY_SCALE),
      );
    }
    // A uniform multiply cannot reorder them, which is what keeps the Armor HP
    // ramp (a ratio table against `enemyArmor`) reading in the right direction.
    const order = (hc: boolean): number[] =>
      ENEMIES.map((e) => luma601(tankToken(e, hc)));
    const rank = (xs: number[]): number[] =>
      xs.map((x) => xs.filter((y) => y < x).length);
    expect(rank(order(true))).toEqual(rank(order(false)));
  });

  it('keeps the darkest enemy well clear of the board it sits on', () => {
    const board = luma601(PALETTE.board);
    for (const e of ENEMIES) {
      expect(luma601(tankToken(e, true))).toBeGreaterThan(board * 3);
    }
  });

  it('brightens the tracer (art §11’s second half)', () => {
    const m = createMaterials();
    const opacity = m.bulletTrail.opacity;
    const emissive = m.bulletTrail.emissiveIntensity;
    applyHighContrast(m, true);
    expect(m.bulletTrail.opacity).toBeGreaterThan(opacity);
    expect(m.bulletTrail.emissiveIntensity).toBeGreaterThan(emissive);
    m.dispose();
  });

  it('is a pure function of the flag — toggling off restores every token', () => {
    const m = createMaterials();
    const before = TANK_SKIN_KEYS.map((k) => m[k].color.getHex());
    applyHighContrast(m, true);
    expect(TANK_SKIN_KEYS.map((k) => m[k].color.getHex())).not.toEqual(before);
    applyHighContrast(m, true); // idempotent
    applyHighContrast(m, false);
    expect(TANK_SKIN_KEYS.map((k) => m[k].color.getHex())).toEqual(before);
    expect(m.bulletTrail.opacity).toBe(0.55);
    m.dispose();
  });

  it('leaves the authored tokens alone when it is off — art §3.0’s promise', () => {
    for (const key of TANK_SKIN_KEYS) {
      expect(tankToken(key, false)).toBe(PALETTE[key]);
    }
  });
});
