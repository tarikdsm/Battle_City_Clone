import { describe, expect, it } from 'vitest';
import { createGame, hashState, stepGame } from '../../src/core/game';
import {
  makeTank,
  movementSystem,
  moveTank,
} from '../../src/core/systems/movement';
import { NULL_INTENT } from '../../src/core/types';
import type {
  Dir,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  Tank,
} from '../../src/core/types';

// Dir literals (types.ts: 0 Up, 1 Right, 2 Down, 3 Left).
const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const OPTS = { players: 1 as const, seed: 1, stageNumber: 1 };

// A wholly-empty field with NO auto base ring, so tests place exactly the
// terrain they need without the base bricks interfering.
function emptyLevel(): LevelData {
  return {
    version: 1,
    id: 'mv',
    name: 'Movement Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
    noAutoBase: true,
  };
}

function setTileChar(l: LevelData, tx: number, ty: number, ch: string): void {
  const row = l.terrain[ty].split('');
  row[tx] = ch;
  l.terrain[ty] = row.join('');
}

function intent(dir: Dir | null): PlayerIntent {
  return { dir, fire: false, pause: false };
}

// One tick of play driving player 1 with `dir`; player 2 idle.
function stepDir(s: GameState, dir: Dir | null): void {
  stepGame(s, [intent(dir), NULL_INTENT]);
}

function addPlayer(s: GameState, over: Partial<Tank>): Tank {
  const t = makeTank({
    id: 1,
    kind: 'player',
    playerIndex: 0,
    x: 0,
    y: 0,
    ...over,
  });
  s.tanks.push(t);
  return t;
}

// Float equality at the brief's stated tolerance.
function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

function countEvents(s: GameState, t: string): number {
  return s.events.filter((e) => e.t === t).length;
}

describe('movement — straight run & facing (P-01)', () => {
  it('P-01: straight run advances 45 u/s and keeps dir/axis', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 32, y: 80, dir: RIGHT });
    for (let i = 0; i < 60; i++) {
      stepDir(s, RIGHT);
      expect(t.moving).toBe(true);
    }
    near(t.x, 77); // 32 + 60 * (45/60)
    near(t.y, 80);
    expect(t.dir).toBe(RIGHT);
  });

  it('P-01: 90 deg turn (Right->Up) snaps former axis x to nearest 8u', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 37.3, y: 80, dir: RIGHT });
    stepDir(s, UP);
    expect(t.x).toBe(40); // snap8(37.3)
    expect(t.dir).toBe(UP);
    near(t.y, 80 - 0.75); // then moves up 45/60
  });

  it('P-01: 90 deg turn snaps x half-up (x=36 -> 40)', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 36, y: 80, dir: RIGHT });
    stepDir(s, UP);
    expect(t.x).toBe(40); // snap8(36) rounds half-up to 40
    expect(t.dir).toBe(UP);
  });

  it('P-01: 90 deg turn (Up->Left) snaps former axis y', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 80, y: 41.2, dir: UP });
    stepDir(s, LEFT);
    expect(t.y).toBe(40); // snap8(41.2)
    expect(t.dir).toBe(LEFT);
  });

  it('P-01: 180 deg reversal does NOT snap', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 37.3, y: 80, dir: RIGHT });
    stepDir(s, LEFT);
    near(t.x, 37.3 - 0.75); // no snap, just moves left
    expect(t.dir).toBe(LEFT);
  });
});

