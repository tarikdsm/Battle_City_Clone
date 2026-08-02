// tests/render/terrainView.test.ts — the placement/index mathematics of the
// terrain renderer, in the Vitest **node** environment. There is no DOM and no
// WebGL here, so nothing in this file may build a renderer, a canvas or an
// `InstancedMesh`; everything it asserts is a pure function or a plain
// bookkeeping object exported by `terrainView.ts` for exactly that reason.
//
// What is deliberately NOT here: rendered pixels. Geometry, materials and draw
// order are verified by the screenshot checklist and by
// `npm run calibrate:lighting`, per the task brief.

import { describe, expect, it } from 'vitest';

import { InstancedMesh, Matrix4, Mesh } from 'three';

import {
  BASE_RING_TILES,
  FIELD_SUBCELLS,
  FIELD_TILES,
  SHOVEL_BLINK_S,
  SUBCELL,
} from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import { subcellIndex } from '../../src/core/grid';
import { Terrain, type GameState, type LevelData } from '../../src/core/types';
import { createMaterials } from '../../src/render/materials';
import { createSceneRoot } from '../../src/render/sceneRoot';
import {
  BRICK_JITTER,
  applyShovelPhase,
  blinkBaseRingKinds,
  brickTint,
  countSubcellKinds,
  countTileKind,
  createSlotMap,
  maskSubcells,
  subcellInstanceIndex,
  createTerrainView,
  stampBaseRingKinds,
  subcellJitter,
  terrainFromState,
  type SlotMove,
  type TerrainView,
} from '../../src/render/terrainView';

import mixed from '../fixtures/level-mixed.json' with { type: 'json' };
import open from '../fixtures/level-open.json' with { type: 'json' };

const LEVEL = mixed as LevelData;
/** No water at all — the level that proves a rebuild also re-cuts the board. */
const OPEN = open as LevelData;

function mixedTerrain(): Uint8Array {
  const state = createGame(LEVEL, { players: 1, seed: 1, stageNumber: 1 });
  return terrainFromState(state);
}

describe('subcellInstanceIndex', () => {
  it('is the core’s own sy*26+sx layout', () => {
    // The render layer indexes `state.terrain` directly, so agreeing with
    // `src/core/grid.ts` is not a nicety — a different convention would draw
    // the whole board transposed.
    for (const [sx, sy] of [
      [0, 0],
      [25, 0],
      [0, 25],
      [25, 25],
      [7, 13],
    ] as const) {
      expect(subcellInstanceIndex(sx, sy)).toBe(subcellIndex(sx, sy));
    }
    expect(subcellInstanceIndex(25, 25)).toBe(675);
  });
});

describe('maskSubcells — a removedMask clears exactly its subcells', () => {
  const out: number[] = [];
  const cells = (tx: number, ty: number, mask: number): number[] => {
    const n = maskSubcells(tx, ty, mask, out);
    return out.slice(0, n).sort((a, b) => a - b);
  };
  /** The four subcells of tile (tx, ty), in TL, TR, BL, BR order. */
  const quad = (tx: number, ty: number): readonly number[] => [
    subcellIndex(tx * 2, ty * 2),
    subcellIndex(tx * 2 + 1, ty * 2),
    subcellIndex(tx * 2, ty * 2 + 1),
    subcellIndex(tx * 2 + 1, ty * 2 + 1),
  ];

  it('bit order is 1=TL, 2=TR, 4=BL, 8=BR (core’s buildTerrain/damageTile)', () => {
    const [tl, tr, bl, br] = quad(4, 7);
    expect(cells(4, 7, 1)).toEqual([tl]);
    expect(cells(4, 7, 2)).toEqual([tr]);
    expect(cells(4, 7, 4)).toEqual([bl]);
    expect(cells(4, 7, 8)).toEqual([br]);
  });

  it('handles all four directional pairs a bullet can produce', () => {
    const [tl, tr, bl, br] = quad(6, 6);
    // NEAR_PAIR/FAR_PAIR in src/core/systems/bullets.ts: a shot travelling Up
    // takes the bottom row (12), Down the top row (3), Right the left column
    // (5), Left the right column (10).
    expect(cells(6, 6, 5)).toEqual([tl, bl].sort((a, b) => a - b)); // left column
    expect(cells(6, 6, 10)).toEqual([tr, br].sort((a, b) => a - b)); // right column
    expect(cells(6, 6, 3)).toEqual([tl, tr].sort((a, b) => a - b)); // top row
    expect(cells(6, 6, 12)).toEqual([bl, br].sort((a, b) => a - b)); // bottom row
  });

  it('clears the whole tile on the tier-3 full mask, and nothing on 0', () => {
    expect(cells(0, 0, 15)).toEqual([...quad(0, 0)].sort((a, b) => a - b));
    expect(cells(0, 0, 0)).toEqual([]);
  });

  it('maps the last tile without running off the 26×26 grid', () => {
    const all = cells(12, 12, 15);
    expect(all).toEqual([...quad(12, 12)].sort((a, b) => a - b));
    for (const i of all) {
      expect(i).toBeLessThan(FIELD_SUBCELLS * FIELD_SUBCELLS);
    }
  });

  it('reuses the caller’s array — the damage path allocates nothing', () => {
    const scratch: number[] = [];
    maskSubcells(3, 3, 15, scratch);
    const before = scratch.length;
    maskSubcells(9, 9, 15, scratch);
    expect(scratch.length).toBe(before);
  });
});

