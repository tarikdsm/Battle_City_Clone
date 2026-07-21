import { describe, expect, it } from 'vitest';
import fixtureJson from '../fixtures/level-basic.json';
import { BASE_RING_TILES, EAGLE_TILE } from '../../src/core/constants';
import { createGame, hashState, stepGame } from '../../src/core/game';
import { subcellIndex } from '../../src/core/grid';
import { NULL_INTENT, Terrain } from '../../src/core/types';
import type { EnemyType, LevelData } from '../../src/core/types';

const fixture = fixtureJson as unknown as LevelData;
const OPTS = { players: 1 as const, seed: 12345, stageNumber: 7 };

// An all-empty 13x13 level; individual tests decorate specific tiles.
function blankLevel(): LevelData {
  return {
    version: 1,
    id: 'blank',
    name: 'Blank',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
  };
}

function setTileChar(l: LevelData, tx: number, ty: number, ch: string): void {
  const row = l.terrain[ty].split('');
  row[tx] = ch;
  l.terrain[ty] = row.join('');
}

describe('createGame — terrain grid', () => {
  it('builds a 676-subcell terrain grid', () => {
    const s = createGame(blankLevel(), OPTS);
    expect(s.terrain.length).toBe(676);
  });

  it('auto-stamps the base ring as brick and clears the eagle tile', () => {
    const s = createGame(blankLevel(), OPTS);
    for (const [tx, ty] of BASE_RING_TILES) {
      const sx = tx * 2;
      const sy = ty * 2;
      expect(s.terrain[subcellIndex(sx, sy)]).toBe(Terrain.Brick);
      expect(s.terrain[subcellIndex(sx + 1, sy)]).toBe(Terrain.Brick);
      expect(s.terrain[subcellIndex(sx, sy + 1)]).toBe(Terrain.Brick);
      expect(s.terrain[subcellIndex(sx + 1, sy + 1)]).toBe(Terrain.Brick);
    }
    const [ex, ey] = EAGLE_TILE;
    const esx = ex * 2;
    const esy = ey * 2;
    expect(s.terrain[subcellIndex(esx, esy)]).toBe(Terrain.Empty);
    expect(s.terrain[subcellIndex(esx + 1, esy)]).toBe(Terrain.Empty);
    expect(s.terrain[subcellIndex(esx, esy + 1)]).toBe(Terrain.Empty);
    expect(s.terrain[subcellIndex(esx + 1, esy + 1)]).toBe(Terrain.Empty);
  });

  it('maps fixture tiles to the correct terrain kinds', () => {
    const s = createGame(fixture, OPTS);
    // Empty — tile (0,0)
    expect(s.terrain[subcellIndex(0, 0)]).toBe(Terrain.Empty);
    expect(s.terrain[subcellIndex(1, 1)]).toBe(Terrain.Empty);
    // Brick — tiles (6,6) and (6,5) of the cross
    expect(s.terrain[subcellIndex(12, 12)]).toBe(Terrain.Brick);
    expect(s.terrain[subcellIndex(12, 10)]).toBe(Terrain.Brick);
    // Steel — tile (2,4)
    expect(s.terrain[subcellIndex(4, 8)]).toBe(Terrain.Steel);
    expect(s.terrain[subcellIndex(5, 9)]).toBe(Terrain.Steel);
    // Water — tile (10,4)
    expect(s.terrain[subcellIndex(20, 8)]).toBe(Terrain.Water);
    expect(s.terrain[subcellIndex(21, 9)]).toBe(Terrain.Water);
    // Trees — tile (2,8)
    expect(s.terrain[subcellIndex(4, 16)]).toBe(Terrain.Trees);
    expect(s.terrain[subcellIndex(5, 17)]).toBe(Terrain.Trees);
    // Ice — tile (10,8)
    expect(s.terrain[subcellIndex(20, 16)]).toBe(Terrain.Ice);
    expect(s.terrain[subcellIndex(21, 17)]).toBe(Terrain.Ice);
  });

  it('applies partial subcell masks (mask 5 = TL+BL kept, TR+BR cleared)', () => {
    const level = blankLevel();
    setTileChar(level, 2, 2, 'B');
    level.partials = [{ tx: 2, ty: 2, mask: 5 }];
    const s = createGame(level, OPTS);
    expect(s.terrain[subcellIndex(4, 4)]).toBe(Terrain.Brick); // TL
    expect(s.terrain[subcellIndex(4, 5)]).toBe(Terrain.Brick); // BL
    expect(s.terrain[subcellIndex(5, 4)]).toBe(Terrain.Empty); // TR
    expect(s.terrain[subcellIndex(5, 5)]).toBe(Terrain.Empty); // BR
  });

  it('noAutoBase skips ring/eagle stamping and preserves row content', () => {
    const level = blankLevel();
    level.noAutoBase = true;
    setTileChar(level, 5, 11, 'S'); // where a ring tile would be brick-stamped
    setTileChar(level, 6, 12, 'B'); // the eagle tile itself
    const s = createGame(level, OPTS);
    expect(s.terrain[subcellIndex(10, 22)]).toBe(Terrain.Steel); // ring preserved
    expect(s.terrain[subcellIndex(12, 24)]).toBe(Terrain.Brick); // eagle not cleared
  });
});

describe('createGame — players', () => {
  it('1P activates only player 1', () => {
    const s = createGame(blankLevel(), { players: 1, seed: 1, stageNumber: 1 });
    expect(s.players[0].active).toBe(true);
    expect(s.players[0].lives).toBe(3);
    expect(s.players[1].active).toBe(false);
    expect(s.players[1].lives).toBe(0);
  });

  it('2P activates both players with 3 lives', () => {
    const s = createGame(blankLevel(), { players: 2, seed: 1, stageNumber: 1 });
    expect(s.players[0].active).toBe(true);
    expect(s.players[1].active).toBe(true);
    expect(s.players[0].lives).toBe(3);
    expect(s.players[1].lives).toBe(3);
  });
});

describe('stepGame — skeleton', () => {
  it('advances tick and clears the prior frame events each step', () => {
    const s = createGame(blankLevel(), OPTS);
    s.events.push({ t: 'gameOver' });
    const before = s.tick;
    stepGame(s, [NULL_INTENT, NULL_INTENT]);
    expect(s.tick).toBe(before + 1);
    // Events are wiped at the top of each step; live systems may then emit their
    // own (the spawner starts enemy #1 at t=0), so assert the stale sentinel is
    // gone rather than that the array is empty.
    expect(s.events.some((e) => e.t === 'gameOver')).toBe(false);
  });
});

describe('hashState', () => {
  it('is stable across identical createGame calls', () => {
    const a = createGame(fixture, OPTS);
    const b = createGame(fixture, OPTS);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('changes when a single terrain subcell is flipped', () => {
    const s = createGame(fixture, OPTS);
    const before = hashState(s);
    s.terrain[0] =
      s.terrain[0] === Terrain.Empty ? Terrain.Brick : Terrain.Empty;
    expect(hashState(s)).not.toBe(before);
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = hashState(createGame(fixture, OPTS));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBe(h >>> 0);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