describe('movement — blocking & flush contact', () => {
  it('brick stops the tank flush (never overlaps)', () => {
    const level = emptyLevel();
    setTileChar(level, 5, 5, 'B'); // tile (5,5) -> x 80..96, y 80..96
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 60, y: 80, dir: RIGHT });
    for (let i = 0; i < 40; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(64); // 80 - TANK_SIZE
    expect(t.moving).toBe(false);
  });

  it('P-09: steel blocks tanks identically to brick', () => {
    const level = emptyLevel();
    setTileChar(level, 5, 5, 'S');
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 60, y: 80, dir: RIGHT });
    for (let i = 0; i < 40; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(64);
  });

  it('P-09: water blocks tanks identically to brick', () => {
    const level = emptyLevel();
    setTileChar(level, 5, 5, 'W');
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 60, y: 80, dir: RIGHT });
    for (let i = 0; i < 40; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(64);
  });

  it('P-09: trees never block and emit treeEntered exactly once per crossing', () => {
    const level = emptyLevel();
    setTileChar(level, 5, 5, 'T'); // trees at x 80..96
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 60, y: 80, dir: RIGHT });
    let treeEvents = 0;
    for (let i = 0; i < 60; i++) {
      stepDir(s, RIGHT);
      treeEvents += countEvents(s, 'treeEntered');
    }
    expect(t.x).toBeGreaterThan(96); // crossed straight through the trees
    expect(treeEvents).toBe(1);
  });

  it('P-09: ice never blocks a tank driven straight through', () => {
    const level = emptyLevel();
    setTileChar(level, 5, 5, 'I');
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 60, y: 80, dir: RIGHT });
    for (let i = 0; i < 300; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(192); // reached the far border, never stopped by ice
  });

  it('border clamps: left at x=0 stays, right ends flush at 192', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 0, y: 80, dir: LEFT });
    stepDir(s, LEFT);
    expect(t.x).toBe(0);
    expect(t.moving).toBe(false);
    for (let i = 0; i < 300; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(192); // FIELD_U - TANK_SIZE
  });
});

describe('movement — tank & eagle blocking', () => {
  it('a materialized tank blocks; a spawning tank does not', () => {
    // Blocking case: second (materialized) tank at (96,80).
    const s1 = createGame(emptyLevel(), OPTS);
    const mover = addPlayer(s1, { x: 60, y: 80, dir: RIGHT });
    s1.tanks.push(
      makeTank({ id: 2, kind: 'enemy', enemyType: 'basic', x: 96, y: 80 }),
    );
    for (let i = 0; i < 60; i++) stepDir(s1, RIGHT);
    expect(mover.x).toBe(80); // 96 - TANK_SIZE

    // Pass-through case: the blocker is still spawning (no hitbox).
    const s2 = createGame(emptyLevel(), OPTS);
    const mover2 = addPlayer(s2, { x: 60, y: 80, dir: RIGHT });
    s2.tanks.push(
      makeTank({
        id: 2,
        kind: 'enemy',
        enemyType: 'basic',
        x: 96,
        y: 80,
        spawningT: 1,
      }),
    );
    for (let i = 0; i < 300; i++) stepDir(s2, RIGHT);
    expect(mover2.x).toBe(192); // sailed past the spawning tank to the border
  });

  it('the eagle blocks while alive, and stops blocking once destroyed', () => {
    const s = createGame(emptyLevel(), OPTS); // eagle at tile (6,12) -> (96,192)
    const t = addPlayer(s, { x: 60, y: 192, dir: RIGHT });
    for (let i = 0; i < 60; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(80); // 96 - TANK_SIZE

    s.eagleAlive = false;
    for (let i = 0; i < 300; i++) stepDir(s, RIGHT);
    expect(t.x).toBe(192);
  });
});

describe('movement — ice slide (P-09)', () => {
  function iceRowLevel(): LevelData {
    const level = emptyLevel();
    for (let tx = 3; tx <= 9; tx++) setTileChar(level, tx, 5, 'I'); // y 80..96
    return level;
  }

  it('P-09: releasing input on ice slides further then stops at rest', () => {
    const s = createGame(iceRowLevel(), OPTS);
    const t = addPlayer(s, { x: 48, y: 80, dir: RIGHT });
    for (let i = 0; i < 4; i++) stepDir(s, RIGHT); // drive up to speed on ice
    expect(t.moving).toBe(true);
    expect(t.sliding).toBe(false); // holding input => not sliding

    const xRelease = t.x;
    let skids = 0;
    let guard = 0;
    do {
      stepDir(s, null);
      skids += countEvents(s, 'iceSkidStarted');
      guard++;
    } while (t.sliding && guard < 200);

    const extra = t.x - xRelease;
    expect(extra).toBeGreaterThan(3.5);
    expect(extra).toBeLessThan(5);
    expect(skids).toBe(1); // emitted exactly once
    expect(t.sliding).toBe(false);
    expect(t.slideV).toBe(0);
    expect(t.moving).toBe(false);
  });

  it('P-09: directional input overrides an active slide immediately', () => {
    const s = createGame(iceRowLevel(), OPTS);
    const t = addPlayer(s, { x: 48, y: 80, dir: RIGHT });
    for (let i = 0; i < 4; i++) stepDir(s, RIGHT);
    stepDir(s, null); // begin sliding
    expect(t.sliding).toBe(true);

    stepDir(s, DOWN); // override
    expect(t.sliding).toBe(false);
    expect(t.slideV).toBe(0);
    expect(t.dir).toBe(DOWN);
  });

  it('P-09: momentum carries the slide off the ice edge (no hard stop)', () => {
    // Ice under a single tile (x 48..64). The tank is released near the far edge
    // so the slide crosses OFF the ice partway through. A hard stop at the edge
    // would cut the slide short (~3u to x=60); momentum yields the full ~4.6u.
    const level = emptyLevel();
    setTileChar(level, 3, 5, 'I'); // x 48..64; center leaves ice at x >= 60
    const s = createGame(level, OPTS);
    const t = addPlayer(s, { x: 48, y: 80, dir: RIGHT });
    for (let i = 0; i < 12; i++) stepDir(s, RIGHT); // drive to ~x=57 (still on ice)
    const xRelease = t.x;
    expect(xRelease).toBeLessThan(60); // on ice at release

    let guard = 0;
    do {
      stepDir(s, null);
      guard++;
    } while (t.sliding && guard < 200);

    expect(t.x).toBeGreaterThan(60); // slid clear off the ice zone
    expect(t.x - xRelease).toBeGreaterThan(3.5); // full momentum, not an edge stop
    expect(t.x - xRelease).toBeLessThan(5);
  });
});

describe('movement — disabled states', () => {
  it('does not move while spawningT > 0', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 32, y: 80, dir: RIGHT, spawningT: 1 });
    stepDir(s, RIGHT);
    expect(t.x).toBe(32);
    expect(t.moving).toBe(false);
  });

  it('does not move while stunT > 0', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 32, y: 80, dir: RIGHT, stunT: 1 });
    stepDir(s, RIGHT);
    expect(t.x).toBe(32);
    expect(t.moving).toBe(false);
  });

  it('does not move while frozenT > 0', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 32, y: 80, dir: RIGHT, frozenT: 1 });
    stepDir(s, RIGHT);
    expect(t.x).toBe(32);
    expect(t.moving).toBe(false);
  });
});

