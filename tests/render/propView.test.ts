// tests/render/propView.test.ts — the eagle and the six power-ups (T3.3), in
// the Vitest **node** environment. Same reach as `models.test.ts`: no DOM and no
// WebGL, so everything here is either a pure table, a pure curve, or an
// `InstancedMesh` — which needs no GL context.
//
// What is deliberately NOT here: rendered pixels. Whether the intact eagle reads
// as something worth defending, whether the ruin reads as a loss, and whether
// the six shapes separate in grayscale are questions only a screenshot can
// answer, and `scripts/capture-entities.ts` is where they are asked.
//
// What IS here is everything a screenshot cannot check cheaply: that the tables
// say what art §4 and fidelity §2/§8 say, that `material.color` is still the
// authored token everywhere, that the view resolves state to geometry, that the
// eagle lands on the right model from the flag alone, and that a paused frame is
// a still frame.

import { describe, expect, it } from 'vitest';

import { Color, InstancedMesh, Matrix4, Vector3 } from 'three';

import { EAGLE_TILE, POWERUP_TYPES, TILE } from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import type { GameState, LevelData, PowerupType } from '../../src/core/types';
import { PALETTE, createMaterials, faceTint } from '../../src/render/materials';
import {
  BILLBOARD_X,
  EAGLE_MODELS,
  EAGLE_PROBE,
  FALLEN_DIM,
  POWERUP_BOB_MS,
  POWERUP_BOB_U,
  POWERUP_HOVER_U,
  POWERUP_MODELS,
  POWERUP_RPS,
  animDtOf,
  countPropRole,
  eagleCentre,
  partBounds,
  powerupBobAt,
  powerupYawAt,
  propPartCentre,
  propSweepRadius,
  screenDepth,
  type PropModel,
  type PropPart,
} from '../../src/render/models';
import { createPropView, type PropView } from '../../src/render/propView';
import { createSceneRoot } from '../../src/render/sceneRoot';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

function game(): GameState {
  return createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 });
}

interface Mounted {
  view: PropView;
  stone: InstancedMesh;
  gold: InstancedMesh;
  scene: { traverse(cb: (o: object) => void): void };
  dispose(): void;
}

