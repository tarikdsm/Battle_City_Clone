import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fixtureJson from '../fixtures/level-basic.json';
import mixedJson from '../fixtures/level-mixed.json';
import openJson from '../fixtures/level-open.json';
import stage01Json from '../../src/levels/original/stage01.json';
import { validateLevel } from '../../src/levels/schema';
import {
  BASE_RING_TILES,
  EAGLE_TILE,
  ENEMY_SPAWN_TILES,
  P1_SPAWN_TILE,
  P2_SPAWN_TILE,
} from '../../src/core/constants';
import {
  MIN_SPAWN_REACH,
  analyseLevel,
  completabilityErrors,
  renderContactSheet,
  type AnnotatedLevel,
} from '../../src/levels/analysis';
import type { LevelData } from '../../src/core/types';

// A loosely-typed level shape so tests can freely inject single flaws without
// fighting the strict LevelData type. validateLevel takes `unknown` anyway.
interface TestLevel {
  version: number;
  id: string;
  name: string;
  terrain: string[];
  enemies: string[];
  partials?: { tx: number; ty: number; mask: number }[];
  noAutoBase?: boolean;
}

function validLevel(): TestLevel {
  return {
    version: 1,
    id: 'ok',
    name: 'OK',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, () => 'basic'),
  };
}

function errorsOf(input: unknown): string[] {
  const res = validateLevel(input);
  if (res.ok) {
    throw new Error('expected validation to fail, but it passed');
  }
  return res.errors;
}

function setTileChar(l: TestLevel, tx: number, ty: number, ch: string): void {
  const row = l.terrain[ty].split('');
  row[tx] = ch;
  l.terrain[ty] = row.join('');
}

describe('validateLevel — rejects malformed levels', () => {
  it('rejects a terrain with 12 rows', () => {
    const l = validLevel();
    l.terrain = l.terrain.slice(0, 12);
    expect(errorsOf(l).join(' ')).toMatch(/13 rows/i);
  });

  it('rejects a 14-char row', () => {
    const l = validLevel();
    l.terrain[3] = '.'.repeat(14);
    expect(errorsOf(l).join(' ')).toMatch(/row length/i);
  });

  it('rejects an invalid terrain char', () => {
    const l = validLevel();
    setTileChar(l, 3, 3, 'X');
    expect(errorsOf(l).join(' ')).toMatch(/invalid char/i);
  });

  it('rejects a level with 19 enemies', () => {
    const l = validLevel();
    l.enemies = l.enemies.slice(0, 19);
    expect(errorsOf(l).join(' ')).toMatch(/20 enem/i);
  });

  it('rejects a partial placed on a water tile', () => {
    const l = validLevel();
    setTileChar(l, 10, 4, 'W');
    l.partials = [{ tx: 10, ty: 4, mask: 1 }];
    expect(errorsOf(l).join(' ')).toMatch(/partial/i);
  });

  it('rejects brick on an enemy spawn tile (6,0)', () => {
    const l = validLevel();
    setTileChar(l, 6, 0, 'B');
    expect(errorsOf(l).join(' ')).toMatch(/spawn/i);
  });

  it('rejects brick on a player spawn tile (4,12)', () => {
    const l = validLevel();
    setTileChar(l, 4, 12, 'B');
    expect(errorsOf(l).join(' ')).toMatch(/spawn/i);
  });

  it('reports multiple violations together', () => {
    const l = validLevel();
    setTileChar(l, 3, 3, 'X'); // invalid char
    l.enemies = l.enemies.slice(0, 19); // wrong enemy count
    expect(errorsOf(l)).toHaveLength(2);
  });
});

describe('validateLevel — accepts valid levels', () => {
  it('accepts the basic fixture', () => {
    expect(validateLevel(fixtureJson).ok).toBe(true);
  });
});

// --- Completability --------------------------------------------------------
//
// Schema validity says a level *loads*; completability says it can be *played*.
// The check models a tank's reach rather than a bullet's: brick counts as
// traversable because it is destructible — a brick wall costs a tank time, not
// access — while steel and water are permanent walls for an enemy.
//
// That reading is forced by the requirement's own second half. The eagle sits
// inside a brick ring the engine stamps on every level (fidelity §2), so a
// "reach the base" test over empty tiles alone could never pass on ANY level.
// It is also the only reading the originals survive: over empty tiles alone,
// 20 of the 35 transcribed stages fall under the 40% bar (stage 21's centre
// spawn reaches 1.2%), because Battle City is a game about shooting your way
// out of a brick maze. Measured on the shipped stages, the weakest stage under
// the shipped rule is 31 at 63.9%.

