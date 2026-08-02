import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NEO_STAGE_COUNT,
  allNeoStages,
  neoEffectiveStage,
  neoStage,
} from '../../src/levels/campaign';
import {
  analyseLevel,
  completabilityErrors,
  type AnnotatedLevel,
} from '../../src/levels/analysis';
import { validateLevel } from '../../src/levels/schema';
import { STAGE_CAP } from '../../src/core/constants';

const NEO_DIR = fileURLToPath(
  new URL('../../src/levels/neo/', import.meta.url),
);

function neoFiles(): AnnotatedLevel[] {
  return readdirSync(NEO_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(
      (f) =>
        JSON.parse(
          readFileSync(new URL(f, `file://${NEO_DIR}`), 'utf8'),
        ) as AnnotatedLevel,
    );
}

describe('the Neo Campaign (content §3)', () => {
  it('is exactly twelve stages, ids neo-01..neo-12', () => {
    const files = neoFiles();
    expect(files).toHaveLength(12);
    expect(NEO_STAGE_COUNT).toBe(12);
    expect(files.map((l) => l.id)).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `neo-${String(i + 1).padStart(2, '0')}`,
      ),
    );
  });

  it('carries the twelve names content §3 specifies', () => {
    expect(neoFiles().map((l) => l.name)).toEqual([
      'First Frost',
      'Twin Rivers',
      'The Orchard',
      'Foundry',
      'Shatterfront',
      'Frozen Harbor',
      'Greenwall',
      'The Vault',
      'Mirrorworks',
      'Sandglass',
      'Blackout',
      'Last Stand',
    ]);
  });

  it('serves every stage schema-valid and completable', () => {
    for (const level of allNeoStages()) {
      const result = validateLevel(level);
      expect(result.ok ? [] : result.errors, level.id).toEqual([]);
      // Reaching the base is the half of this that matters: a stage nothing
      // can lose is not a stage.
      expect(completabilityErrors(level), level.id).toEqual([]);
    }
  });

  it('serves twelve DIFFERENT layouts', () => {
    const fields = allNeoStages().map((l) => l.terrain.join('|'));
    expect(new Set(fields).size).toBe(NEO_STAGE_COUNT);
  });

  it('labels every stage authored, with a source and its idea', () => {
    // The brief's rule: a stage whose idea cannot be named in a line is
    // filler. The line lives in `notes` and is printed on the contact sheet,
    // so this assertion is what stops one being quietly dropped.
    for (const level of neoFiles()) {
      expect([level.id, level.provenance]).toEqual([level.id, 'authored']);
      expect(level.source ?? '').not.toBe('');
      expect((level.notes ?? '').length, level.id).toBeGreaterThan(40);
    }
  });

  it('gives every stage a 20-tank wave', () => {
    for (const level of allNeoStages()) {
      const { basic, fast, power, armor } = analyseLevel(level).enemyCounts;
      expect([level.id, basic + fast + power + armor]).toEqual([level.id, 20]);
    }
  });

  it('rejects a stage number outside 1..12 with a readable message', () => {
    for (const bad of [0, 13, -1, 1.5, Number.NaN]) {
      expect(() => neoStage(bad)).toThrow(/no such neo stage/);
    }
  });

  it('returns the same object for a repeated lookup', () => {
    expect(neoStage(5)).toBe(neoStage(5));
  });
});

describe('Neo difficulty curve (content §4)', () => {
  it('declares a rising effective stage from ≈20 to exactly 35', () => {
    const declared = Array.from({ length: 12 }, (_, i) =>
      neoEffectiveStage(i + 1),
    );
    expect(declared[0]).toBe(20);
    expect(declared[11]).toBe(STAGE_CAP);
    expect(declared[11]).toBe(35);
    for (let i = 1; i < declared.length; i++) {
      expect([i, declared[i] > declared[i - 1]]).toEqual([i, true]);
    }
    // Inside the band content §3 asks for: originals 18–35.
    expect(Math.min(...declared)).toBeGreaterThanOrEqual(18);
    expect(Math.max(...declared)).toBeLessThanOrEqual(35);
  });

  it('raises the armor share over the campaign', () => {
    const armor = allNeoStages().map((l) => analyseLevel(l).enemyCounts.armor);
    const early = armor.slice(0, 6).reduce((a, b) => a + b, 0);
    const late = armor.slice(6).reduce((a, b) => a + b, 0);
    expect(late).toBeGreaterThan(early);
  });

  it('oscillates openness rather than drifting one way', () => {
    // §4: "dense/open alternation keeps runs fresh, as the original does". The
    // failure this guards is a campaign that quietly gets more open (or more
    // dense) stage after stage, which reads as one long stage.
    const openness = allNeoStages().map((l) => analyseLevel(l).openness);
    let reversals = 0;
    for (let i = 2; i < openness.length; i++) {
      const before = Math.sign(openness[i - 1] - openness[i - 2]);
      const after = Math.sign(openness[i] - openness[i - 1]);
      if (before !== 0 && after !== 0 && before !== after) {
        reversals += 1;
      }
    }
    expect(reversals).toBeGreaterThanOrEqual(7);
    // …and no three-stage run all in the same direction.
    for (let i = 3; i < openness.length; i++) {
      const steps = [
        Math.sign(openness[i - 2] - openness[i - 3]),
        Math.sign(openness[i - 1] - openness[i - 2]),
        Math.sign(openness[i] - openness[i - 1]),
      ];
      expect([i, steps[0] === steps[1] && steps[1] === steps[2]]).toEqual([
        i,
        false,
      ]);
    }
    // The band the originals live in (23.7% … 67.5%), with Blackout allowed
    // to be the most open stage in the game because that IS Blackout.
    expect(Math.min(...openness)).toBeGreaterThan(0.2);
    expect(Math.max(...openness)).toBeLessThan(0.85);
  });
});

