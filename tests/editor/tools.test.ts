import { describe, expect, it } from 'vitest';
import {
  BRUSHES,
  SUBCELL_BITS,
  createDraft,
  paintSubcell,
  paintTile,
  reservedTile,
  type Brush,
} from '../../src/editor/tools';
import {
  CARRIER_ORDINALS,
  WAVE_SIZE,
  carrierSlots,
  cycleSlotType,
  fillFrom,
  isCarrierSlot,
  setSlotType,
  waveCounts,
  waveSlots,
} from '../../src/editor/waveEditor';
import { createEditor } from '../../src/editor/editor';
import { validateLevel } from '../../src/levels/schema';
import type { LevelData } from '../../src/core/types';

// --- helpers ---------------------------------------------------------------

/** The character at a tile — the assertion most of this file is about. */
function tileAt(level: LevelData, tx: number, ty: number): string {
  return level.terrain[ty][tx];
}

/** The partial mask on a tile, or `undefined` when the tile has none. */
function maskAt(level: LevelData, tx: number, ty: number): number | undefined {
  return level.partials?.find((p) => p.tx === tx && p.ty === ty)?.mask;
}

/** A blank draft with a stable id, so tests never depend on a uuid. */
function draft(): LevelData {
  return createDraft({ id: 'custom-test', name: 'Test', author: 'Tester' });
}