/** A fresh out-param for `SlotMap.remove`. */
function newMove(): SlotMove {
  return { slot: -1, fromSlot: -1, key: -1 };
}

describe('createSlotMap — removing a middle instance swaps the last one in', () => {
  it('hands out slots in insertion order', () => {
    const map = createSlotMap(676);
    expect(map.add(100)).toBe(0);
    expect(map.add(200)).toBe(1);
    expect(map.add(300)).toBe(2);
    expect(map.count).toBe(3);
    expect(map.slotOf(200)).toBe(1);
    expect(map.keyAt(2)).toBe(300);
  });

  it('swaps the LAST active instance into the hole and decrements count', () => {
    const map = createSlotMap(676);
    map.add(100);
    map.add(200);
    map.add(300);

    // Removing the middle one is the case that matters: an InstancedMesh has no
    // holes, so slot 1 has to be back-filled from slot 2 and `count` dropped.
    const moved = newMove();
    expect(map.remove(200, moved)).toBe(true);
    expect(moved).toEqual({ slot: 1, fromSlot: 2, key: 300 });
    expect(map.count).toBe(2);
    expect(map.slotOf(300)).toBe(1); // followed its matrix into the hole
    expect(map.slotOf(200)).toBe(-1);
    expect(map.keyAt(1)).toBe(300);
  });

  it('reports no move when the removed instance IS the last one', () => {
    const map = createSlotMap(676);
    map.add(100);
    map.add(200);
    // Nothing to back-fill: the caller must not copy a matrix onto itself.
    const moved = newMove();
    expect(map.remove(200, moved)).toBe(true);
    expect(moved).toEqual({ slot: 1, fromSlot: 1, key: 200 });
    expect(map.count).toBe(1);
  });

  it('finds the right instance after the SAME tile is damaged twice', () => {
    // The self-review question, as a test. Damage tile A (removing two of its
    // subcells), then damage it again: the second removal has to land on the
    // slots the first one left behind, not on the slots the initial build used.
    const map = createSlotMap(676);
    const keys: number[] = [];
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const k = subcellIndex(sx, sy);
        keys.push(k);
        map.add(k);
      }
    }
    const scratch: number[] = [];

    // First hit: the top row of tile (0,0) — subcells (0,0) and (1,0).
    const moved = newMove();
    let n = maskSubcells(0, 0, 3, scratch);
    for (let i = 0; i < n; i++) {
      map.remove(scratch[i], moved);
    }
    expect(map.count).toBe(14);

    // Second hit on the same tile: the bottom row — (0,1) and (1,1). Both were
    // back-filled into by the first removal, so a stale slot map would either
    // return -1 here or clear two innocent subcells somewhere else.
    n = maskSubcells(0, 0, 12, scratch);
    for (let i = 0; i < n; i++) {
      const slot = map.slotOf(scratch[i]);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(map.count);
      expect(map.keyAt(slot)).toBe(scratch[i]);
      map.remove(scratch[i], moved);
    }
    expect(map.count).toBe(12);

    // Every survivor is still addressable, exactly once, within [0, count).
    const seen = new Set<number>();
    for (const k of keys) {
      const slot = map.slotOf(k);
      if (slot === -1) continue;
      expect(slot).toBeLessThan(map.count);
      expect(seen.has(slot)).toBe(false);
      seen.add(slot);
      expect(map.keyAt(slot)).toBe(k);
    }
    expect(seen.size).toBe(12);
  });

  it('ignores a removal of something that is not there', () => {
    const map = createSlotMap(676);
    map.add(7);
    const moved = newMove();
    expect(map.remove(9, moved)).toBe(false);
    expect(map.count).toBe(1);
  });

  it('reports through an out-param, so the damage path allocates nothing', () => {
    // The 4 Hz shovel blink calls `remove` 20 times a stamp; returning a fresh
    // object would make it the only allocating path under `render`.
    const map = createSlotMap(676);
    map.add(1);
    map.add(2);
    const moved = newMove();
    map.remove(1, moved);
    const first = { ...moved };
    map.add(1);
    map.remove(2, moved);
    expect(moved).not.toEqual(first); // same object, rewritten in place
  });

  it('re-adding after a removal is a no-op if already present', () => {
    const map = createSlotMap(676);
    expect(map.add(7)).toBe(0);
    expect(map.add(7)).toBe(0); // idempotent — the shovel stamps unconditionally
    expect(map.count).toBe(1);
  });

  it('clear() empties it without losing capacity', () => {
    const map = createSlotMap(676);
    map.add(1);
    map.add(2);
    map.clear();
    expect(map.count).toBe(0);
    expect(map.slotOf(1)).toBe(-1);
    expect(map.add(3)).toBe(0);
  });
});