function mount(): Mounted {
  const mats = createMaterials();
  const root = createSceneRoot(mats);
  const view = createPropView(mats, root);
  let stone: InstancedMesh | null = null;
  let gold: InstancedMesh | null = null;
  root.scene.traverse((o) => {
    if (!(o instanceof InstancedMesh)) return;
    if (o.material === mats.propStone) stone = o;
    if (o.material === mats.propGold) gold = o;
  });
  if (stone === null || gold === null) {
    throw new Error('prop meshes not found in the scene');
  }
  return {
    view,
    stone,
    gold,
    scene: root.scene,
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

/** The full 16-float matrix block a mesh currently holds, as a plain array. */
function matrixSnapshot(mesh: InstancedMesh): number[] {
  return Array.from(
    (mesh.instanceMatrix.array as Float32Array).slice(0, mesh.count * 16),
  );
}

// --- silhouette rasteriser -------------------------------------------------
//
// Art §2 pins the camera at yaw 0 and pitch `BILLBOARD_X` from vertical, so a
// model's screen silhouette is a constant: screen x is world x, screen y is
// `y·sin θ − z·cos θ`, and the sight line is `(0, cos θ, sin θ)`. This walks a
// fixed screen window and asks, per cell, whether that sight line meets any
// part — which is exactly what the renderer will draw, minus antialiasing.

const SIL_COS = Math.cos(BILLBOARD_X);
const SIL_SIN = Math.sin(BILLBOARD_X);
/** Screen window, in u. Wide enough for the widest model with room to spare. */
const SIL_X0 = -9;
const SIL_X1 = 9;
const SIL_Y0 = -8;
const SIL_Y1 = 10;
const SIL_N = 72;

/** Does the sight line through `(sx, sy)` meet this box? */
function raySeesPart(p: PropPart, sx: number, sy: number): boolean {
  // A point on the sight line: `y·sin − z·cos = sy` is satisfied by
  // `(sx, sy·sin, −sy·cos)`, since `sin² + cos² = 1`.
  const o = [sx, sy * SIL_SIN, -sy * SIL_COS];
  const dir = [0, SIL_COS, SIL_SIN];
  const lo = [p.x - p.w / 2, p.y - p.h / 2, p.z - p.d / 2];
  const hi = [p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2];
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (dir[k] === 0) {
      if (o[k] < lo[k] || o[k] > hi[k]) return false;
      continue;
    }
    const a = (lo[k] - o[k]) / dir[k];
    const b = (hi[k] - o[k]) / dir[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
}

function silhouette(model: PropModel): Uint8Array {
  const out = new Uint8Array(SIL_N * SIL_N);
  for (let j = 0; j < SIL_N; j++) {
    const sy = SIL_Y0 + ((j + 0.5) / SIL_N) * (SIL_Y1 - SIL_Y0);
    for (let i = 0; i < SIL_N; i++) {
      const sx = SIL_X0 + ((i + 0.5) / SIL_N) * (SIL_X1 - SIL_X0);
      for (const p of model.parts) {
        if (raySeesPart(p, sx, sy)) {
          out[j * SIL_N + i] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** Board coordinates → the billboard frame (the transpose of `Rx(θ)`). */
function toBillboardFrame(x: number, y: number, z: number): number[] {
  return [x, y * SIL_COS + z * SIL_SIN, -y * SIL_SIN + z * SIL_COS];
}

/** The parts whose extents are in BOARD space — i.e. everything but a billboard. */
function boardParts(m: PropModel): PropPart[] {
  return m.parts.filter((p) => p.billboard !== true);
}

/** Highest point of a model above the board, billboard tilt included. */
function topY(m: PropModel): number {
  return Math.max(
    ...m.parts.map((p) => {
      const half =
        p.billboard === true ? (p.h * SIL_COS + p.d * SIL_SIN) / 2 : p.h / 2;
      return propPartCentre(p)[1] + half;
    }),
  );
}

const ALL_MODELS: readonly (readonly [string, PropModel])[] = [
  ['eagle/intact', EAGLE_MODELS.intact],
  ['eagle/destroyed', EAGLE_MODELS.destroyed],
  ...POWERUP_TYPES.map(
    (t) => [`powerup/${t}`, POWERUP_MODELS[t]] as [string, PropModel],
  ),
];

// ---------------------------------------------------------------------------
// Art §4 / fidelity §2 — the eagle recipe, as data
// ---------------------------------------------------------------------------

describe('EAGLE_MODELS — art §4’s "stone pedestal + gold shield emblem"', () => {
  it('occupies fidelity §2’s 16×16 u tile in both states', () => {
    for (const state of ['intact', 'destroyed'] as const) {
      // Billboarded parts are excluded: their extents are in screen space, not
      // in board space, so they say nothing about a footprint (the same reason
      // `modelBounds` drops a tank's overlay roles).
      const b = partBounds(boardParts(EAGLE_MODELS[state]));
      expect(b.width, state).toBe(TILE);
      expect(b.depth, state).toBe(TILE);
    }
  });

  it('is a stone pedestal carrying a gold emblem while it stands', () => {
    const intact = EAGLE_MODELS.intact;
    // Art §4's recipe is two nouns, and both have to be present: a pedestal
    // with no emblem is a plinth, and an emblem with no pedestal is a sprite.
    expect(countPropRole(intact, 'stone')).toBeGreaterThanOrEqual(3);
    expect(countPropRole(intact, 'gold')).toBeGreaterThanOrEqual(3);
    // The emblem stands clear above the pedestal — measured in BOARD
    // coordinates, because the shield is billboarded and its authored `y` is a
    // depth offset rather than a height.
    const goldLow = Math.min(
      ...intact.parts
        .filter((p) => p.role === 'gold')
        .map((p) => propPartCentre(p)[1]),
    );
    const stoneTop = Math.max(
      ...intact.parts
        .filter((p) => p.role === 'stone')
        .map((p) => p.y + p.h / 2),
    );
    expect(goldLow).toBeGreaterThan(stoneTop);
  });

  it('reads as a loss: the ruin is shorter, darker and has no gold left', () => {
    // Art §4: "cracked pedestal, fallen dimmed emblem". This is the whole
    // game-over signal, so each of its three components is pinned rather than
    // left to a screenshot that a later edit would silently invalidate.
    //
    // 1. Height — the monument is gone, not damaged.
    expect(topY(EAGLE_MODELS.destroyed)).toBeLessThan(
      topY(EAGLE_MODELS.intact) * 0.45,
    );
    // 2. Emissive — nothing on the destroyed eagle is on the gold material at
    //    all, which is what makes "dimmed" true rather than a colour choice
    //    (`emissive` is a material property; no instance colour can dim it).
    expect(countPropRole(EAGLE_MODELS.destroyed, 'gold')).toBe(0);
    expect(countPropRole(EAGLE_MODELS.intact, 'gold')).toBeGreaterThan(0);
    // 3. Value — the ruin's brightest stone is well below the pedestal's, so
    //    the base goes dark as well as short.
    const brightestStone = (m: PropModel): number =>
      Math.max(
        ...m.parts
          // The fallen emblem is excluded: it is gold expressed against stone,
          // so its ratio is legitimately above 1 (see `faceTint`) and says
          // nothing about how dark the rubble is.
          .filter((p) => p.role === 'stone' && p.tint[0] === p.tint[1])
          .map((p) => Math.max(...p.tint)),
      );
    expect(brightestStone(EAGLE_MODELS.destroyed)).toBeLessThan(
      brightestStone(EAGLE_MODELS.intact) * 0.7,
    );
  });

  it('carries the fallen emblem as DIMMED GOLD on the stone material', () => {
    // The one place in this task where a colour is not a plain value shade:
    // `powerupGold` expressed as a ratio against `eagleStone`, halved. If this
    // ever becomes an absolute colour, `material.color` stops being the
    // authored token and the calibration probe measures a surface nobody sees.
    const expected = faceTint(PALETTE.powerupGold, PALETTE.eagleStone).map(
      (c) => c * FALLEN_DIM,
    );
    const fallen = EAGLE_MODELS.destroyed.parts.filter(
      (p) => p.tint[0] !== p.tint[1],
    );
    expect(fallen.length).toBeGreaterThanOrEqual(3);
    for (const p of fallen) {
      expect([...p.tint]).toEqual(expected);
    }
  });

  it('places the eagle at fidelity §2’s tile (6,12)', () => {
    expect([...EAGLE_TILE]).toEqual([6, 12]);
    expect(eagleCentre(EAGLE_TILE)).toEqual([104, 200]);
  });
});

describe('EAGLE_PROBE — what `calibrate-lighting.ts` is allowed to sample', () => {
  const [px, py, pz] = EAGLE_PROBE;

  it('sits on the top face of a real part of the intact model', () => {
    const on = EAGLE_MODELS.intact.parts.filter(
      (p) =>
        p.role === 'stone' &&
        Math.abs(p.y + p.h / 2 - py) < 1e-9 &&
        Math.abs(px - p.x) <= p.w / 2 &&
        Math.abs(pz - p.z) <= p.d / 2,
    );
    expect(on).toHaveLength(1);
    // …and it is EXACTLY the authored token, so `calibrate-lighting.ts` scores
    // art §6 target 1 against `eagleStone` and not against a shade of it.
    expect([...on[0].tint]).toEqual([1, 1, 1]);
    // …which also means nothing on the pedestal may be brighter than it, or the
    // probe would no longer be sampling the model's own highlight.
    for (const p of EAGLE_MODELS.intact.parts) {
      expect(Math.max(...p.tint), `${p.role} at y=${p.y}`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('is not hidden behind any other part of the model', () => {
    // Art §2 fixes the camera, so the sight line from the probe to it is a
    // constant and this is checkable without a renderer: cast that ray and
    // check it leaves the model. A probe behind the mast or the emblem measures
    // gold and reports it as stone — exactly the failure mode T2.3's first
    // canopy probe had (it sampled the board through a gap and reported −82%).
    //
    // `BILLBOARD_X` is the camera's pitch from vertical, so the direction back
    // to an orthographic camera at yaw 0 is `(0, cos, sin)`.
    const hits = (p: PropPart, from: readonly number[]): boolean => {
      const lo = [p.x - p.w / 2, p.y - p.h / 2, p.z - p.d / 2];
      const hi = [p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2];
      // A billboarded part is tested in ITS OWN frame — where, by construction,
      // the sight line is exactly local +y (that is what "faces the camera"
      // means), so the same slab test works with a rotated origin.
      const bb = p.billboard === true;
      const o = bb ? toBillboardFrame(from[0], from[1], from[2]) : [...from];
      const dir = bb ? [0, 1, 0] : [0, SIL_COS, SIL_SIN];
      // Slab test, starting just off the probe so the face it sits on does not
      // occlude itself.
      let t0 = 1e-6;
      let t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        if (dir[k] === 0) {
          if (o[k] < lo[k] || o[k] > hi[k]) return false;
          continue;
        }
        const a = (lo[k] - o[k]) / dir[k];
        const b = (hi[k] - o[k]) / dir[k];
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      }
      return t0 <= t1;
    };
    for (const p of EAGLE_MODELS.intact.parts) {
      expect(hits(p, EAGLE_PROBE), `${p.role} at y=${p.y} z=${p.z}`).toBe(
        false,
      );
    }
    // …and the test is not vacuously true: a point on the cornice under the
    // MAST is occluded by it, and one under the billboarded emblem by that.
    // Without this the whole check would pass on a ray-box test that always
    // returned false.
    expect(hits(EAGLE_MODELS.intact.parts[3], [0, 6.6, -2.0])).toBe(true);
    const emblem = EAGLE_MODELS.intact.parts.find((p) => p.billboard === true)!;
    const c = propPartCentre(emblem);
    // 6 u back along the sight line, i.e. squarely behind the plate.
    const behind = [c[0], c[1] - 6 * SIL_COS, c[2] - 6 * SIL_SIN];
    expect(hits(emblem, behind)).toBe(true);
    // …and `screenDepth` agrees with the ray: the probe is south of the mast.
    expect(screenDepth(py, pz)).toBeGreaterThan(screenDepth(10, 0));
  });
});

// ---------------------------------------------------------------------------
// Fidelity §8 / art §11 — the six power-ups
// ---------------------------------------------------------------------------

describe('POWERUP_MODELS — fidelity §8’s six types', () => {
  it('covers exactly the six types the core can roll', () => {
    expect(Object.keys(POWERUP_MODELS).sort()).toEqual(
      [...POWERUP_TYPES].sort(),
    );
  });

  it('is entirely on the shared gold material — one draw call, not six', () => {
    for (const type of POWERUP_TYPES) {
      expect(countPropRole(POWERUP_MODELS[type], 'stone'), type).toBe(0);
      expect(countPropRole(POWERUP_MODELS[type], 'gold'), type).toBeGreaterThan(
        2,
      );
    }
  });

  it('fits inside its own tile at every angle of its spin', () => {
    // A power-up turns at 0.5 rps, so what has to fit is the circle it sweeps,
    // not the box it occupies at yaw 0.
    for (const type of POWERUP_TYPES) {
      expect(
        2 * propSweepRadius(POWERUP_MODELS[type]),
        type,
      ).toBeLessThanOrEqual(TILE);
    }
  });

  it('separates every pair by shape alone (art §11, grayscale bar)', () => {
    // The six share ONE material, so **nothing but geometry** can tell them
    // apart, which makes art §11's grayscale bar a statement about silhouette
    // overlap — and art §2 fixes the camera, so each model's silhouette is a
    // constant that can be rastered without a renderer (see `silhouette`).
    //
    // **The metric is symmetric difference as a share of the SMALLER shape**,
    // not intersection-over-union, and the difference matters. Six icons that
    // all live inside one 16 u tile score 0.6–0.8 IoU against each other purely
    // because they all fill the tile: on that scale star-vs-tank — a cross
    // against a vehicle, unmistakable to an eye — reads 0.66, so IoU alone
    // cannot say what is and is not confusable. What it *did* catch is a real
    // collision: the first cut's helmet and clock were both wide round slabs at
    // 0.868, and both were redesigned (a smaller watch with a crown stem)
    // because of it.
    //
    // The bar is **≥ 30%**: the two shapes must disagree over at least a third
    // of the smaller one's area. The final measured minimum is 34.3%
    // (clock vs tank). The real verdict is still the committed grayscale
    // capture; this is the regression guard that stops a later edit collapsing
    // two of them without anybody re-running it.
    const masks = new Map<PowerupType, Uint8Array>();
    for (const t of POWERUP_TYPES) masks.set(t, silhouette(POWERUP_MODELS[t]));
    const area = (m: Uint8Array): number => m.reduce((s, v) => s + v, 0);
    const worst = { pair: '', pct: Infinity };
    for (let i = 0; i < POWERUP_TYPES.length; i++) {
      for (let j = i + 1; j < POWERUP_TYPES.length; j++) {
        const a = masks.get(POWERUP_TYPES[i])!;
        const b = masks.get(POWERUP_TYPES[j])!;
        let inter = 0;
        for (let k = 0; k < a.length; k++) {
          if (a[k] === 1 && b[k] === 1) inter++;
        }
        const areaA = area(a);
        const areaB = area(b);
        const pct =
          (100 * (areaA + areaB - 2 * inter)) / Math.min(areaA, areaB);
        const label = `${POWERUP_TYPES[i]} vs ${POWERUP_TYPES[j]}`;
        if (pct < worst.pct) {
          worst.pair = label;
          worst.pct = pct;
        }
        expect(pct, label).toBeGreaterThanOrEqual(30);
      }
    }
    // Logged so the number is in the run output next to the assertion that
    // rests on it — the standing rule since T2.4 is that a claim needs a
    // measurement behind it.
    console.log(
      `power-up silhouettes — closest pair ${worst.pair} differs over ` +
        `${worst.pct.toFixed(1)}% of the smaller shape`,
    );
  });
});

describe('art §9 — "bob ±2 u @ 1.2 s + 0.5 rps yaw"', () => {
  it('bobs exactly ±2 u about its hover height, over 1.2 s', () => {
    expect(POWERUP_BOB_U).toBe(2);
    expect(POWERUP_BOB_MS).toBe(1200);
    expect(powerupBobAt(0)).toBeCloseTo(POWERUP_HOVER_U, 9);
    expect(powerupBobAt(POWERUP_BOB_MS / 4)).toBeCloseTo(
      POWERUP_HOVER_U + POWERUP_BOB_U,
      9,
    );
    expect(powerupBobAt((3 * POWERUP_BOB_MS) / 4)).toBeCloseTo(
      POWERUP_HOVER_U - POWERUP_BOB_U,
      9,
    );
    expect(powerupBobAt(POWERUP_BOB_MS)).toBeCloseTo(POWERUP_HOVER_U, 9);
  });

  it('never lets the item touch the board or sink through it', () => {
    // A power-up that grazes the ground reads as resting, and one that dips
    // below it flickers against the board plane.
    for (let ms = 0; ms < POWERUP_BOB_MS * 2; ms += 7) {
      expect(powerupBobAt(ms)).toBeGreaterThan(0.25);
    }
  });

  it('turns half a revolution per second', () => {
    expect(POWERUP_RPS).toBe(0.5);
    expect(powerupYawAt(1000)).toBeCloseTo(Math.PI, 9);
    expect(powerupYawAt(2000)).toBeCloseTo(2 * Math.PI, 9);
  });
});

// ---------------------------------------------------------------------------
// Art §3.0 — `material.color` is the authored token, everywhere
// ---------------------------------------------------------------------------

describe('art §3.0 — the prop materials carry the authored tokens', () => {
  it('puts eagleStone and powerupGold on the two prop materials, unmodified', () => {
    const mats = createMaterials();
    expect(mats.propStone.color.getHexString()).toBe('8d94a3'); // eagleStone
    expect(mats.propGold.color.getHexString()).toBe('ffd76b'); // powerupGold
    // Art §4: the emblem is emissive. Art §1 pillar 2 rations it, so it is
    // dimmer than a bullet in flight and dimmer than the tier-3 pip.
    expect(mats.propGold.emissive.getHexString()).toBe('ffd76b');
    expect(mats.propGold.emissiveIntensity).toBeLessThan(
      mats.tierTip.emissiveIntensity,
    );
    expect(mats.propGold.emissiveIntensity).toBeGreaterThan(0);
    // Neither carries vertex colours: every part's trim rides on
    // `instanceColor`, and an unbound `color` attribute reads (0,0,0) in
    // WebGL2 — every prop would render black.
    expect(mats.propStone.vertexColors).toBe(false);
    expect(mats.propGold.vertexColors).toBe(false);
    mats.dispose();
  });

  it('keeps every prop tint a RATIO that lands on a real colour', () => {
    // The same guard the tanks have. A tint is a multiplier against its
    // material's own token, so the invariant is not "the ratio is small" but
    // "token × ratio is a colour a screen can show".
    const token: Record<string, number> = {
      stone: PALETTE.eagleStone,
      gold: PALETTE.powerupGold,
    };
    for (const [label, model] of ALL_MODELS) {
      for (const p of model.parts) {
        const base = new Color(token[p.role]);
        const rgb = [
          base.r * p.tint[0],
          base.g * p.tint[1],
          base.b * p.tint[2],
        ];
        for (const c of rgb) {
          expect(c, `${label}/${p.role}`).toBeGreaterThanOrEqual(0);
          expect(c, `${label}/${p.role}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

describe('createPropView — state to geometry', () => {
  it('draws the intact eagle and nothing else on a fresh stage', () => {
    const m = mount();
    const state = game();
    expect(state.eagleAlive).toBe(true);
    expect(state.powerup).toBeNull();
    m.view.update(state, 1, 16);

    expect(m.stone.count).toBe(countPropRole(EAGLE_MODELS.intact, 'stone'));
    expect(m.gold.count).toBe(countPropRole(EAGLE_MODELS.intact, 'gold'));
    // …at the tile the fidelity spec puts it on.
    const [cx, cz] = eagleCentre(EAGLE_TILE);
    for (const t of translations(m.stone)) {
      expect(Math.abs(t.x - cx)).toBeLessThanOrEqual(TILE / 2);
      expect(Math.abs(t.z - cz)).toBeLessThanOrEqual(TILE / 2);
    }
    m.dispose();
  });

  it('follows `state.eagleAlive` with NO event at all (load / replay path)', () => {
    // The event is an accelerator; the flag is the truth. A stage loaded from
    // storage, or a replay scrubbed to a tick after the base fell, never
    // replays `baseDestroyed` — and would otherwise show an intact eagle over a
    // game-over screen.
    const m = mount();
    const state = game();
    state.eagleAlive = false;
    m.view.update(state, 1, 16);
    expect(m.stone.count).toBe(countPropRole(EAGLE_MODELS.destroyed, 'stone'));
    expect(m.gold.count).toBe(0);
    m.dispose();
  });

  it('follows the `baseDestroyed` event when it arrives', () => {
    const m = mount();
    const state = game();
    m.view.update(state, 1, 16);
    expect(m.gold.count).toBeGreaterThan(0);
    m.view.onEvent({ t: 'baseDestroyed' });
    m.view.update(state, 1, 16);
    expect(m.stone.count).toBe(countPropRole(EAGLE_MODELS.destroyed, 'stone'));
    expect(m.gold.count).toBe(0);
    m.dispose();
  });

  it('brings the base back when a new stage does (the flag rules)', () => {
    const m = mount();
    const state = game();
    state.eagleAlive = false;
    m.view.update(state, 1, 16);
    expect(m.gold.count).toBe(0);
    state.eagleAlive = true; // the next stage's fresh state
    m.view.update(state, 1, 16);
    expect(m.gold.count).toBe(countPropRole(EAGLE_MODELS.intact, 'gold'));
    m.dispose();
  });

  it('resolves each power-up type to its own geometry', () => {
    const m = mount();
    const state = game();
    const eagleGold = countPropRole(EAGLE_MODELS.intact, 'gold');
    for (const type of POWERUP_TYPES) {
      state.powerup = { type, x: 32, y: 48 };
      m.view.update(state, 1, 16);
      expect(m.gold.count, type).toBe(
        eagleGold + countPropRole(POWERUP_MODELS[type], 'gold'),
      );
    }
    m.dispose();
  });

  it('draws nothing for the power-up when there is none', () => {
    const m = mount();
    const state = game();
    state.powerup = { type: 'star', x: 32, y: 48 };
    m.view.update(state, 1, 16);
    const withItem = m.gold.count;
    state.powerup = null;
    m.view.update(state, 1, 16);
    expect(m.gold.count).toBe(countPropRole(EAGLE_MODELS.intact, 'gold'));
    expect(m.gold.count).toBeLessThan(withItem);
    m.dispose();
  });

  it('centres the power-up on the tile the core placed it on', () => {
    const m = mount();
    const state = game();
    state.powerup = { type: 'tank', x: 64, y: 96 };
    m.view.update(state, 1, 16);
    const item = translations(m.gold).slice(
      countPropRole(EAGLE_MODELS.intact, 'gold'),
    );
    for (const t of item) {
      expect(Math.abs(t.x - (64 + TILE / 2))).toBeLessThanOrEqual(TILE / 2);
      expect(Math.abs(t.z - (96 + TILE / 2))).toBeLessThanOrEqual(TILE / 2);
      // …and it hovers: nothing is ever at or below the board.
      expect(t.y).toBeGreaterThan(0);
    }
    m.dispose();
  });

  it('restarts the bob when a new item replaces the old one', () => {
    // Fidelity §8: a second drop replaces the first. Without the re-arm the new
    // item inherits the old one's phase and appears mid-bob, mid-spin — at
    // exactly the moment the player is meant to notice something appeared.
    const m = mount();
    const state = game();
    state.powerup = { type: 'star', x: 32, y: 48 };
    m.view.update(state, 1, 300);
    const mid = translations(m.gold).at(-1)!.y;
    state.powerup = { type: 'star', x: 96, y: 48 };
    m.view.onEvent({ t: 'powerupSpawned', type: 'star', x: 96, y: 48 });
    m.view.update(state, 1, 0);
    const fresh = translations(m.gold).at(-1)!.y;
    expect(mid).not.toBeCloseTo(fresh, 6);
    m.dispose();
  });

  it('adds nothing to the scene graph after the first frame', () => {
    const m = mount();
    const state = game();
    state.powerup = { type: 'clock', x: 32, y: 48 };
    m.view.update(state, 1, 16);
    const count = (): number => {
      let n = 0;
      m.scene.traverse(() => {
        n++;
      });
      return n;
    };
    const before = count();
    for (let i = 0; i < 60; i++) {
      m.view.update(state, 1, 16);
    }
    expect(count()).toBe(before);
    m.dispose();
  });
});

// ---------------------------------------------------------------------------
// The pause fix (T3.3)
// ---------------------------------------------------------------------------

describe('a paused frame is a still frame', () => {
  it('zeroes presentation dt while the simulation is frozen', () => {
    const state = game();
    expect(animDtOf(state, 16.7)).toBe(16.7);
    state.paused = true;
    expect(animDtOf(state, 16.7)).toBe(0);
  });

  it('does not advance the power-up’s bob or spin while paused', () => {
    const m = mount();
    const state = game();
    state.powerup = { type: 'helmet', x: 32, y: 48 };
    state.paused = true;
    m.view.update(state, 1, 16);
    const before = matrixSnapshot(m.gold);
    for (let i = 0; i < 40; i++) {
      m.view.update(state, 1, 16);
    }
    // Bit-identical, not approximately equal: the loop keeps handing the
    // renderer a real `dtMs` on a paused frame (T2.1's contract), so a picture
    // that moves at all is a picture that moves for the whole pause.
    expect(matrixSnapshot(m.gold)).toEqual(before);

    state.paused = false;
    m.view.update(state, 1, 16);
    expect(matrixSnapshot(m.gold)).not.toEqual(before);
    m.dispose();
  });
});
