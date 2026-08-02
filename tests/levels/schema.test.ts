import { describe, expect, it } from 'vitest';
import fixtureJson from '../fixtures/level-basic.json';
import stage01Json from '../../src/levels/original/stage01.json';
import { validateLevel } from '../../src/levels/schema';

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

describe('shipped levels', () => {
  // The game boots straight into this file (`main.ts`), so a bad row length or
  // an occupied spawn tile would be a black screen rather than a test failure.
  it('stage01.json is schema-valid and still marked provisional', () => {
    const result = validateLevel(stage01Json);
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    // T7.2 replaces it. Until then the name has to say so on the HUD-facing
    // field, so nobody mistakes the approximation for the transcription.
    expect(stage01Json.name).toContain('provisional');
    expect(stage01Json.enemies).toHaveLength(20);
  });
});