describe('subcellJitter — deterministic from the coordinate, never random', () => {
  it('returns the same value for the same coordinate, every call', () => {
    for (let i = 0; i < 5; i++) {
      expect(subcellJitter(11, 4)).toBe(subcellJitter(11, 4));
    }
    // …and across a different instance of the same board.
    const a = Array.from({ length: 26 }, (_, sx) => subcellJitter(sx, 9));
    const b = Array.from({ length: 26 }, (_, sx) => subcellJitter(sx, 9));
    expect(a).toEqual(b);
  });

  it('differs between neighbouring coordinates — it is texture, not a constant', () => {
    expect(subcellJitter(3, 3)).not.toBe(subcellJitter(4, 3));
    expect(subcellJitter(3, 3)).not.toBe(subcellJitter(3, 4));
    // Not symmetric either: (a,b) and (b,a) must not collide, or every board
    // would be mirrored about its diagonal.
    expect(subcellJitter(2, 17)).not.toBe(subcellJitter(17, 2));
  });

  it('stays inside ±1 and spreads across the range', () => {
    const values: number[] = [];
    for (let sy = 0; sy < FIELD_SUBCELLS; sy++) {
      for (let sx = 0; sx < FIELD_SUBCELLS; sx++) {
        const v = subcellJitter(sx, sy);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        values.push(v);
      }
    }
    // Distinct enough to read as texture: at least 95% unique over the board.
    expect(new Set(values).size).toBeGreaterThan(values.length * 0.95);
    // Roughly centred, so the tile does not drift lighter or darker overall.
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });

  it('is scaled by art §5’s ±3%', () => {
    expect(BRICK_JITTER).toBe(0.03);
  });
});

describe('applyShovelPhase — steel → blink → revert over the base ring', () => {
  /** Flat subcell indices of the five BASE_RING_TILES. */
  const ringCells: number[] = [];
  for (const [tx, ty] of BASE_RING_TILES) {
    ringCells.push(
      subcellIndex(tx * 2, ty * 2),
      subcellIndex(tx * 2 + 1, ty * 2),
      subcellIndex(tx * 2, ty * 2 + 1),
      subcellIndex(tx * 2 + 1, ty * 2 + 1),
    );
  }

  it('covers exactly 20 subcells', () => {
    expect(ringCells).toHaveLength(20);
    expect(new Set(ringCells).size).toBe(20);
  });

  it('steel stamps the whole ring, restoring subcells shot away earlier', () => {
    const kinds = mixedTerrain();
    // Simulate two of the ring's subcells having been destroyed by a bullet.
    kinds[ringCells[0]] = Terrain.Empty;
    kinds[ringCells[7]] = Terrain.Empty;

    applyShovelPhase(kinds, 'steel');
    for (const c of ringCells) {
      expect(kinds[c]).toBe(Terrain.Steel);
    }
  });

  it('blink keeps the ring solid — it alternates appearance, not kind', () => {
    const kinds = mixedTerrain();
    applyShovelPhase(kinds, 'steel');
    applyShovelPhase(kinds, 'blink');
    for (const c of ringCells) {
      expect(kinds[c]).toBe(Terrain.Steel);
    }
  });

  it('revert returns a FULLY repaired brick ring (core stamps, never restores)', () => {
    const kinds = mixedTerrain();
    kinds[ringCells[3]] = Terrain.Empty; // destroyed before the shovel ran
    applyShovelPhase(kinds, 'steel');
    applyShovelPhase(kinds, 'revert');
    for (const c of ringCells) {
      expect(kinds[c]).toBe(Terrain.Brick);
    }
  });

  it('touches nothing outside the ring', () => {
    const before = mixedTerrain();
    const after = mixedTerrain();
    applyShovelPhase(after, 'steel');
    const ring = new Set(ringCells);
    for (let i = 0; i < before.length; i++) {
      if (ring.has(i)) continue;
      expect(after[i], `subcell ${i}`).toBe(before[i]);
    }
  });
});

