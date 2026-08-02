// tests/editor/symmetry.test.ts — the tools T8.2's dogfooding pass asked for:
// mirror modes, line/rectangle/fill, and the coordinate readout.
//
// The load-bearing case is the SUBCELL one. Mirroring a half-tile is not
// "mirror the tile and keep the mask": a top-left half reflected across the
// field's vertical axis is a top-RIGHT half, and if the tile happens to be the
// centre column it does not even change tile. Every mirror below is therefore
// computed on the 26x26 subcell grid and folded back, and these tests pin that.
import { describe, expect, it } from 'vitest';
import {
  applyShape,
  createDraft,
  describeCursor,
  mirrorSubcells,
  mirrorTiles,
  paintMirrored,
  paintTile,
  type Brush,
  type MirrorMode,
  type ShapeTool,
} from '../../src/editor/tools';
import { createEditor } from '../../src/editor/editor';
import { validateLevel } from '../../src/levels/schema';
import type { LevelData } from '../../src/core/types';

function draft(): LevelData {
  return createDraft({ id: 'custom-test', name: 'Test', author: 'Tester' });
}

function tileAt(level: LevelData, tx: number, ty: number): string {
  return level.terrain[ty][tx];
}

function maskAt(level: LevelData, tx: number, ty: number): number | undefined {
  return level.partials?.find((p) => p.tx === tx && p.ty === ty)?.mask;
}

