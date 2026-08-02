// tests/render/models.test.ts — the procedural tank/bullet models and the
// per-entity animation bookkeeping, in the Vitest **node** environment. There is
// no DOM and no WebGL here, so nothing in this file constructs a `WebGLRenderer`;
// everything it asserts is either a pure function, a frozen data table, or an
// `InstancedMesh` — which, like a `Scene` or a `BufferGeometry`, needs no GL
// context (the same reach `terrainView.test.ts` established for the terrain view).
//
// What is deliberately NOT here: rendered pixels. Silhouette readability, the
// grayscale bar (art §11) and the calibration numbers are verified by the
// screenshot checklist and by `npm run calibrate:lighting`, per the task brief.

import { describe, expect, it } from 'vitest';

import { Color, InstancedMesh, Matrix4, Scene, Vector3 } from 'three';

import {
  ARMOR_HP,
  ENEMY_CAP,
  SPAWN_ANIM_S,
  TANK_SIZE,
} from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import type { GameState, LevelData, Tank } from '../../src/core/types';
import { PALETTE, createMaterials } from '../../src/render/materials';
import {
  ARMOR_HP_TINT,
  TANK_MODELS,
  TANK_PROBE,
  TANK_TYPES,
  countRole,
  createBulletGeometry,
  createPartGeometry,
  modelBounds,
  tankTypeOf,
  type TankType,
} from '../../src/render/models';
import { createSceneRoot } from '../../src/render/sceneRoot';
import {
  HIT_FLASH_MS,
  RECOIL_MS,
  RECOIL_U,
  TRACK_STEP_U,
  armorTintIndex,
  carrierPulseAt,
  createTankPool,
  createTankView,
  hitFlashAt,
  recoilAt,
  shortestAngle,
  trackStepOf,
  treadShiftOf,
  wrapTread,
  type TankView,
} from '../../src/render/tankView';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

function game(players: 1 | 2 = 2): GameState {
  return createGame(OPEN, { players, seed: 1, stageNumber: 1 });
}

/** A bare enemy tank, enough for the pool and the view to key on. */
function enemy(id: number, ordinal: number): Tank {
  return {
    id,
    alive: true,
    kind: 'enemy',
    enemyType: 'basic',
    spawnOrdinal: ordinal,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    dir: 0,
    moving: false,
    sliding: false,
    slideV: 0,
    hp: 1,
    tier: 0,
    shieldT: 0,
    stunT: 0,
    frozenT: 0,
    spawningT: 0,
    bulletsAirborne: 0,
    fireHeld: false,
    aiTimerT: 0,
    aiTileX: 0,
    aiTileY: 0,
  };
}

// ---------------------------------------------------------------------------
// Art §4 — the silhouette recipes, as data
// ---------------------------------------------------------------------------