describe('initial build from tests/fixtures/level-mixed.json', () => {
  // Counted by hand from the fixture's 13 rows, then adjusted for its five
  // `partials` (each halves a B/S tile) and for the auto-stamped brick base ring
  // (5 tiles; three of them were empty in the rows, so +12 brick subcells).
  // Hard-coded rather than re-derived from the JSON, so the test fails if the
  // fixture, the core's buildTerrain or this renderer's reading of it drifts.
  it('produces the expected per-kind instance counts', () => {
    const counts = countSubcellKinds(mixedTerrain());
    expect(counts[Terrain.Brick]).toBe(74); // per-subcell instances
    expect(counts[Terrain.Steel]).toBe(28); // per-subcell instances
    expect(counts[Terrain.Water]).toBe(52);
    expect(counts[Terrain.Trees]).toBe(24);
    expect(counts[Terrain.Ice]).toBe(32);
    // 676 total, so Empty is whatever is left.
    expect(counts[Terrain.Empty]).toBe(676 - (74 + 28 + 52 + 24 + 32));
  });

  it('produces the expected per-TILE instance counts for water, trees and ice', () => {
    // Water, trees and ice are indestructible, so they instance per tile rather
    // than per subcell — 4× fewer instances and 4× fewer triangles.
    const terrain = mixedTerrain();
    expect(countTileKind(terrain, Terrain.Water)).toBe(13);
    expect(countTileKind(terrain, Terrain.Trees)).toBe(6);
    expect(countTileKind(terrain, Terrain.Ice)).toBe(8);
  });

  it('fits every kind inside its InstancedMesh capacity', () => {
    const counts = countSubcellKinds(mixedTerrain());
    expect(counts[Terrain.Brick]).toBeLessThanOrEqual(676);
    expect(counts[Terrain.Steel]).toBeLessThanOrEqual(676);
    expect(countTileKind(mixedTerrain(), Terrain.Water)).toBeLessThanOrEqual(
      169,
    );
  });

  it('reads a copy of state.terrain — the render layer never aliases core state', () => {
    const state = createGame(LEVEL, { players: 1, seed: 1, stageNumber: 1 });
    const mirror = terrainFromState(state);
    expect(mirror).not.toBe(state.terrain);
    expect(Array.from(mirror)).toEqual(Array.from(state.terrain));
    mirror[0] = Terrain.Steel;
    expect(state.terrain[0]).not.toBe(Terrain.Steel);
  });
});

// ---------------------------------------------------------------------------
// The VIEW itself. Building `InstancedMesh`es, a `Scene` and lights touches no
// GL context — only `WebGLRenderer` does — so the shipped view is reachable
// from the node environment, and these are the cases that were previously
// covered only against parallel helpers the view never called (T2.3 review,
// Important 1 and 2).
// ---------------------------------------------------------------------------

interface Mounted {
  view: TerrainView;
  meshes: Record<'brick' | 'steel' | 'water' | 'trees' | 'ice', InstancedMesh>;
  /** Vertices in the board's ground plane — pits change it. */
  groundVerts(): number;
  dispose(): void;
}