/** Sorted tuples, so a comparison is about the SET of targets, not the order. */
function sorted(
  points: { tx: number; ty: number; sub?: number }[],
): number[][] {
  return points
    .map((p) => [p.tx, p.ty, p.sub ?? -1])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

// ---------------------------------------------------------------------------
// --- Where a stroke lands --------------------------------------------------
// ---------------------------------------------------------------------------

describe('mirrorTiles', () => {
  it('is the identity when mirroring is off', () => {
    expect(mirrorTiles(3, 4, 'off')).toEqual([{ tx: 3, ty: 4 }]);
  });

  it('reflects left/right, top/bottom and both', () => {
    expect(sorted(mirrorTiles(3, 4, 'horizontal'))).toEqual([
      [3, 4, -1],
      [9, 4, -1],
    ]);
    expect(sorted(mirrorTiles(3, 4, 'vertical'))).toEqual([
      [3, 4, -1],
      [3, 8, -1],
    ]);
    expect(sorted(mirrorTiles(3, 4, 'quad'))).toEqual([
      [3, 4, -1],
      [3, 8, -1],
      [9, 4, -1],
      [9, 8, -1],
    ]);
  });

  it('collapses to one target on the axis itself', () => {
    // 13 is odd, so column 6 and row 6 ARE the axes. Painting them four times
    // would be three wasted paints and, worse, three history-sized no-ops.
    expect(mirrorTiles(6, 4, 'horizontal')).toHaveLength(1);
    expect(mirrorTiles(3, 6, 'vertical')).toHaveLength(1);
    expect(mirrorTiles(6, 6, 'quad')).toHaveLength(1);
    expect(mirrorTiles(6, 4, 'quad')).toHaveLength(2);
  });
});

describe('mirrorSubcells', () => {
  it('reflects the subcell too, not just the tile', () => {
    // A top-left half reflected across the vertical axis is a top-RIGHT half.
    expect(sorted(mirrorSubcells(5, 4, 1, 'horizontal'))).toEqual([
      [5, 4, 1],
      [7, 4, 0],
    ]);
    // …and across the horizontal axis, a bottom-left one.
    expect(sorted(mirrorSubcells(5, 4, 1, 'vertical'))).toEqual([
      [5, 4, 1],
      [5, 8, 3],
    ]);
  });

  it('quad-mirrors a subcell stroke into all four corners', () => {
    // 0=TL 1=TR 2=BL 3=BR (content §1's mask bits, in order).
    expect(sorted(mirrorSubcells(2, 3, 0, 'quad'))).toEqual([
      [2, 3, 0],
      [2, 9, 2],
      [10, 3, 1],
      [10, 9, 3],
    ]);
  });

  it('mirrors a half-tile WITHIN the centre tile', () => {
    // The subcell grid is 26 wide, so there is no self-mirroring subcell even
    // on the axis: tile 6's left half reflects onto tile 6's right half. A
    // tile-resolution mirror would have dropped this to a no-op.
    expect(sorted(mirrorSubcells(6, 4, 0, 'horizontal'))).toEqual([
      [6, 4, 0],
      [6, 4, 1],
    ]);
    expect(sorted(mirrorSubcells(4, 6, 0, 'vertical'))).toEqual([
      [4, 6, 0],
      [4, 6, 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// --- Painting through a mirror ---------------------------------------------
// ---------------------------------------------------------------------------

describe('paintMirrored', () => {
  it('paints all four tiles of a quad stroke in one call', () => {
    const res = paintMirrored(draft(), 1, 2, undefined, 'B', 'quad');
    expect(res.changed).toBe(true);
    for (const [tx, ty] of [
      [1, 2],
      [11, 2],
      [1, 10],
      [11, 10],
    ]) {
      expect([tx, ty, tileAt(res.level, tx, ty)]).toEqual([tx, ty, 'B']);
    }
    expect(validateLevel(res.level).ok).toBe(true);
  });

  it('mirrors a half-tile into the right corner of each quadrant', () => {
    const res = paintMirrored(draft(), 2, 3, 0, 'B', 'quad');
    expect(maskAt(res.level, 2, 3)).toBe(1); // TL
    expect(maskAt(res.level, 10, 3)).toBe(2); // TR
    expect(maskAt(res.level, 2, 9)).toBe(4); // BL
    expect(maskAt(res.level, 10, 9)).toBe(8); // BR
    // Still sorted by row then column, so the file bytes stay stable.
    expect(res.level.partials?.map((p) => [p.tx, p.ty])).toEqual([
      [2, 3],
      [10, 3],
      [2, 9],
      [10, 9],
    ]);
    expect(validateLevel(res.level).ok).toBe(true);
  });

  it('behaves exactly like paintTile when mirroring is off', () => {
    const level = draft();
    expect(paintMirrored(level, 4, 4, undefined, 'S', 'off').level).toEqual(
      paintTile(level, 4, 4, 'S').level,
    );
  });

  it('paints the primary and reports a mirror that fell on a reserved tile', () => {
    // (4,0) is paintable; its vertical reflection (4,12) is P1's spawn.
    const res = paintMirrored(draft(), 4, 0, undefined, 'B', 'vertical');
    expect(res.changed).toBe(true);
    expect(tileAt(res.level, 4, 0)).toBe('B');
    expect(tileAt(res.level, 4, 12)).toBe('.');
    expect(res.refused).toMatch(/mirror/i);
  });

  it('refuses the whole stroke when the struck tile itself is refused', () => {
    // (0,12) and (12,12) are perfectly paintable, so a mirror that carried on
    // regardless would paint two tiles the author never touched in answer to a
    // click that was told "no".
    const res = paintMirrored(draft(), 0, 0, undefined, 'B', 'quad');
    expect(res.changed).toBe(false);
    expect(res.refused).toMatch(/enemy spawn/i);
    expect(res.level.terrain[12]).toBe('.............');
  });

  it('does not paint the same tile twice on the axis', () => {
    const res = paintMirrored(draft(), 6, 4, undefined, 'B', 'horizontal');
    expect(res.level.terrain[4]).toBe('......B......');
  });
});

// ---------------------------------------------------------------------------
// --- Line, rectangle and fill ----------------------------------------------
// ---------------------------------------------------------------------------

function shape(
  level: LevelData,
  tool: ShapeTool,
  from: [number, number, number],
  to: [number, number, number],
  brush: Brush = 'B',
  mode: 'tile' | 'subcell' = 'tile',
  mirror: MirrorMode = 'off',
): LevelData {
  return applyShape(level, {
    tool,
    from: { tx: from[0], ty: from[1], sub: from[2] as 0 | 1 | 2 | 3 },
    to: { tx: to[0], ty: to[1], sub: to[2] as 0 | 1 | 2 | 3 },
    brush,
    mode,
    mirror,
  }).level;
}

describe('applyShape — line', () => {
  it('draws a four-tile wall in one drag', () => {
    // The complaint the tool exists for: this used to be four clicks.
    const level = shape(draft(), 'line', [2, 5, 0], [5, 5, 0]);
    expect(level.terrain[5]).toBe('..BBBB.......');
  });

  it('draws a vertical run and a diagonal', () => {
    const down = shape(draft(), 'line', [3, 2, 0], [3, 6, 0]);
    expect(down.terrain.map((r) => r[3]).join('')).toBe('..BBBBB......');
    const diag = shape(draft(), 'line', [1, 1, 0], [4, 4, 0]);
    expect([1, 2, 3, 4].map((n) => tileAt(diag, n, n))).toEqual([
      'B',
      'B',
      'B',
      'B',
    ]);
    expect(tileAt(diag, 2, 1)).toBe('.');
  });

  it('draws at half-tile resolution in subcell mode', () => {
    // Two tiles' worth of top halves — the originals' signature edge.
    const level = shape(draft(), 'line', [3, 4, 0], [4, 4, 1], 'B', 'subcell');
    expect(maskAt(level, 3, 4)).toBe(3); // TL|TR
    expect(maskAt(level, 4, 4)).toBe(3);
    expect(validateLevel(level).ok).toBe(true);
  });
});

describe('applyShape — rectangle', () => {
  it('draws the outline only', () => {
    const level = shape(draft(), 'rect', [3, 3, 0], [6, 6, 0]);
    expect(level.terrain[3].slice(3, 7)).toBe('BBBB');
    expect(level.terrain[4].slice(3, 7)).toBe('B..B');
    expect(level.terrain[5].slice(3, 7)).toBe('B..B');
    expect(level.terrain[6].slice(3, 7)).toBe('BBBB');
  });

  it('fills the whole block with rectFill', () => {
    const level = shape(draft(), 'rectFill', [3, 3, 0], [6, 6, 0]);
    for (let ty = 3; ty <= 6; ty++) {
      expect(level.terrain[ty].slice(3, 7)).toBe('BBBB');
    }
  });

  it('normalises a rectangle dragged up and to the left', () => {
    const forwards = shape(draft(), 'rectFill', [3, 3, 0], [6, 5, 0]);
    const backwards = shape(draft(), 'rectFill', [6, 5, 0], [3, 3, 0]);
    expect(backwards.terrain).toEqual(forwards.terrain);
  });

  it('fills a half-tile block in subcell mode', () => {
    // One tile's left half: subcells TL and BL.
    const level = shape(
      draft(),
      'rectFill',
      [2, 2, 0],
      [2, 2, 2],
      'B',
      'subcell',
    );
    expect(maskAt(level, 2, 2)).toBe(1 | 4);
  });
});

describe('applyShape — fill', () => {
  it('floods the region the seed tile belongs to, and stops at a wall', () => {
    // A steel line across row 6 cuts the field in two; a fill above it must not
    // leak below.
    let level = shape(draft(), 'line', [0, 6, 0], [12, 6, 0], 'S');
    level = shape(level, 'fill', [4, 2, 0], [4, 2, 0], 'W');
    expect(level.terrain[0]).toBe('.WWWWW.WWWWW.'); // spawn tiles stay clear
    expect(level.terrain[5]).toBe('WWWWWWWWWWWWW');
    expect(level.terrain[6]).toBe('SSSSSSSSSSSSS');
    expect(level.terrain[7]).toBe('.............');
  });

  it('does nothing when the seed already holds the brush', () => {
    const before = paintTile(draft(), 4, 4, 'B').level;
    const res = applyShape(before, {
      tool: 'fill',
      from: { tx: 4, ty: 4, sub: 0 },
      to: { tx: 4, ty: 4, sub: 0 },
      brush: 'B',
      mode: 'tile',
      mirror: 'off',
    });
    expect(res.changed).toBe(false);
    expect(res.level).toBe(before);
  });

  it('treats a half-tile as its own region rather than flooding through it', () => {
    // A partial tile is not the same material as an empty one, so the flood
    // stops there — otherwise a fill would silently erase the half-tiles that
    // the whole subcell mode exists for.
    let level = paintMirrored(draft(), 4, 4, 0, 'B', 'off').level;
    level = shape(level, 'fill', [0, 4, 0], [0, 4, 0], 'I');
    expect(maskAt(level, 4, 4)).toBe(1);
    expect(tileAt(level, 4, 4)).toBe('B');
    expect(tileAt(level, 3, 4)).toBe('I');
  });
});

describe('applyShape — with a mirror', () => {
  it('mirrors every cell of the shape', () => {
    const level = shape(
      draft(),
      'rectFill',
      [1, 2, 0],
      [3, 4, 0],
      'B',
      'tile',
      'horizontal',
    );
    for (let ty = 2; ty <= 4; ty++) {
      expect(level.terrain[ty]).toBe('.BBB.....BBB.');
    }
  });

  it('produces a field that reads the same left to right', () => {
    let level = shape(
      draft(),
      'line',
      [2, 8, 0],
      [4, 8, 0],
      'S',
      'tile',
      'horizontal',
    );
    level = shape(
      level,
      'rect',
      [1, 1, 0],
      [3, 3, 0],
      'B',
      'tile',
      'horizontal',
    );
    for (const row of level.terrain) {
      expect(row).toBe([...row].reverse().join(''));
    }
  });
});

// ---------------------------------------------------------------------------
// --- The coordinate readout ------------------------------------------------
// ---------------------------------------------------------------------------

describe('describeCursor', () => {
  it('names the tile and what is on it', () => {
    const level = paintTile(draft(), 7, 4, 'B').level;
    expect(describeCursor(level, { tx: 7, ty: 4, sub: 0 }, 'tile')).toBe(
      'Tile 7,4 · brick',
    );
    expect(describeCursor(level, { tx: 0, ty: 4, sub: 0 }, 'tile')).toBe(
      'Tile 0,4 · empty',
    );
  });

  it('adds the half-tile corner and its subcell coordinates', () => {
    const level = draft();
    expect(describeCursor(level, { tx: 7, ty: 4, sub: 1 }, 'subcell')).toBe(
      'Tile 7,4 · empty · half-tile TR (subcell 15,8)',
    );
    expect(describeCursor(level, { tx: 0, ty: 0, sub: 3 }, 'subcell')).toBe(
      'Tile 0,0 · empty · half-tile BR (subcell 1,1) · reserved',
    );
  });

  it('marks a reserved tile, because a refusal after the click is worse', () => {
    const level = draft();
    expect(describeCursor(level, { tx: 6, ty: 12, sub: 0 }, 'tile')).toMatch(
      /reserved$/,
    );
  });
});

// ---------------------------------------------------------------------------
// --- The editor model ------------------------------------------------------
// ---------------------------------------------------------------------------

describe('createEditor — tools and mirroring', () => {
  it('starts on the freehand brush with mirroring off', () => {
    const ed = createEditor(draft());
    expect(ed.tool()).toBe('brush');
    expect(ed.mirror()).toBe('off');
  });

  it('paints through the current mirror mode', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.setMirror('horizontal');
    ed.paintAt(2, 2);
    expect(ed.draft().terrain[2]).toBe('..B.......B..');
  });

  it('drags a rectangle as ONE undo step, previewing as it goes', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.setTool('rectFill');
    ed.beginShape({ tx: 2, ty: 2, sub: 0 });
    ed.updateShape({ tx: 5, ty: 5, sub: 0 });
    expect(ed.draft().terrain[3]).toBe('..BBBB.......');
    // The preview REPLACES rather than accumulates: dragging back has to
    // shrink the rectangle, not leave the big one behind it.
    ed.updateShape({ tx: 3, ty: 3, sub: 0 });
    expect(ed.draft().terrain[3]).toBe('..BB.........');
    expect(ed.draft().terrain[4]).toBe('.............');
    ed.endShape();

    expect(ed.canUndo()).toBe(true);
    expect(ed.undo()).toBe(true);
    expect(ed.draft().terrain[3]).toBe('.............');
    expect(ed.undo()).toBe(false);
  });

  it('stacks no history for a shape that changed nothing', () => {
    const ed = createEditor(draft());
    ed.setBrush('.');
    ed.setTool('rectFill');
    ed.beginShape({ tx: 2, ty: 2, sub: 0 });
    ed.updateShape({ tx: 4, ty: 4, sub: 0 });
    ed.endShape();
    expect(ed.canUndo()).toBe(false);
  });

  it('ignores an update that never began', () => {
    const ed = createEditor(draft());
    ed.setTool('line');
    expect(ed.updateShape({ tx: 4, ty: 4, sub: 0 })).toBe(false);
    ed.endShape();
    expect(ed.canUndo()).toBe(false);
  });

  it('reads the cursor out at both resolutions', () => {
    const ed = createEditor(draft());
    expect(ed.describeAt({ tx: 1, ty: 2, sub: 0 })).toBe('Tile 1,2 · empty');
    ed.setMode('subcell');
    expect(ed.describeAt({ tx: 1, ty: 2, sub: 3 })).toMatch(/half-tile BR/);
  });
});
