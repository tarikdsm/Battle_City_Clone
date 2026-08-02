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

import { FIELD_SUBCELLS, BASE_RING_TILES } from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import { subcellIndex } from '../../src/core/grid';
import { Terrain, type LevelData } from '../../src/core/types';
import {
  BRICK_JITTER,
  applyShovelPhase,
  countSubcellKinds,
  countTileKind,
  createSlotMap,
  maskSubcells,
  subcellInstanceIndex,
  subcellJitter,
  terrainFromState,
} from '../../src/render/terrainView';

import mixed from '../fixtures/level-mixed.json' with { type: 'json' };

const LEVEL = mixed as LevelData;

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
    const moved = map.remove(200);
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
    expect(map.remove(200)).toEqual({ slot: 1, fromSlot: 1, key: 200 });
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
    let n = maskSubcells(0, 0, 3, scratch);
    for (let i = 0; i < n; i++) {
      map.remove(scratch[i]);
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
      map.remove(scratch[i]);
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
    expect(map.remove(9)).toBeNull();
    expect(map.count).toBe(1);
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