function mount(): Mounted {
  const mats = createMaterials();
  const root = createSceneRoot(mats);
  const view = createTerrainView(mats, root);
  const found: Partial<Mounted['meshes']> = {};
  let ground: Mesh | undefined;
  root.scene.traverse((o) => {
    if (o instanceof InstancedMesh) {
      if (o.material === mats.terrainBrick) found.brick = o;
      else if (o.material === mats.terrainSteel) found.steel = o;
      else if (o.material === mats.terrainWater) found.water = o;
      else if (o.material === mats.terrainTrees) found.trees = o;
      else if (o.material === mats.terrainIce) found.ice = o;
    } else if (o instanceof Mesh && o.material === mats.board) {
      ground = o;
    }
  });
  const meshes = found as Mounted['meshes'];
  for (const k of KINDS) {
    if (!meshes[k]) throw new Error(`terrain mesh ${k} not found in the scene`);
  }
  return {
    view,
    meshes,
    groundVerts(): number {
      if (!ground) throw new Error('ground mesh not found in the scene');
      return ground.geometry.getAttribute('position').count;
    },
    dispose(): void {
      view.dispose();
      root.dispose();
      mats.dispose();
    },
  };
}

const KINDS = ['brick', 'steel', 'water', 'trees', 'ice'] as const;

function game(level: LevelData): GameState {
  return createGame(level, { players: 1, seed: 1, stageNumber: 1 });
}

/** Subcell indices the mesh is actually drawing, decoded from its matrices. */
function occupied(mesh: InstancedMesh): number[] {
  const m = new Matrix4();
  const out: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    const sx = (m.elements[12] - SUBCELL / 2) / SUBCELL;
    const sy = (m.elements[14] - SUBCELL / 2) / SUBCELL;
    out.push(subcellIndex(sx, sy));
  }
  return out.sort((a, b) => a - b);
}

/** Subcell indices holding `kind`, straight from a terrain array. */
function cellsOfKind(kinds: Uint8Array, kind: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === kind) out.push(i);
  }
  return out;
}

/** Flat subcell indices of the five BASE_RING_TILES, tile by tile. */
const RING: number[] = [];
for (const [tx, ty] of BASE_RING_TILES) {
  for (let i = 0; i < 4; i++) {
    RING.push(subcellIndex(tx * 2 + (i & 1), ty * 2 + (i >> 1)));
  }
}

describe('TerrainView.build — the shipped path, not a parallel helper', () => {
  it('draws exactly the fixture’s instances', () => {
    const m = mount();
    m.view.build(game(LEVEL));
    // The brief's per-kind counts, now asserted against the meshes the player
    // sees rather than against `countSubcellKinds` in isolation.
    expect(m.meshes.brick.count).toBe(74);
    expect(m.meshes.steel.count).toBe(28);
    expect(m.meshes.water.count).toBe(13);
    expect(m.meshes.trees.count).toBe(6);
    expect(m.meshes.ice.count).toBe(8);
    // …and the instances are in the right places, not merely the right number.
    const kinds = mixedTerrain();
    expect(occupied(m.meshes.brick)).toEqual(cellsOfKind(kinds, Terrain.Brick));
    expect(occupied(m.meshes.steel)).toEqual(cellsOfKind(kinds, Terrain.Steel));
    m.dispose();
  });

  it('is free when handed the same state again', () => {
    const m = mount();
    const state = game(LEVEL);
    m.view.build(state);
    m.view.build(state);
    m.view.build(state);
    expect(m.meshes.brick.count).toBe(74);
    expect(occupied(m.meshes.brick)).toHaveLength(74); // no duplicates
    m.dispose();
  });

  it('REBUILDS for a new level — instances and the board’s pits', () => {
    // The regression this exists for: the first version guarded on a
    // view-lifetime flag, so stage 2 rendered stage 1's terrain *and* kept
    // stage 1's pits — literal holes cut in the board where the new stage has
    // no water. Nothing threw; it drew the wrong level.
    const reused = mount();
    reused.view.build(game(LEVEL)); // mixed: 13 water tiles → 13 pits
    reused.view.build(game(OPEN)); // open: no water at all

    const fresh = mount();
    fresh.view.build(game(OPEN));

    for (const k of KINDS) {
      expect(reused.meshes[k].count, k).toBe(fresh.meshes[k].count);
    }
    expect(occupied(reused.meshes.brick)).toEqual(occupied(fresh.meshes.brick));
    expect(occupied(reused.meshes.steel)).toEqual(occupied(fresh.meshes.steel));
    // The pits. `level-open` has no water, so the ground is 169 whole tile
    // quads and nothing else; carrying mixed's pits over would leave it short.
    expect(reused.groundVerts()).toBe(fresh.groundVerts());
    expect(fresh.groundVerts()).toBe(FIELD_TILES * FIELD_TILES * 6);
    reused.dispose();
    fresh.dispose();
  });

  it('carries no damage across a rebuild', () => {
    const m = mount();
    m.view.build(game(LEVEL));
    m.view.onEvent({
      t: 'brickHit',
      tx: 2,
      ty: 3,
      removedMask: 15,
      x: 0,
      y: 0,
      dir: 2,
    });
    m.view.build(game(OPEN));
    const fresh = mount();
    fresh.view.build(game(OPEN));
    expect(m.meshes.brick.count).toBe(fresh.meshes.brick.count);
    expect(occupied(m.meshes.brick)).toEqual(occupied(fresh.meshes.brick));
    m.dispose();
    fresh.dispose();
  });

  it('reset() drops everything and re-arms the next build', () => {
    const m = mount();
    const state = game(LEVEL);
    m.view.build(state);
    m.view.reset();
    for (const k of KINDS) {
      expect(m.meshes[k].count, k).toBe(0);
    }
    // The same state must now rebuild rather than be skipped as "already
    // built" — that is the difference between a reset and a stall.
    m.view.build(state);
    expect(m.meshes.brick.count).toBe(74);
    m.dispose();
  });
});