describe('TANK_MODELS — art §4’s shared proportions', () => {
  // Table-driven straight off art §4: "footprint 16×16 u, height ~10 u", with
  // Fast narrowed to 12 u and Armor given +2 u. Asserted as literals rather
  // than re-derived from the tables the code also uses — these are the numbers
  // a reader of the doc would check.
  const EXPECTED: readonly (readonly [
    TankType,
    { width: number; depth: number; height: number },
  ])[] = [
    ['p1', { width: 16, depth: 16, height: 10 }],
    ['p2', { width: 16, depth: 16, height: 10 }],
    ['basic', { width: 16, depth: 16, height: 10 }],
    // Art §4: "Fast | narrow hull (12 u wide)".
    ['fast', { width: 12, depth: 16, height: 10 }],
    ['power', { width: 16, depth: 16, height: 10 }],
    // Art §4: "Armor | tall stacked plates (+2 u height)".
    ['armor', { width: 16, depth: 16, height: 12 }],
  ];

  it.each(EXPECTED)('%s measures its art §4 box', (type, expected) => {
    expect(modelBounds(TANK_MODELS[type])).toEqual(expected);
  });

  it('covers exactly the six tank skins the palette authors', () => {
    expect([...TANK_TYPES].sort()).toEqual(
      ['armor', 'basic', 'fast', 'p1', 'p2', 'power'].sort(),
    );
    for (const type of TANK_TYPES) {
      expect(TANK_MODELS[type].type).toBe(type);
    }
  });

  it('gives every type art §4’s shared parts: two tracks, a turret, a barrel', () => {
    for (const type of TANK_TYPES) {
      const model = TANK_MODELS[type];
      expect(countRole(model, 'track'), `${type} tracks`).toBe(2);
      expect(countRole(model, 'turret'), `${type} turret`).toBe(1);
      expect(countRole(model, 'barrel'), `${type} barrel`).toBe(1);
      expect(countRole(model, 'tread'), `${type} tread rungs`).toBeGreaterThan(
        0,
      );
      // Armor's body is art §4's "stacked plates"; every other type has one
      // hull box. Either way the chassis is exactly one of the two.
      const body = countRole(model, 'hull') + countRole(model, 'plate');
      expect(body, `${type} hull/plates`).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps every chassis part inside the 16×16 u footprint, on the board', () => {
    // The barrel and the tier tip are the parts most likely to drift outside it,
    // and a barrel that overhangs reads as clipping into a wall the tank has not
    // reached. Overlays (spawn star, shield frame, stun stars) are deliberately
    // exempt: they are effects around the tank, not the tank.
    const OVERLAY = new Set(['star', 'shield', 'stun']);
    for (const type of TANK_TYPES) {
      for (const p of TANK_MODELS[type].parts) {
        if (OVERLAY.has(p.role)) continue;
        const tag = `${type}/${p.role}`;
        expect(Math.abs(p.x) + p.w / 2, `${tag} x`).toBeLessThanOrEqual(
          TANK_SIZE / 2 + 1e-9,
        );
        expect(Math.abs(p.z) + p.d / 2, `${tag} z`).toBeLessThanOrEqual(
          TANK_SIZE / 2 + 1e-9,
        );
        expect(
          p.y - p.h / 2,
          `${tag} sits on the board`,
        ).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('gives Armor its stacked plates and twin exhausts (art §4)', () => {
    const armor = TANK_MODELS.armor;
    expect(countRole(armor, 'plate')).toBeGreaterThanOrEqual(2);
    expect(countRole(armor, 'exhaust')).toBe(2);
    // …and the plates are what the HP tint addresses, so there has to be a
    // tint for every HP level the core can hand us.
    expect(ARMOR_HP_TINT).toHaveLength(ARMOR_HP);
  });

  it('gives Power its oversized barrel shroud, wider than the barrel', () => {
    const power = TANK_MODELS.power;
    const barrel = power.parts.find((p) => p.role === 'barrel');
    const shroud = power.parts.filter((p) => p.role === 'shroud');
    expect(barrel).toBeDefined();
    expect(shroud.length).toBeGreaterThanOrEqual(1);
    for (const s of shroud) {
      expect(s.w, 'shroud is oversized').toBeGreaterThan(barrel!.w);
    }
  });

  it('exposes Fast’s track fronts — the tracks reach further forward than the hull', () => {
    const fast = TANK_MODELS.fast;
    const front = (role: string): number =>
      Math.min(
        ...fast.parts.filter((p) => p.role === role).map((p) => p.z - p.d / 2),
      );
    expect(front('hull') - front('track')).toBeGreaterThan(3);
  });

  it('sets Basic’s turret further back than the players’, over a shorter hull', () => {
    // Art §4: "Basic | short hull, small turret set back". Both halves, as
    // numbers. Local −z is forward, so "further back" is a LARGER z.
    const turretZ = (t: TankType): number =>
      TANK_MODELS[t].parts.find((p) => p.role === 'turret')!.z;
    const hullDepth = (t: TankType): number =>
      TANK_MODELS[t].parts.find((p) => p.role === 'hull')!.d;
    expect(turretZ('basic')).toBeGreaterThan(turretZ('p1'));
    expect(hullDepth('basic')).toBeLessThan(hullDepth('p1'));
  });
});

describe('tier rings (art §4: +1 thin barrel ring per star tier)', () => {
  it('shows exactly `tier` rings, for every tier 0…3', () => {
    for (const type of ['p1', 'p2'] as const) {
      const rings = TANK_MODELS[type].parts.filter((p) => p.role === 'ring');
      expect(rings).toHaveLength(3);
      for (const tier of [0, 1, 2, 3] as const) {
        const shown = rings.filter((p) => (p.tier ?? 0) <= tier).length;
        expect(shown, `${type} tier ${tier}`).toBe(tier);
      }
    }
  });

  it('adds the gold barrel tip at tier 3 and never before', () => {
    for (const type of ['p1', 'p2'] as const) {
      const tips = TANK_MODELS[type].parts.filter((p) => p.role === 'tip');
      expect(tips).toHaveLength(1);
      expect(tips[0].tier).toBe(3);
    }
  });

  it('does not put tier hardware on enemies', () => {
    for (const type of ['basic', 'fast', 'power', 'armor'] as const) {
      expect(countRole(TANK_MODELS[type], 'ring')).toBe(0);
      expect(countRole(TANK_MODELS[type], 'tip')).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Trap 2 — `material.color` is the authored token, always
// ---------------------------------------------------------------------------

describe('art §3.0 — a tank material carries its authored token and nothing else', () => {
  const TOKENS: readonly (readonly [TankType, string])[] = [
    ['p1', 'd99c2b'],
    ['p2', '3aa655'],
    ['basic', '8a8f9c'],
    ['fast', 'c8a05a'],
    ['power', '8f6bd0'],
    ['armor', 'c3cad6'],
  ];

  it.each(TOKENS)('%s renders the §3.1 token as albedo', (type, hex) => {
    // The trap terrain has a test for and tanks did not: per-type trim (Basic's
    // red band, Power's shroud, the tier rings, the armor HP tint) must ride on
    // instance colour, never on `material.color` — art §3.0's promise and
    // `scripts/calibrate-lighting.ts` both read the material's own colour, so
    // assigning a trim token here would make the probe measure a surface that
    // is not on screen.
    const mats = createMaterials();
    const model = TANK_MODELS[type];
    expect(model.token).toBe(PALETTE[model.tokenKey]);
    expect(mats[model.material].color.getHexString()).toBe(hex);
    expect(model.token.toString(16).padStart(6, '0')).toBe(hex);
    mats.dispose();
  });

  it('expresses every trim as a RATIO against the type’s own token', () => {
    // A ratio, not an absolute colour: three multiplies the material colour by
    // the instance colour, so storing the ratio is exactly what lets
    // `material.color` stay equal to the token.
    //
    // The invariant is NOT "the ratio is small" — it is 41 in P2's red channel,
    // because P2's red is 0.024 in the linear working space and the cyan shield
    // it has to reach is 0.98. It is that **token × ratio is a real colour**,
    // which is what a ratio to an authored §3.1 detail token always produces
    // and what an absolute value smuggled into the attribute would not.
    const c = new Color();
    for (const type of TANK_TYPES) {
      const model = TANK_MODELS[type];
      c.setHex(model.token); // sRGB → the linear space the shader multiplies in
      const base = [c.r, c.g, c.b];
      for (const p of model.parts) {
        expect(p.tint, `${type}/${p.role}`).toHaveLength(3);
        for (let k = 0; k < 3; k++) {
          expect(Number.isFinite(p.tint[k]), `${type}/${p.role}`).toBe(true);
          expect(p.tint[k], `${type}/${p.role}`).toBeGreaterThan(0);
          expect(
            base[k] * p.tint[k],
            `${type}/${p.role} ch${k}`,
          ).toBeLessThanOrEqual(1.02);
        }
      }
      // At least one part is the material's own token, untouched — otherwise
      // the calibration probe has nothing on screen to measure.
      expect(
        model.parts.some((p) => p.tint.every((v) => v === 1)),
        `${type} has a PLAIN part`,
      ).toBe(true);
    }
  });

  it('does not turn vertex colours on — instance colour is the whole mechanism', () => {
    // `material.vertexColors = true` would make three declare an `attribute vec3
    // color` the shared part geometry does not carry, and an unbound attribute
    // reads (0,0,0) in WebGL2 — every tank would render black. `instanceColor`
    // alone defines USE_COLOR in the FRAGMENT prefix, which is what makes this
    // work without the attribute.
    const mats = createMaterials();
    for (const type of TANK_TYPES) {
      expect(mats[TANK_MODELS[type].material].vertexColors, type).toBe(false);
    }
    const geo = createPartGeometry();
    expect(geo.getAttribute('color')).toBeUndefined();
    geo.dispose();
    mats.dispose();
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('createPartGeometry — the one beveled primitive every part is scaled from', () => {
  it('is a unit box centred on the origin, so a part’s box IS its instance matrix', () => {
    const geo = createPartGeometry();
    const pos = geo.getAttribute('position');
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      for (const v of [pos.getX(i), pos.getY(i), pos.getZ(i)]) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    expect(max).toBeCloseTo(0.5, 6);
    expect(min).toBeCloseTo(-0.5, 6);
    geo.dispose();
  });

  it('is beveled — art §1’s "low-poly, beveled, slightly chunky"', () => {
    // A plain box has 8 distinct corner positions; a chamfered one has 24.
    const geo = createPartGeometry();
    const pos = geo.getAttribute('position');
    const seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      seen.add(`${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`);
    }
    expect(seen.size).toBe(24);
    geo.dispose();
  });

  it('has unit-length normals on every vertex', () => {
    const geo = createPartGeometry();
    const n = geo.getAttribute('normal');
    for (let i = 0; i < n.count; i++) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
    }
    geo.dispose();
  });

  it('builds a bullet capsule of art §4’s 4×4 u, long axis along z', () => {
    const geo = createBulletGeometry();
    geo.computeBoundingBox();
    const size = new Vector3();
    geo.boundingBox!.getSize(size);
    expect(size.x).toBeCloseTo(4, 3);
    expect(size.y).toBeCloseTo(4, 3);
    // Longer than it is wide, along the axis a bullet travels: local −z is
    // forward for every entity in this layer (see DIR_YAW).
    expect(size.z).toBeGreaterThan(size.x);
    geo.dispose();
  });
});

describe('TANK_PROBE — the calibration harness measures shipping geometry', () => {
  it('names a horizontal and a vertical sample point for every type', () => {
    for (const type of TANK_TYPES) {
      const probe = TANK_PROBE[type];
      const bounds = modelBounds(TANK_MODELS[type]);
      // The top probe sits ON the model's highest horizontal face…
      expect(probe.top[1], type).toBeCloseTo(bounds.height, 6);
      // …and the side probe on the southernmost untinted vertical face — the
      // hull, not the (shaded) track that actually reaches z = ±8, because the
      // hue this reports has to be the token's under the rig rather than the
      // token's times a shade.
      expect(probe.side[2], type).toBeGreaterThan(0);
      expect(probe.side[2], type).toBeLessThanOrEqual(bounds.depth / 2 + 1e-9);
      expect(probe.side[1], type).toBeGreaterThan(0);
      expect(probe.side[1], type).toBeLessThan(bounds.height);
    }
  });

  it('is frozen — the harness and the models cannot drift apart', () => {
    expect(Object.isFrozen(TANK_PROBE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Animation — pure
// ---------------------------------------------------------------------------

describe('track scroll (art §9: stepped, 8 u per visual step, rate ∝ speed)', () => {
  it('advances one step per 8 u travelled', () => {
    expect(TRACK_STEP_U).toBe(8);
    expect(trackStepOf(0)).toBe(0);
    expect(trackStepOf(7.9)).toBe(0);
    expect(trackStepOf(8)).toBe(1);
    expect(trackStepOf(23.5)).toBe(2);
  });

  it('is still while stationary and faster for a faster tank', () => {
    // Distance-driven, so "rate ∝ speed" is structural rather than tuned: over
    // the same second, Fast (60 u/s) covers twice Power's 45 — and a tank that
    // has not moved has not stepped.
    expect(trackStepOf(0)).toBe(0);
    expect(trackStepOf(60)).toBeGreaterThan(trackStepOf(30));
  });

  it('alternates the tread shift, so consecutive steps are visibly different', () => {
    expect(treadShiftOf(0)).toBe(0);
    expect(treadShiftOf(1)).toBeGreaterThan(0);
    expect(treadShiftOf(2)).toBe(treadShiftOf(0));
    expect(treadShiftOf(3)).toBe(treadShiftOf(1));
  });

  it('wraps a shifted rung back inside the track instead of off the end', () => {
    const span = 14;
    expect(wrapTread(0, span)).toBeCloseTo(0, 9);
    expect(wrapTread(6, span)).toBeCloseTo(6, 9);
    // Past the rear lip: comes back at the front, not 1 u outside the track.
    expect(wrapTread(7.5, span)).toBeCloseTo(-6.5, 9);
    expect(wrapTread(-7.5, span)).toBeCloseTo(6.5, 9);
  });
});

describe('turret recoil (art §9: 2 u back, 80 ms out-back ease)', () => {
  it('starts and ends at rest and peaks at the full 2 u', () => {
    expect(RECOIL_MS).toBe(80);
    expect(RECOIL_U).toBe(2);
    expect(recoilAt(-1)).toBe(0);
    expect(recoilAt(0)).toBe(0);
    expect(recoilAt(RECOIL_MS)).toBe(0);
    expect(recoilAt(RECOIL_MS + 50)).toBe(0);
    let peak = 0;
    for (let ms = 0; ms <= RECOIL_MS; ms += 0.5) {
      peak = Math.max(peak, recoilAt(ms));
      expect(recoilAt(ms)).toBeGreaterThanOrEqual(0);
      expect(recoilAt(ms)).toBeLessThanOrEqual(RECOIL_U + 1e-9);
    }
    expect(peak).toBeCloseTo(RECOIL_U, 6);
  });

  it('goes out faster than it comes back — that is what "out-back" means', () => {
    // A symmetric curve reads as a wobble rather than as a shot: the strike is
    // a small fraction of the window and the return owns the rest.
    let peakAt = 0;
    for (let ms = 0; ms <= RECOIL_MS; ms += 0.5) {
      if (recoilAt(ms) > recoilAt(peakAt)) peakAt = ms;
    }
    expect(peakAt).toBeLessThan(RECOIL_MS / 2);
  });
});

describe('hit flash (art §9: white 60 ms, every tank)', () => {
  it('is full at the moment of the hit and gone at 60 ms', () => {
    expect(HIT_FLASH_MS).toBe(60);
    expect(hitFlashAt(0)).toBeCloseTo(1, 6);
    expect(hitFlashAt(30)).toBeCloseTo(0.5, 6);
    expect(hitFlashAt(HIT_FLASH_MS)).toBe(0);
    expect(hitFlashAt(-1)).toBe(0);
    expect(hitFlashAt(1000)).toBe(0);
  });
});

describe('carrier pulse (art §9: 4 Hz square)', () => {
  it('is a square wave with a 250 ms period', () => {
    expect(carrierPulseAt(0)).toBe(1);
    expect(carrierPulseAt(100)).toBe(1);
    expect(carrierPulseAt(130)).toBe(0);
    expect(carrierPulseAt(240)).toBe(0);
    expect(carrierPulseAt(260)).toBe(1);
  });
});

describe('armor HP tint (fidelity §3.2: silver → green → yellow → dark-silver)', () => {
  it('maps 4 HP down to 1 onto the four tints, in order', () => {
    expect(armorTintIndex(4)).toBe(0);
    expect(armorTintIndex(3)).toBe(1);
    expect(armorTintIndex(2)).toBe(2);
    expect(armorTintIndex(1)).toBe(3);
  });

  it('clamps rather than reading off the end of the table', () => {
    expect(armorTintIndex(99)).toBe(0);
    expect(armorTintIndex(0)).toBe(ARMOR_HP_TINT.length - 1);
    expect(armorTintIndex(-3)).toBe(ARMOR_HP_TINT.length - 1);
  });

  it('starts at the untouched silver token and darkens at the end', () => {
    // Full HP has to be the material's own token — an armor tank at 4 HP is
    // what the calibration probe measures.
    expect([...ARMOR_HP_TINT[0]]).toEqual([1, 1, 1]);
    const lum = (t: readonly number[]): number =>
      0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
    expect(lum(ARMOR_HP_TINT[3])).toBeLessThan(lum(ARMOR_HP_TINT[0]));
  });
});

describe('shortestAngle — a 100 ms turn ease must not take the long way round', () => {
  it('crosses the ±π seam by the short arc', () => {
    const P = Math.PI;
    expect(shortestAngle(P - 0.1, -P + 0.1)).toBeCloseTo(0.2, 6);
    expect(shortestAngle(-P + 0.1, P - 0.1)).toBeCloseTo(-0.2, 6);
    expect(shortestAngle(0, P / 2)).toBeCloseTo(P / 2, 6);
    expect(shortestAngle(0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trap 1 — pooling keyed by identity, not by compaction order
// ---------------------------------------------------------------------------

describe('createTankPool — identity keyed on Tank.id (the T2.3 review’s trap 1)', () => {
  it('hands out slots in acquisition order and keeps id → slot both ways', () => {
    const pool = createTankPool();
    expect(pool.acquire(enemy(2, 1))).toBe(0);
    expect(pool.acquire(enemy(3, 2))).toBe(1);
    expect(pool.acquire(enemy(4, 3))).toBe(2);
    expect(pool.count).toBe(3);
    expect(pool.slotOf(3)).toBe(1);
    expect(pool.keyAt(2)).toBe(4);
  });

  it('re-acquiring is idempotent — the frame loop calls it unconditionally', () => {
    const pool = createTankPool();
    const t = enemy(5, 1);
    expect(pool.acquire(t)).toBe(0);
    expect(pool.acquire(t)).toBe(0);
    expect(pool.count).toBe(1);
  });

  it('a mid-pool death does not migrate per-entity state to another tank', () => {
    // THE regression this whole scheme exists for. Four enemies of one type
    // share one InstancedMesh, so their slots compact on a death and anything
    // addressed by SLOT would follow the compaction onto the wrong tank. Track
    // phase, recoil and HP tint are addressed by **id**; the slot map is only
    // ever asked where to write the matrices.
    const pool = createTankPool();
    const ids = [2, 3, 4, 5];
    ids.forEach((id, i) => pool.acquire(enemy(id, i + 1)));

    // Give each tank a distinct history — different distances travelled, one
    // mid-recoil, one mid-flash, all four on different HP.
    ids.forEach((id, i) => {
      const s = pool.state(id);
      s.distance = (i + 1) * 11;
      s.recoilMs = i === 1 ? 20 : -1;
      s.flashMs = i === 3 ? 10 : -1;
      s.hp = 4 - i;
    });
    const before = ids.map((id) => ({ ...pool.state(id) }));

    // Kill the tank in slot 1. Slot 3's instances back-fill into slot 1.
    pool.release(3);
    expect(pool.count).toBe(3);
    expect(pool.slotOf(3)).toBe(-1);
    expect(pool.slotOf(5)).toBe(1); // followed its matrices into the hole

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === 3) continue;
      const slot = pool.slotOf(id);
      expect(slot, `id ${id} still has a slot`).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(pool.count);
      expect(pool.keyAt(slot)).toBe(id);
      // …and every one of its animation fields is untouched.
      const s = pool.state(id);
      expect(s.distance, `id ${id} track phase`).toBe(before[i].distance);
      expect(s.recoilMs, `id ${id} recoil`).toBe(before[i].recoilMs);
      expect(s.flashMs, `id ${id} flash`).toBe(before[i].flashMs);
      expect(s.hp, `id ${id} HP tint`).toBe(before[i].hp);
    }
  });

  it('two tanks advanced at different speeds keep different track phases', () => {
    const pool = createTankPool();
    pool.acquire(enemy(2, 1));
    pool.acquire(enemy(3, 2));
    // One second at 30 u/s and at 60 u/s.
    pool.state(2).distance = 30;
    pool.state(3).distance = 60;
    expect(trackStepOf(pool.state(2).distance)).not.toBe(
      trackStepOf(pool.state(3).distance),
    );

    // A third tank between them dies. The phases must not swap.
    pool.acquire(enemy(4, 3));
    pool.state(4).distance = 45;
    pool.release(4);
    expect(pool.state(2).distance).toBe(30);
    expect(pool.state(3).distance).toBe(60);
  });

  it('resets state when a dead enemy’s array slot is recycled into a new tank', () => {
    // `spawner.ts` reuses a dead enemy's slot and KEEPS its id, so id alone is
    // not identity: tank 2 can be a Basic, die, and come back as an Armor. A
    // pool keyed on id alone would hand the new tank the old one's track phase
    // and half-finished recoil.
    const pool = createTankPool();
    pool.acquire(enemy(2, 1));
    pool.state(2).distance = 99;
    pool.state(2).recoilMs = 40;
    pool.release(2);

    const recycled = enemy(2, 7); // same id, seventh enemy of the stage
    recycled.enemyType = 'armor';
    pool.acquire(recycled);
    expect(pool.state(2).distance).toBe(0);
    expect(pool.state(2).recoilMs).toBeLessThan(0);
  });

  it('clear() empties it without losing the identity map', () => {
    const pool = createTankPool();
    pool.acquire(enemy(2, 1));
    pool.acquire(enemy(3, 2));
    pool.clear();
    expect(pool.count).toBe(0);
    expect(pool.slotOf(2)).toBe(-1);
    expect(pool.acquire(enemy(4, 3))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The view itself — an InstancedMesh needs no GL context
// ---------------------------------------------------------------------------

interface Mounted {
  view: TankView;
  scene: Scene;
  meshes: Record<TankType, InstancedMesh>;
  dispose(): void;
}

function mount(): Mounted {
  const mats = createMaterials();
  const root = createSceneRoot(mats);
  const view = createTankView(mats, root);
  const found: Partial<Record<TankType, InstancedMesh>> = {};
  root.scene.traverse((o) => {
    if (!(o instanceof InstancedMesh)) return;
    for (const type of TANK_TYPES) {
      if (o.material === mats[TANK_MODELS[type].material]) found[type] = o;
    }
  });
  for (const type of TANK_TYPES) {
    if (!found[type]) {
      throw new Error(`tank mesh ${type} not found in the scene`);
    }
  }
  return {
    view,
    scene: root.scene,
    meshes: found as Record<TankType, InstancedMesh>,
    dispose(): void {
      view.dispose();
      root.dispose();
      mats.dispose();
    },
  };
}

/** World translations of a mesh's live instances. */
function translations(mesh: InstancedMesh): Vector3[] {
  const m = new Matrix4();
  const out: Vector3[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    out.push(new Vector3(m.elements[12], m.elements[13], m.elements[14]));
  }
  return out;
}

/** The world z of every instance whose scale matches `part`, near `centreX`. */
function zsOfPart(
  mesh: InstancedMesh,
  part: { w: number; h: number; d: number },
  centreX: number,
): number[] {
  const m = new Matrix4();
  const out: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    const e = m.elements;
    if (
      Math.abs(e[0] - part.w) > 1e-6 ||
      Math.abs(e[5] - part.h) > 1e-6 ||
      Math.abs(e[10] - part.d) > 1e-6
    ) {
      continue;
    }
    if (Math.abs(e[12] - centreX) > TANK_SIZE) continue;
    out.push(e[14]);
  }
  return out.sort((a, b) => a - b);
}

describe('TankView — the shipped path', () => {
  it('draws nothing before the first state and one slot’s parts per live tank', () => {
    const m = mount();
    for (const type of TANK_TYPES) {
      expect(m.meshes[type].count, type).toBe(0);
    }

    const state = game(2);
    m.view.update(state, 1, 16);
    // Two players are alive at stage start; no enemy has materialised yet.
    expect(m.meshes.p1.count).toBe(TANK_MODELS.p1.parts.length);
    expect(m.meshes.p2.count).toBe(TANK_MODELS.p2.parts.length);
    expect(m.meshes.basic.count).toBe(0);
    m.dispose();
  });

  it('places a tank at its interpolated centre, not at its AABB corner', () => {
    const m = mount();
    const state = game(1);
    const p1 = state.tanks[0];
    p1.prevX = 0;
    p1.prevY = 0;
    p1.x = 32;
    p1.y = 64;
    m.view.update(state, 0.5, 16);
    const at = translations(m.meshes.p1);
    const cx = 16 + TANK_SIZE / 2;
    const cz = 32 + TANK_SIZE / 2;
    for (const v of at) {
      expect(Math.abs(v.x - cx)).toBeLessThan(TANK_SIZE);
      expect(Math.abs(v.z - cz)).toBeLessThan(TANK_SIZE);
    }
    m.dispose();
  });

  it('reaches the endpoint EXACTLY at alpha 1 — every paused frame is one', () => {
    const m = mount();
    const state = game(1);
    const p1 = state.tanks[0];
    p1.prevX = 0;
    p1.prevY = 0;
    p1.x = 33;
    p1.y = 65;
    m.view.update(state, 1, 16);
    const idx = TANK_MODELS.p1.parts.findIndex((p) => p.role === 'track');
    const part = TANK_MODELS.p1.parts[idx];
    const at = translations(m.meshes.p1)[idx];
    expect(at.x).toBe(33 + TANK_SIZE / 2 + part.x);
    expect(at.z).toBe(65 + TANK_SIZE / 2 + part.z);
    m.dispose();
  });

  it('drops a dead tank’s instances and keeps every survivor’s own track phase', () => {
    // The trap-1 regression, end to end: four Basic enemies share one
    // InstancedMesh, each has driven a different distance, and the middle one
    // dies. Every survivor must still be drawn with ITS OWN tread phase — not
    // with the phase of whichever tank compacted into its slot.
    const m = mount();
    const state = game(1);
    const made: Tank[] = [];
    for (let i = 0; i < 4; i++) {
      const t = enemy(state.tanks.length, i + 1);
      t.x = i * 40;
      t.prevX = t.x;
      state.tanks.push(t);
      made.push(t);
    }
    const parts = TANK_MODELS.basic.parts.length;
    const tread = TANK_MODELS.basic.parts.find((p) => p.role === 'tread')!;
    m.view.update(state, 1, 16);
    expect(m.meshes.basic.count).toBe(4 * parts);

    // Drive each of them a different distance, one frame at a time.
    for (let step = 0; step < 4; step++) {
      for (let i = 0; i < made.length; i++) {
        made[i].prevX = made[i].x;
        // 5 u a frame, so the four tanks land on steps 2 / 5 / 7 / 10 — the
        // parity that makes their tread shifts actually differ.
        made[i].x += (i + 1) * 5;
      }
      m.view.update(state, 1, 16);
    }
    const before = made.map((t) =>
      zsOfPart(m.meshes.basic, tread, t.x + TANK_SIZE / 2),
    );
    // Different distances ⇒ different phases, or the test proves nothing.
    expect(before[0]).not.toEqual(before[1]);

    made[1].alive = false;
    m.view.update(state, 1, 16);
    expect(m.meshes.basic.count).toBe(3 * parts);

    for (let i = 0; i < made.length; i++) {
      if (i === 1) continue;
      expect(
        zsOfPart(m.meshes.basic, tread, made[i].x + TANK_SIZE / 2),
        `tank ${i} tread phase`,
      ).toEqual(before[i]);
    }
    m.dispose();
  });

  it('recoils only the tank that fired', () => {
    const m = mount();
    const state = game(2);
    m.view.update(state, 1, 16);
    const barrelZ = (type: TankType): number => {
      const model = TANK_MODELS[type];
      const idx = model.parts.findIndex((p) => p.role === 'barrel');
      const mat = new Matrix4();
      m.meshes[type].getMatrixAt(idx, mat);
      return mat.elements[14];
    };
    const p1Rest = barrelZ('p1');
    const p2Rest = barrelZ('p2');

    m.view.onEvent({
      t: 'shotFired',
      tankId: 0,
      x: 0,
      y: 0,
      dir: 0,
      byPlayer: true,
    });
    m.view.update(state, 1, RECOIL_MS / 4);
    // Both tanks face Up and local −z is forward, so a recoil moves the barrel
    // south — +z in world space.
    expect(barrelZ('p1')).toBeGreaterThan(p1Rest);
    expect(barrelZ('p2')).toBe(p2Rest);
    m.dispose();
  });

  it('flashes white on a hit and settles back', () => {
    const m = mount();
    const state = game(1);
    m.view.update(state, 1, 16);
    const hull = TANK_MODELS.p1.parts.findIndex((p) => p.role === 'hull');
    const c = new Color();
    m.meshes.p1.getColorAt(hull, c);
    const rest = c.r;

    m.view.onEvent({ t: 'tankHit', tankId: 0, hpLeft: 1 });
    m.view.update(state, 1, 1);
    m.meshes.p1.getColorAt(hull, c);
    expect(c.r).toBeGreaterThan(rest);

    m.view.update(state, 1, HIT_FLASH_MS);
    m.meshes.p1.getColorAt(hull, c);
    expect(c.r).toBeCloseTo(rest, 6);
    m.dispose();
  });

  it('tints an Armor tank’s plates by HP, and only its plates', () => {
    const m = mount();
    const state = game(1);
    const t = enemy(state.tanks.length, 1);
    t.enemyType = 'armor';
    t.hp = ARMOR_HP;
    state.tanks.push(t);
    m.view.update(state, 1, 16);

    const model = TANK_MODELS.armor;
    const plate = model.parts.findIndex((p) => p.role === 'plate');
    const track = model.parts.findIndex((p) => p.role === 'track');
    const c = new Color();
    m.meshes.armor.getColorAt(plate, c);
    const plateFull = c.r;
    m.meshes.armor.getColorAt(track, c);
    const trackFull = c.r;

    t.hp = 1;
    // Past the 150 ms crossfade, so the tint has landed.
    m.view.update(state, 1, 400);
    m.meshes.armor.getColorAt(plate, c);
    expect(c.r).not.toBeCloseTo(plateFull, 3);
    m.meshes.armor.getColorAt(track, c);
    expect(c.r).toBeCloseTo(trackFull, 6);
    m.dispose();
  });

  it('hides the tank and shows the spawn star while spawningT > 0', () => {
    const m = mount();
    const state = game(1);
    const t = enemy(state.tanks.length, 1);
    t.spawningT = SPAWN_ANIM_S;
    state.tanks.push(t);
    m.view.update(state, 1, 16);

    const model = TANK_MODELS.basic;
    const mat = new Matrix4();
    const scaleOf = (role: string): number => {
      const idx = model.parts.findIndex((p) => p.role === role);
      m.meshes.basic.getMatrixAt(idx, mat);
      return Math.hypot(mat.elements[0], mat.elements[1], mat.elements[2]);
    };
    expect(scaleOf('hull')).toBe(0);
    expect(scaleOf('star')).toBeGreaterThan(0);

    t.spawningT = 0;
    m.view.update(state, 1, 16);
    expect(scaleOf('hull')).toBeGreaterThan(0);
    expect(scaleOf('star')).toBe(0);
    m.dispose();
  });

  it('sizes each mesh for the tanks the core can actually put on the field', () => {
    // 2 players + ENEMY_CAP enemies, and every enemy may be the same type.
    const m = mount();
    for (const type of ['basic', 'fast', 'power', 'armor'] as const) {
      const slots =
        m.meshes[type].instanceMatrix.count / TANK_MODELS[type].parts.length;
      expect(slots, type).toBeGreaterThanOrEqual(ENEMY_CAP);
    }
    m.dispose();
  });

  it('adds nothing to the scene graph after the first frame', () => {
    const m = mount();
    const state = game(2);
    m.view.update(state, 1, 16);
    const count = (): number => {
      let n = 0;
      m.scene.traverse(() => {
        n++;
      });
      return n;
    };
    const before = count();
    for (let i = 0; i < 30; i++) {
      m.view.update(state, i / 30, 16);
    }
    expect(count()).toBe(before);
    m.dispose();
  });
});

describe('tankTypeOf — the skin a tank wears', () => {
  it('maps players by index and enemies by type', () => {
    const state = game(2);
    expect(tankTypeOf(state.tanks[0])).toBe('p1');
    expect(tankTypeOf(state.tanks[1])).toBe('p2');
    const e = enemy(2, 1);
    for (const type of ['basic', 'fast', 'power', 'armor'] as const) {
      e.enemyType = type;
      expect(tankTypeOf(e)).toBe(type);
    }
  });
});