function blankLevel(): LevelData {
  return {
    version: 1,
    id: 'blank',
    name: 'Blank',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, () => 'basic' as const),
  };
}

function setChar(l: LevelData, tx: number, ty: number, ch: string): void {
  const row = l.terrain[ty].split('');
  row[tx] = ch;
  l.terrain[ty] = row.join('');
}

describe('completabilityErrors — reachability of a level', () => {
  it('passes an empty field', () => {
    expect(completabilityErrors(blankLevel())).toEqual([]);
  });

  it('passes every shipped test fixture', () => {
    for (const f of [fixtureJson, mixedJson, openJson]) {
      expect(completabilityErrors(f as unknown as LevelData)).toEqual([]);
    }
  });

  it('rejects an enemy spawn walled off by steel', () => {
    const l = blankLevel();
    setChar(l, 1, 0, 'S');
    setChar(l, 1, 1, 'S');
    setChar(l, 0, 1, 'S');
    const errors = completabilityErrors(l);
    expect(errors.join(' ')).toMatch(/enemy spawn \(0,0\)/);
    expect(errors.join(' ')).toMatch(/at least 40\.0% required/);
  });

  it('rejects a base sealed behind an unbreakable wall', () => {
    const l = blankLevel();
    l.terrain[10] = 'S'.repeat(13);
    const errors = completabilityErrors(l);
    // The field above the wall is wide open, so only the base check fires.
    expect(errors).toHaveLength(ENEMY_SPAWN_TILES.length);
    expect(errors.join(' ')).toMatch(/cannot reach the base/);
  });

  it('counts brick as traversable but steel as a wall', () => {
    const brick = blankLevel();
    brick.terrain[10] = 'B'.repeat(13);
    expect(completabilityErrors(brick)).toEqual([]);

    const steel = blankLevel();
    steel.terrain[10] = 'S'.repeat(13);
    expect(completabilityErrors(steel).length).toBeGreaterThan(0);
  });

  it('rejects a field quartered by water', () => {
    const l = blankLevel();
    for (let y = 0; y < 13; y++) {
      if (y !== 12) setChar(l, 3, y, 'W');
    }
    l.terrain[6] = 'W'.repeat(13);
    setChar(l, 4, 12, '.');
    const errors = completabilityErrors(l);
    expect(errors.join(' ')).toMatch(/enemy spawn/);
  });
});

describe('analyseLevel — metrics', () => {
  it('measures openness after the engine stamps the base', () => {
    const a = analyseLevel(blankLevel());
    // 169 tiles minus the 5 brick ring tiles the stamp adds; the eagle tile is
    // cleared by the same stamp and stays empty.
    expect(a.openness).toBeCloseTo((169 - BASE_RING_TILES.length) / 169, 10);
    expect(a.minSpawnReach).toBe(1);
    expect(a.baseReachable).toBe(true);
  });

  it('reports the enemy composition', () => {
    const a = analyseLevel(mixedJson as unknown as LevelData);
    const { basic, fast, power, armor } = a.enemyCounts;
    expect(basic + fast + power + armor).toBe(20);
  });

  it('renders 26 subcell rows, expanding partial tiles', () => {
    const l = blankLevel();
    setChar(l, 0, 0, 'B');
    l.partials = [{ tx: 0, ty: 0, mask: 1 }];
    const rows = analyseLevel(l).subcellRows;
    expect(rows).toHaveLength(26);
    expect(rows.every((r) => r.length === 26)).toBe(true);
    expect(rows[0].slice(0, 2)).toBe('#.');
    expect(rows[1].slice(0, 2)).toBe('..');
  });

  it('agrees with core about where the spawns, base and eagle are', () => {
    // analysis.ts re-declares the field constants because levels/ may import
    // core *types* only (arch §2). This is the guard against the two drifting.
    const a = analyseLevel(blankLevel());
    expect(a.enemySpawns).toEqual(ENEMY_SPAWN_TILES.map(([x, y]) => [x, y]));
    expect(a.playerSpawns).toEqual([
      [P1_SPAWN_TILE[0], P1_SPAWN_TILE[1]],
      [P2_SPAWN_TILE[0], P2_SPAWN_TILE[1]],
    ]);
    expect(a.eagle).toEqual([EAGLE_TILE[0], EAGLE_TILE[1]]);
    expect(a.baseRing).toEqual(BASE_RING_TILES.map(([x, y]) => [x, y]));
    expect(MIN_SPAWN_REACH).toBe(0.4);
  });
});