describe('TerrainView — the shovel, through the slot maps', () => {
  it('steel → blink → revert keeps both slot maps exact', () => {
    // The composition neither the pure tests nor the screenshots reached:
    // `steel` interleaves 20 removals from the brick map with 20 adds to the
    // steel map, `revert` does the reverse, and the swap-with-last runs
    // throughout. Positions are checked, not just counts.
    const m = mount();
    m.view.build(game(LEVEL));
    const brick0 = m.meshes.brick.count;

    // Shoot two ring subcells away first, so `steel` has something to restore.
    m.view.onEvent({
      t: 'brickHit',
      tx: 6,
      ty: 11,
      removedMask: 3,
      x: 0,
      y: 0,
      dir: 2,
    });
    expect(m.meshes.brick.count).toBe(brick0 - 2);

    m.view.onEvent({ t: 'shovelPhase', phase: 'steel' });
    // All 20 ring subcells are steel, including the two that were destroyed.
    expect(m.meshes.steel.count).toBe(28 + 20);
    const steelCells = occupied(m.meshes.steel);
    for (const c of RING) {
      expect(steelCells, `ring cell ${c}`).toContain(c);
    }
    // …and none of them is still in the brick mesh.
    const brickCells = occupied(m.meshes.brick);
    for (const c of RING) {
      expect(brickCells).not.toContain(c);
    }
    expect(new Set(brickCells).size).toBe(brickCells.length); // no duplicates
    expect(new Set(steelCells).size).toBe(steelCells.length);

    m.view.onEvent({ t: 'shovelPhase', phase: 'blink' });
    m.view.update(130); // one half-period: the ring shows brick
    expect(m.meshes.steel.count).toBe(28);
    // Back to brick0: the ring is 20 bricks again, so the pair shot away before
    // the power-up has been repaired by the stamp — the whole point of `steel`
    // stamping rather than repairing.
    expect(m.meshes.brick.count).toBe(brick0);
    m.view.update(130); // …and back to steel
    expect(m.meshes.steel.count).toBe(28 + 20);

    m.view.onEvent({ t: 'shovelPhase', phase: 'revert' });
    expect(m.meshes.steel.count).toBe(28);
    expect(m.meshes.brick.count).toBe(brick0);
    const finalBrick = occupied(m.meshes.brick);
    for (const c of RING) {
      expect(finalBrick, `ring cell ${c}`).toContain(c);
    }
    expect(new Set(finalBrick).size).toBe(finalBrick.length);
    m.dispose();
  });

  it('does not resurrect a ring subcell destroyed DURING the blink', () => {
    const m = mount();
    m.view.build(game(LEVEL));
    m.view.onEvent({ t: 'shovelPhase', phase: 'steel' });
    m.view.onEvent({ t: 'shovelPhase', phase: 'blink' });
    // A tier-3 shot takes a whole ring tile out of the steel wall.
    m.view.onEvent({
      t: 'steelHit',
      tx: 6,
      ty: 11,
      removedMask: 15,
      destroyed: true,
      x: 0,
      y: 0,
      dir: 2,
    });
    expect(m.meshes.steel.count).toBe(28 + 16);
    // Several alternations later the hole is still a hole.
    for (let i = 0; i < 6; i++) {
      m.view.update(130);
    }
    const drawn = occupied(m.meshes.brick).concat(occupied(m.meshes.steel));
    for (let i = 0; i < 4; i++) {
      const c = subcellIndex(6 * 2 + (i & 1), 11 * 2 + (i >> 1));
      expect(drawn, `destroyed cell ${c}`).not.toContain(c);
    }
    m.dispose();
  });

  it('stops blinking on its own if `revert` never arrives', () => {
    // Stage end, base destroyed and game over all leave the phase machine
    // hanging. Without a deadline the view stamps 20 subcells at 8 Hz forever,
    // and with no rebuild path that used to survive into the next stage.
    const m = mount();
    m.view.build(game(LEVEL));
    const brick0 = m.meshes.brick.count;
    m.view.onEvent({ t: 'shovelPhase', phase: 'steel' });
    m.view.update(SHOVEL_BLINK_S * 1000 + 1000); // not blinking yet: a no-op
    expect(m.meshes.steel.count).toBe(28 + 20);

    m.view.onEvent({ t: 'shovelPhase', phase: 'blink' });
    m.view.update(SHOVEL_BLINK_S * 1000);
    // Settled on steel — what `state.terrain` still says the wall is.
    expect(m.meshes.steel.count).toBe(28 + 20);
    expect(m.meshes.brick.count).toBe(brick0 - 20);
    // Further frames change nothing at all.
    for (let i = 0; i < 20; i++) {
      m.view.update(130);
    }
    expect(m.meshes.steel.count).toBe(28 + 20);
    m.dispose();
  });
});