describe('the stages the briefs are most specific about', () => {
  it('Mirrorworks is perfectly symmetric, left to right', () => {
    // Content §3: "perfect left/right symmetry; designed around 2P split
    // defense". Every row must read the same in both directions, and so must
    // the half-tiles — a mask mirrored badly is the exact bug the editor's
    // quad mode exists to prevent.
    const level = neoStage(9) as AnnotatedLevel;
    for (const row of level.terrain) {
      expect(row).toBe([...row].reverse().join(''));
    }
    const masks = new Map<string, number>();
    for (const p of level.partials ?? []) {
      masks.set(`${p.tx},${p.ty}`, p.mask);
    }
    for (const p of level.partials ?? []) {
      const mirrored = masks.get(`${12 - p.tx},${p.ty}`);
      // 1=TL 2=TR 4=BL 8=BR — reflecting swaps left and right in each row.
      const expected =
        ((p.mask & 1) !== 0 ? 2 : 0) |
        ((p.mask & 2) !== 0 ? 1 : 0) |
        ((p.mask & 4) !== 0 ? 8 : 0) |
        ((p.mask & 8) !== 0 ? 4 : 0);
      expect([p.tx, p.ty, mirrored]).toEqual([p.tx, p.ty, expected]);
    }
  });

  it('Mirrorworks splits its lower field with an unbreakable spine', () => {
    // What "designed around 2P split defence" has to mean mechanically: below
    // row 7 there is no crossing, and the thing in the way is steel, so no
    // amount of shooting turns the two halves back into one. The two player
    // spawns then sit one on each side of it, which is the whole stage.
    const rows = neoStage(9).terrain;
    for (let ty = 7; ty <= 10; ty++) {
      expect([ty, rows[ty][6]]).toEqual([ty, 'S']);
    }
    expect(rows[12][4]).toBe('.'); // P1 spawn, left of the spine
    expect(rows[12][8]).toBe('.'); // P2 spawn, right of it
  });

  it('Mirrorworks sends a mirrored wave: the order is a palindrome', () => {
    const enemies = neoStage(9).enemies;
    expect(enemies).toEqual([...enemies].reverse());
  });

  it('The Vault has exactly one brick throat in its steel pocket', () => {
    // The stage's whole idea: hold the door and nothing gets in. If a second
    // hole ever appears the stage is a different stage.
    const rows = neoStage(8).terrain;
    const lid = rows[9].slice(3, 10);
    expect(lid).toBe('SSSBSSS');
    expect(rows[10][3]).toBe('S');
    expect(rows[11][3]).toBe('S');
    expect(rows[12][3]).toBe('S');
    expect(rows[10][9]).toBe('S');
  });

  it('Sandglass has a one-tile waist that cannot be widened', () => {
    const rows = neoStage(10).terrain;
    expect(rows[6][6]).toBe('.');
    // Steel on both shoulders: brick would mean the waist opens up under fire,
    // and then it is not an hourglass.
    expect(rows[6][5]).toBe('S');
    expect(rows[6][7]).toBe('S');
  });

  it('Blackout is the most open stage in the campaign', () => {
    const openness = allNeoStages().map((l) => analyseLevel(l).openness);
    expect(openness.indexOf(Math.max(...openness))).toBe(10);
  });

  it('Last Stand uses every terrain the format has', () => {
    const counts = analyseLevel(neoStage(12)).terrainCounts;
    for (const ch of ['B', 'S', 'W', 'T', 'I']) {
      expect([ch, counts[ch] > 0]).toEqual([ch, true]);
    }
  });
});
