import { describe, expect, it } from 'vitest';
import {
  aabbOverlap,
  forEachSubcellUnder,
  snap8,
  subcellIndex,
  tileAt,
  tilesInAabb,
} from '../../src/core/grid';

describe('grid.snap8', () => {
  it('rounds to the nearest multiple of 8', () => {
    expect(snap8(37.3)).toBe(40);
    // The brief lists snap8(36)===36, but 36 = 4.5*8 sits exactly halfway between
    // 32 and 40 and can never itself be a multiple of 8 (the brief value is a typo).
    // Standard nearest-rounding (Math.round, half-up) resolves the tie to 40.
    expect(snap8(36)).toBe(40);
  });

  it('rounds down when nearer the lower multiple', () => {
    expect(snap8(35)).toBe(32);
    expect(snap8(3)).toBe(0);
  });

  it('leaves exact multiples of 8 unchanged', () => {
    expect(snap8(0)).toBe(0);
    expect(snap8(8)).toBe(8);
    expect(snap8(200)).toBe(200);
  });

  it('clamps negatives to 0', () => {
    expect(snap8(-3)).toBe(0);
    expect(snap8(-100)).toBe(0);
  });
});

describe('grid.aabbOverlap', () => {
  it('detects strict overlap', () => {
    expect(
      aabbOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    ).toBe(true);
  });

  it('treats touching edges as NOT overlapping', () => {
    expect(
      aabbOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
    ).toBe(false);
    expect(
      aabbOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 }),
    ).toBe(false);
  });

  it('returns false when fully separated', () => {
    expect(
      aabbOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }),
    ).toBe(false);
  });

  it('detects full containment', () => {
    expect(
      aabbOverlap({ x: 0, y: 0, w: 16, h: 16 }, { x: 4, y: 4, w: 4, h: 4 }),
    ).toBe(true);
  });
});

describe('grid.tileAt / subcellIndex', () => {
  it('maps subcell coords to tile index ty*13+tx', () => {
    expect(tileAt(0, 0)).toBe(0);
    expect(tileAt(1, 1)).toBe(0); // subcells (0,0) and (1,1) share tile (0,0)
    expect(tileAt(2, 0)).toBe(1); // tx=1
    expect(tileAt(0, 2)).toBe(13); // ty=1 -> row stride 13
    expect(tileAt(25, 25)).toBe(168); // tile (12,12) = 12*13+12
  });

  it('maps subcell coords to flat index sy*26+sx', () => {
    expect(subcellIndex(0, 0)).toBe(0);
    expect(subcellIndex(3, 0)).toBe(3);
    expect(subcellIndex(0, 1)).toBe(26);
    expect(subcellIndex(25, 25)).toBe(675); // 25*26+25
  });
});

describe('grid.tilesInAabb', () => {
  it('returns the single tile for a 16u box aligned to a tile', () => {
    expect(tilesInAabb({ x: 0, y: 0, w: 16, h: 16 })).toEqual([
      { tx: 0, ty: 0 },
    ]);
  });

  it('returns the 2x2 block a straddling box overlaps', () => {
    expect(tilesInAabb({ x: 8, y: 8, w: 16, h: 16 })).toEqual([
      { tx: 0, ty: 0 },
      { tx: 1, ty: 0 },
      { tx: 0, ty: 1 },
      { tx: 1, ty: 1 },
    ]);
  });

  it('clips to the field — no tiles beyond index 12', () => {
    expect(tilesInAabb({ x: 200, y: 200, w: 32, h: 32 })).toEqual([
      { tx: 12, ty: 12 },
    ]);
  });

  it('returns empty for a box fully outside the field', () => {
    expect(tilesInAabb({ x: -32, y: -32, w: 16, h: 16 })).toEqual([]);
  });
});

describe('grid.forEachSubcellUnder', () => {
  it('visits every subcell the box overlaps, in row-major order', () => {
    const visited: Array<[number, number]> = [];
    forEachSubcellUnder({ x: 0, y: 0, w: 16, h: 16 }, (sx, sy) =>
      visited.push([sx, sy]),
    );
    // a 16u box = 2x2 subcells (8u each)
    expect(visited).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
  });

  it('clips subcells to the field edges (0..25)', () => {
    const visited: Array<[number, number]> = [];
    forEachSubcellUnder({ x: 200, y: 200, w: 32, h: 32 }, (sx, sy) =>
      visited.push([sx, sy]),
    );
    expect(visited).toEqual([[25, 25]]);
  });

  it('never invokes the callback for a box fully outside the field', () => {
    let calls = 0;
    forEachSubcellUnder({ x: -100, y: -100, w: 8, h: 8 }, () => calls++);
    expect(calls).toBe(0);
  });
});