describe('blinkBaseRingKinds — appearance only', () => {
  it('alternates survivors and leaves destroyed subcells destroyed', () => {
    const kinds = mixedTerrain();
    stampBaseRingKinds(kinds, Terrain.Steel);
    const hole = RING[0];
    kinds[hole] = Terrain.Empty;

    blinkBaseRingKinds(kinds, Terrain.Brick);
    expect(kinds[hole]).toBe(Terrain.Empty);
    for (const c of RING) {
      if (c !== hole) expect(kinds[c]).toBe(Terrain.Brick);
    }
    // The distinction from applyShovelPhase, stated as a test: a plain stamp
    // WOULD rebuild the hole.
    applyShovelPhase(kinds, 'steel');
    expect(kinds[hole]).toBe(Terrain.Steel);
  });
});

describe('brickTint — art §5’s ±3% is a bound on the OUTPUT', () => {
  const out: [number, number, number] = [0, 0, 0];

  it('never exceeds ±3% on any channel, anywhere on the board', () => {
    // The compounding trap: a ±3% value term times a ±1.5% warm term reaches
    // ±4.5% on red and blue. Asserting the constant cannot see that; asserting
    // the output can.
    let min = Infinity;
    let max = -Infinity;
    for (let sy = 0; sy < FIELD_SUBCELLS; sy++) {
      for (let sx = 0; sx < FIELD_SUBCELLS; sx++) {
        brickTint(sx, sy, out);
        for (const c of out) {
          expect(c).toBeGreaterThanOrEqual(1 - BRICK_JITTER - 1e-12);
          expect(c).toBeLessThanOrEqual(1 + BRICK_JITTER + 1e-12);
          min = Math.min(min, c);
          max = Math.max(max, c);
        }
      }
    }
    // …and it actually uses the budget, rather than passing by being flat.
    expect(max - min).toBeGreaterThan(BRICK_JITTER);
  });

  it('is deterministic and varies between neighbours', () => {
    brickTint(4, 9, out);
    const first: [number, number, number] = [out[0], out[1], out[2]];
    brickTint(4, 9, out);
    expect(out).toEqual(first);
    brickTint(5, 9, out);
    expect(out).not.toEqual(first);
  });

  it('tints red and blue in opposite directions — texture, not a ramp', () => {
    // A pure value jitter moves all three channels together and reads as a
    // brightness ramp; the warm/cool split is what makes it read as brick.
    let opposed = 0;
    for (let sy = 0; sy < FIELD_SUBCELLS; sy++) {
      for (let sx = 0; sx < FIELD_SUBCELLS; sx++) {
        brickTint(sx, sy, out);
        if (out[0] > out[1] !== out[2] > out[1]) opposed++;
      }
    }
    expect(opposed).toBeGreaterThan(FIELD_SUBCELLS * FIELD_SUBCELLS * 0.8);
  });
});