// --- The contact sheet -----------------------------------------------------

const ORIGINAL_DIR = fileURLToPath(
  new URL('../../src/levels/original/', import.meta.url),
);
const SHEET_PATH = fileURLToPath(
  new URL('../../docs/assets/level-contact-sheet.txt', import.meta.url),
);

function shippedLevels(): AnnotatedLevel[] {
  return readdirSync(ORIGINAL_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(
      (f) =>
        JSON.parse(
          readFileSync(new URL(f, `file://${ORIGINAL_DIR}`), 'utf8'),
        ) as AnnotatedLevel,
    );
}

describe('contact sheet', () => {
  it('is deterministic for the same input', () => {
    const levels = shippedLevels();
    expect(renderContactSheet(levels)).toBe(renderContactSheet(levels));
  });

  it('matches the committed docs/assets/level-contact-sheet.txt', () => {
    // Regenerate with `npm run levels:preview` after touching any level file.
    expect(renderContactSheet(shippedLevels())).toBe(
      readFileSync(SHEET_PATH, 'utf8'),
    );
  });
});

describe('shipped levels', () => {
  // Stage 1 is the attract board behind the title screen as well as the first
  // stage of a run (`main.ts`), so a bad row length or an occupied spawn tile
  // here would be a black screen on boot rather than a test failure.
  // `tests/levels/campaign.test.ts` covers all 35 the same way.
  it('stage01.json is schema-valid', () => {
    const result = validateLevel(stage01Json);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(stage01Json.enemies).toHaveLength(20);
  });

  it('ships exactly the 35 original stages, ids orig-01..orig-35', () => {
    const levels = shippedLevels();
    expect(levels).toHaveLength(35);
    expect(levels.map((l) => l.id)).toEqual(
      Array.from(
        { length: 35 },
        (_, i) => `orig-${String(i + 1).padStart(2, '0')}`,
      ),
    );
    expect(levels.map((l) => l.name)).toEqual(
      Array.from({ length: 35 }, (_, i) => `Stage ${i + 1}`),
    );
  });

  it('every shipped level is schema-valid and completable', () => {
    for (const level of shippedLevels()) {
      const result = validateLevel(level);
      expect(result.ok ? [] : result.errors).toEqual([]);
      expect(completabilityErrors(level)).toEqual([]);
    }
  });

  // The headline deliverable of the transcription task (T7.1) is knowing which
  // stages are the originals and which are inventions. An unlabelled stage, or
  // one labelled without a source to check it against, is the failure this
  // asserts against.
  it('labels every stage transcribed or reconstructed, with a source', () => {
    for (const level of shippedLevels()) {
      expect([level.id, level.provenance]).toEqual([
        level.id,
        expect.stringMatching(/^(transcribed|reconstructed)$/),
      ]);
      expect(level.source ?? '').not.toBe('');
    }
  });

  it('stage 1 is the sparse brick layout with a basic-dominated wave', () => {
    // Content doc 05 §2.2's sanity anchor: if this ever stops holding, the
    // transcription pipeline is suspect, whatever the other 34 files say.
    const [stage1] = shippedLevels();
    const a = analyseLevel(stage1);
    expect(a.enemyCounts).toEqual({ basic: 18, fast: 2, power: 0, armor: 0 });
    expect(a.terrainCounts.W).toBe(0);
    expect(a.terrainCounts.T).toBe(0);
    expect(a.terrainCounts.I).toBe(0);
    expect(a.openness).toBeGreaterThan(0.5);
    // The lone steel block above the base, and nothing else steel but the two
    // side pieces on row 7.
    expect(a.terrainCounts.S).toBe(3);
  });

  it('gives every stage a 20-tank wave', () => {
    for (const level of shippedLevels()) {
      const { basic, fast, power, armor } = analyseLevel(level).enemyCounts;
      expect([level.id, basic + fast + power + armor]).toEqual([level.id, 20]);
    }
  });
});