// ---------------------------------------------------------------------------
// --- The draft -------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('createDraft (content §1)', () => {
  it('starts from an empty, schema-valid, 20-enemy level', () => {
    const level = draft();
    const result = validateLevel(level);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(level.terrain).toHaveLength(13);
    expect(level.terrain.every((r) => r === '.'.repeat(13))).toBe(true);
    expect(level.enemies).toHaveLength(20);
    expect(level.partials).toEqual([]);
  });

  it('mints a distinct custom id when none is given', () => {
    const a = createDraft();
    const b = createDraft();
    expect(a.id).toMatch(/^custom-/);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// --- Tile painting ---------------------------------------------------------
// ---------------------------------------------------------------------------

describe('paintTile', () => {
  it('writes the brush character and leaves every other tile alone', () => {
    const before = draft();
    const after = paintTile(before, 3, 4, 'B').level;
    expect(tileAt(after, 3, 4)).toBe('B');
    expect(after.terrain[4]).toBe('...B.........');
    // Immutable: the draft handed in is never edited in place, which is what
    // makes the undo stack a list of references rather than a list of clones.
    expect(tileAt(before, 3, 4)).toBe('.');
    expect(after).not.toBe(before);
  });

  it('paints every one of the six terrain kinds', () => {
    let level = draft();
    const kinds: Brush[] = ['B', 'S', 'W', 'T', 'I', '.'];
    kinds.forEach((k, i) => {
      level = paintTile(level, i, 6, k).level;
    });
    expect(level.terrain[6]).toBe('BSWTI........');
    expect(BRUSHES.map((b) => b.char)).toEqual(['.', 'B', 'S', 'W', 'T', 'I']);
  });

  it('drops a tile’s partial: a whole tile has no half-tiles', () => {
    let level = paintSubcell(draft(), 2, 2, 0, 'B').level;
    expect(maskAt(level, 2, 2)).toBe(1);
    level = paintTile(level, 2, 2, 'B').level;
    expect(maskAt(level, 2, 2)).toBeUndefined();
    expect(tileAt(level, 2, 2)).toBe('B');
  });

  it('reports no change when the brush is already what the tile is', () => {
    const before = draft();
    const res = paintTile(before, 1, 1, '.');
    expect(res.changed).toBe(false);
    expect(res.refused).toBeNull();
    // The very same object, so a no-op stroke cannot push an undo step.
    expect(res.level).toBe(before);
  });

  it('refuses the spawn tiles and the base, with the reason', () => {
    const level = draft();
    for (const [tx, ty] of [
      [0, 0],
      [6, 0],
      [12, 0],
    ]) {
      const res = paintTile(level, tx, ty, 'S');
      expect(res.changed).toBe(false);
      expect(res.refused).toMatch(/enemy spawn/i);
    }
    for (const [tx, ty] of [
      [4, 12],
      [8, 12],
    ]) {
      expect(paintTile(level, tx, ty, 'S').refused).toMatch(/player spawn/i);
    }
    // The eagle and its ring are stamped by the engine (fidelity §2), so
    // painting them would show nothing and read as a broken brush.
    for (const [tx, ty] of [
      [6, 12],
      [5, 11],
      [7, 12],
    ]) {
      expect(paintTile(level, tx, ty, 'S').refused).toMatch(/base|eagle/i);
    }
    expect(reservedTile(3, 3)).toBeNull();
  });

  it('ignores a tile outside the 13x13 field', () => {
    const level = draft();
    for (const [tx, ty] of [
      [-1, 0],
      [13, 0],
      [0, 13],
    ]) {
      const res = paintTile(level, tx, ty, 'B');
      expect(res.changed).toBe(false);
      expect(res.refused).toMatch(/outside the field/i);
    }
  });
});

// ---------------------------------------------------------------------------
// --- Subcell painting (the half-tiles the originals live on) ---------------
// ---------------------------------------------------------------------------

describe('paintSubcell (content §1: mask bits 1=TL 2=TR 4=BL 8=BR)', () => {
  it('turns an empty tile into a single-subcell partial', () => {
    const level = paintSubcell(draft(), 5, 5, 0, 'B').level;
    expect(tileAt(level, 5, 5)).toBe('B');
    expect(maskAt(level, 5, 5)).toBe(SUBCELL_BITS[0]);
    expect(validateLevel(level).ok).toBe(true);
  });

  it('accumulates bits in mask order TL, TR, BL, BR', () => {
    let level = draft();
    const masks: number[] = [];
    for (const sub of [0, 1, 2, 3] as const) {
      level = paintSubcell(level, 4, 4, sub, 'S').level;
      masks.push(maskAt(level, 4, 4) ?? 0);
    }
    // The fourth subcell completes the tile, which drops the partial — hence
    // the 0 rather than a 15. The next test is about that on its own.
    expect(masks).toEqual([1, 3, 7, 0]);
    expect(SUBCELL_BITS).toEqual([1, 2, 4, 8]);
  });

  it('drops the partial once all four subcells are filled', () => {
    let level = draft();
    for (const sub of [0, 1, 2, 3] as const) {
      level = paintSubcell(level, 4, 4, sub, 'B').level;
    }
    // A full tile IS the tile: keeping a mask of 15 would be a second way to
    // spell the same field, and the originals never do.
    expect(maskAt(level, 4, 4)).toBeUndefined();
    expect(tileAt(level, 4, 4)).toBe('B');
  });

  it('reproduces the half-tiles stage 1 is built from', () => {
    // stage01.json: `{ tx: 5, ty: 4, mask: 3 }` — the top half of a brick tile.
    let level = draft();
    level = paintSubcell(level, 5, 4, 0, 'B').level;
    level = paintSubcell(level, 5, 4, 1, 'B').level;
    expect(tileAt(level, 5, 4)).toBe('B');
    expect(maskAt(level, 5, 4)).toBe(3);
    // …and `{ tx: 5, ty: 5, mask: 12 }` — the bottom half.
    level = paintSubcell(level, 5, 5, 2, 'B').level;
    level = paintSubcell(level, 5, 5, 3, 'B').level;
    expect(maskAt(level, 5, 5)).toBe(12);
  });

  it('erases one subcell at a time, and clears the tile at the last one', () => {
    let level = paintTile(draft(), 7, 7, 'B').level;
    level = paintSubcell(level, 7, 7, 3, '.').level;
    expect(maskAt(level, 7, 7)).toBe(1 | 2 | 4);
    expect(tileAt(level, 7, 7)).toBe('B');

    for (const sub of [0, 1, 2] as const) {
      level = paintSubcell(level, 7, 7, sub, '.').level;
    }
    expect(tileAt(level, 7, 7)).toBe('.');
    expect(maskAt(level, 7, 7)).toBeUndefined();
  });

  it('keeps the occupancy but changes the material across brick and steel', () => {
    // One tile carries one material (content §1), so a mixed tile is not
    // representable. Replacing the material rather than the shape is the
    // reading that never destroys geometry.
    let level = paintSubcell(draft(), 2, 3, 0, 'B').level;
    level = paintSubcell(level, 2, 3, 1, 'B').level;
    expect(maskAt(level, 2, 3)).toBe(3);
    level = paintSubcell(level, 2, 3, 2, 'S').level;
    expect(tileAt(level, 2, 3)).toBe('S');
    expect(maskAt(level, 2, 3)).toBe(7);
  });

  it('refuses a half-tile of water, trees or ice', () => {
    // The format allows partials on B and S only, and validateLevel enforces
    // it — so the brush says no rather than letting the author build something
    // that fails at save time.
    for (const brush of ['W', 'T', 'I'] as const) {
      const res = paintSubcell(draft(), 6, 6, 0, brush);
      expect(res.changed).toBe(false);
      expect(res.refused).toMatch(/whole tile/i);
    }
  });

  it('erasing a subcell of water clears the whole tile, and says so', () => {
    const water = paintTile(draft(), 6, 6, 'W').level;
    const res = paintSubcell(water, 6, 6, 0, '.');
    expect(res.changed).toBe(true);
    expect(tileAt(res.level, 6, 6)).toBe('.');
    expect(res.refused).toMatch(/whole tile/i);
  });

  it('replaces water with the single subcell painted over it', () => {
    const water = paintTile(draft(), 6, 6, 'W').level;
    const res = paintSubcell(water, 6, 6, 3, 'B');
    expect(tileAt(res.level, 6, 6)).toBe('B');
    expect(maskAt(res.level, 6, 6)).toBe(8);
  });

  it('refuses the reserved tiles exactly as the tile brush does', () => {
    expect(paintSubcell(draft(), 0, 0, 0, 'B').refused).toMatch(/enemy spawn/i);
    expect(paintSubcell(draft(), 6, 12, 0, 'B').refused).toMatch(/base|eagle/i);
  });

  it('keeps partials sorted by row then column', () => {
    // Stable ordering is what makes a saved level, an exported file and a share
    // code byte-identical for the same field however it was drawn.
    let level = draft();
    for (const [tx, ty] of [
      [9, 9],
      [1, 1],
      [5, 9],
      [2, 1],
    ]) {
      level = paintSubcell(level, tx, ty, 0, 'B').level;
    }
    expect(level.partials?.map((p) => [p.tx, p.ty])).toEqual([
      [1, 1],
      [2, 1],
      [5, 9],
      [9, 9],
    ]);
  });
});

// ---------------------------------------------------------------------------
// --- The wave (fidelity §3.2) ----------------------------------------------
// ---------------------------------------------------------------------------

describe('the enemy wave editor', () => {
  it('is 20 ordered slots', () => {
    const slots = waveSlots(draft().enemies);
    expect(slots).toHaveLength(WAVE_SIZE);
    expect(slots.map((s) => s.ordinal)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('marks the 4th, 11th and 18th spawns as carriers', () => {
    expect(CARRIER_ORDINALS).toEqual([4, 11, 18]);
    expect(carrierSlots()).toEqual([3, 10, 17]);
    const carriers = waveSlots(draft().enemies)
      .filter((s) => s.carrier)
      .map((s) => s.ordinal);
    expect(carriers).toEqual([4, 11, 18]);
    expect(isCarrierSlot(3)).toBe(true);
    expect(isCarrierSlot(4)).toBe(false);
  });

  it('cannot move a carrier slot — no edit relocates one', () => {
    // Carrier positions are a RULE, not data (fidelity §3.2 / content §1), so
    // there is no setter for them and nothing the author can do to a wave
    // moves one. This walks every edit the editor offers, on every slot.
    let enemies = draft().enemies;
    for (let i = 0; i < WAVE_SIZE; i++) {
      enemies = setSlotType(enemies, i, 'armor');
      enemies = cycleSlotType(enemies, i, 1);
      enemies = cycleSlotType(enemies, i, -1);
      expect(
        waveSlots(enemies)
          .filter((s) => s.carrier)
          .map((s) => s.index),
      ).toEqual([3, 10, 17]);
    }
    enemies = fillFrom(enemies, 0, 'fast');
    expect(
      waveSlots(enemies)
        .filter((s) => s.carrier)
        .map((s) => s.index),
    ).toEqual([3, 10, 17]);
  });

  it('sets one slot without touching the others', () => {
    const before = draft().enemies;
    const after = setSlotType(before, 5, 'power');
    expect(after[5]).toBe('power');
    expect(after.filter((e) => e === 'basic')).toHaveLength(19);
    expect(before[5]).toBe('basic');
  });

  it('cycles a slot through the four types and wraps', () => {
    let enemies = draft().enemies;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      enemies = cycleSlotType(enemies, 0, 1);
      seen.push(enemies[0]);
    }
    expect(seen).toEqual(['fast', 'power', 'armor', 'basic', 'fast']);
    expect(cycleSlotType(enemies, 0, -1)[0]).toBe('basic');
  });

  it('fills from a slot to the end of the wave', () => {
    const enemies = fillFrom(draft().enemies, 17, 'armor');
    expect(enemies.slice(17)).toEqual(['armor', 'armor', 'armor']);
    expect(enemies.slice(0, 17).every((e) => e === 'basic')).toBe(true);
  });

  it('ignores an out-of-range slot', () => {
    const before = draft().enemies;
    expect(setSlotType(before, -1, 'armor')).toEqual(before);
    expect(setSlotType(before, 20, 'armor')).toEqual(before);
  });

  it('counts the wave by type', () => {
    expect(waveCounts(fillFrom(draft().enemies, 10, 'fast'))).toEqual({
      basic: 10,
      fast: 10,
      power: 0,
      armor: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// --- The editor model ------------------------------------------------------
// ---------------------------------------------------------------------------

describe('createEditor', () => {
  it('paints through the current tool', () => {
    const ed = createEditor(draft());
    ed.setBrush('S');
    ed.setMode('tile');
    ed.paintAt(3, 3);
    expect(tileAt(ed.draft(), 3, 3)).toBe('S');

    ed.setMode('subcell');
    ed.setBrush('B');
    ed.paintAt(8, 8, 1);
    expect(maskAt(ed.draft(), 8, 8)).toBe(2);
  });

  it('reports a refusal on the status line instead of silently doing nothing', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.paintAt(0, 0);
    expect(ed.status()).toMatch(/enemy spawn/i);
  });

  it('undoes a whole stroke, not one subcell of it', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.setMode('tile');
    ed.beginStroke();
    ed.paintAt(1, 1);
    ed.paintAt(2, 1);
    ed.paintAt(3, 1);
    ed.endStroke();
    expect(ed.draft().terrain[1]).toBe('.BBB.........');

    expect(ed.undo()).toBe(true);
    expect(ed.draft().terrain[1]).toBe('.............');
    expect(ed.redo()).toBe(true);
    expect(ed.draft().terrain[1]).toBe('.BBB.........');
    expect(ed.redo()).toBe(false);
  });

  it('does not stack an undo step for a stroke that changed nothing', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.beginStroke();
    ed.paintAt(0, 0); // reserved — refused
    ed.endStroke();
    expect(ed.undo()).toBe(false);
  });

  it('drops the redo stack once a new edit lands on an undone state', () => {
    const ed = createEditor(draft());
    ed.setBrush('B');
    ed.beginStroke();
    ed.paintAt(1, 1);
    ed.endStroke();
    ed.undo();
    ed.beginStroke();
    ed.paintAt(2, 2);
    ed.endStroke();
    expect(ed.redo()).toBe(false);
    expect(tileAt(ed.draft(), 1, 1)).toBe('.');
    expect(tileAt(ed.draft(), 2, 2)).toBe('B');
  });

  it('edits the wave and the metadata', () => {
    const ed = createEditor(draft());
    ed.setEnemy(0, 'armor');
    ed.setName('First Frost');
    ed.setAuthor('Tarik');
    expect(ed.draft().enemies[0]).toBe('armor');
    expect(ed.draft().name).toBe('First Frost');
    expect(ed.draft().author).toBe('Tarik');
  });

  it('surfaces validateLevel’s messages verbatim', () => {
    const ed = createEditor(draft());
    ed.setName('');
    const mine = ed.validate();
    const theirs = validateLevel(ed.draft());
    expect(theirs.ok).toBe(false);
    expect(mine).toEqual(theirs.ok ? [] : theirs.errors);
    expect(mine).toContain('name must be a non-empty string.');
  });

  it('surfaces a completability failure too, once the schema passes', () => {
    // A stage nothing can reach the base from is schema-valid and still not a
    // stage (content §4 / levels/analysis.ts), so both gates run before save.
    const ed = createEditor(draft());
    ed.setMode('tile');
    ed.setBrush('S');
    for (let tx = 0; tx < 13; tx++) {
      ed.paintAt(tx, 6);
    }
    const errors = ed.validate();
    expect(validateLevel(ed.draft()).ok).toBe(true);
    expect(errors.join('\n')).toMatch(/cannot reach the base/);
  });

  it('is clean for a level the originals would pass', () => {
    const ed = createEditor(draft());
    expect(ed.validate()).toEqual([]);
  });
});