describe('movement — prev snapshot & hash', () => {
  it('refreshes prevX/prevY for all tanks before movement', () => {
    const s = createGame(emptyLevel(), OPTS);
    const mover = addPlayer(s, { x: 32, y: 80, dir: RIGHT });
    // An idle enemy tank: movementSystem snapshots it but never moves it.
    const idle = makeTank({
      id: 2,
      kind: 'enemy',
      enemyType: 'basic',
      x: 100,
      y: 100,
    });
    s.tanks.push(idle);

    stepDir(s, RIGHT);

    expect(mover.prevX).toBe(32); // previous position captured before the move
    near(mover.x, 32.75); // new position
    expect(idle.prevX).toBe(idle.x); // idle tank: prev tracks current
    expect(idle.prevY).toBe(idle.y);
  });

  it('movementSystem snapshots prev even when no player moves', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addPlayer(s, { x: 40, y: 40 });
    t.x = 41.5; // simulate a stale position
    movementSystem(s, [NULL_INTENT, NULL_INTENT]);
    expect(t.prevX).toBe(41.5);
  });

  it('P-23: slideV participates in the state hash', () => {
    const a = createGame(emptyLevel(), OPTS);
    const b = createGame(emptyLevel(), OPTS);
    a.tanks.push(
      makeTank({ id: 1, kind: 'player', playerIndex: 0, x: 32, y: 80 }),
    );
    b.tanks.push(
      makeTank({ id: 1, kind: 'player', playerIndex: 0, x: 32, y: 80 }),
    );
    expect(hashState(a)).toBe(hashState(b)); // identical to start

    b.tanks[0].slideV = 3;
    expect(hashState(a)).not.toBe(hashState(b));
  });
});

describe('movement — moveTank helper (reused by AI later)', () => {
  it('moves an enemy tank at its type speed', () => {
    const s = createGame(emptyLevel(), OPTS);
    const e = makeTank({
      id: 5,
      kind: 'enemy',
      enemyType: 'fast',
      x: 32,
      y: 80,
      dir: RIGHT,
    });
    s.tanks.push(e);
    e.prevX = e.x;
    e.prevY = e.y;
    moveTank(s, e, RIGHT, 1 / 60);
    near(e.x, 32 + 60 / 60); // fast = 60 u/s -> 1 u this tick
  });
});
