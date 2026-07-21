import { describe, expect, it } from 'vitest';
import { createGame, hashState } from '../../src/core/game';
import { makeTank } from '../../src/core/systems/movement';
import {
  bulletsSystem,
  firingSystem,
  tryFire,
} from '../../src/core/systems/bullets';
import { subcellIndex } from '../../src/core/grid';
import { STUN_S } from '../../src/core/constants';
import { NULL_INTENT, Terrain } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
  Bullet,
  Dir,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  Tank,
  TerrainKind,
} from '../../src/core/types';

// Dir literals (types.ts: 0 Up, 1 Right, 2 Down, 3 Left).
const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const OPTS = { players: 1 as const, seed: 1, stageNumber: 1 };
const INTENTS: readonly [PlayerIntent, PlayerIntent] = [NULL_INTENT, NULL_INTENT];

// A wholly-empty field with NO auto base ring, so tests place exactly the
// terrain they need (the eagle entity still exists at tile (6,12)).
function emptyLevel(): LevelData {
  return {
    version: 1,
    id: 'bl',
    name: 'Bullets Test',
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

// A fresh game with a single terrain tile of `ch` at (tx,ty).
function gameWithTile(tx: number, ty: number, ch: string): GameState {
  const l = emptyLevel();
  setTileChar(l, tx, ty, ch);
  return createGame(l, OPTS);
}

function addTank(s: GameState, over: Partial<Tank> & Pick<Tank, 'id' | 'kind'>): Tank {
  const t = makeTank({ x: 100, y: 100, ...over });
  s.tanks.push(t);
  return t;
}

// Push a bullet directly into the pool (prev mirrors the start position, as a
// freshly-spawned bullet would). Defaults are a slow player bullet.
function addBullet(s: GameState, over: Partial<Bullet>): Bullet {
  const b: Bullet = {
    id: s.bullets.length,
    alive: true,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    dir: RIGHT,
    speed: 120,
    fromTankId: -1,
    byPlayer: true,
    playerIndex: undefined,
    canHurtSteel: false,
    ...over,
  };
  b.prevX = b.x;
  b.prevY = b.y;
  s.bullets.push(b);
  return b;
}

function fireIntent(): PlayerIntent {
  return { dir: null, fire: true, pause: false };
}

// Typed, narrowing event finder — throws (failing the test) when absent.
function findEvent<K extends GameEvent['t']>(
  s: GameState,
  t: K,
): Extract<GameEvent, { t: K }> {
  const ev = s.events.find(
    (e): e is Extract<GameEvent, { t: K }> => e.t === t,
  );
  if (ev === undefined) throw new Error(`no '${t}' event emitted`);
  return ev;
}

function hasEvent(s: GameState, t: GameEvent['t']): boolean {
  return s.events.some((e) => e.t === t);
}

// Bit mask (1=TL,2=TR,4=BL,8=BR) of subcells of tile (tx,ty) still equal to `kind`.
function tileMask(
  s: GameState,
  tx: number,
  ty: number,
  kind: TerrainKind,
): number {
  const sx = tx * 2;
  const sy = ty * 2;
  let m = 0;
  if (s.terrain[subcellIndex(sx, sy)] === kind) m |= 1;
  if (s.terrain[subcellIndex(sx + 1, sy)] === kind) m |= 2;
  if (s.terrain[subcellIndex(sx, sy + 1)] === kind) m |= 4;
  if (s.terrain[subcellIndex(sx + 1, sy + 1)] === kind) m |= 8;
  return m;
}

function countAlive(bullets: readonly Bullet[]): number {
  return bullets.filter((b) => b.alive).length;
}

// Run the bullet system until `b` dies (or a generous guard trips).
function flyUntilDead(s: GameState, b: Bullet): void {
  let guard = 0;
  while (b.alive && guard++ < 400) bulletsSystem(s, INTENTS);
}

// --- 1 · P-02: tier table (speed, spawn positions, canHurtSteel) -----------

describe('bullets — firing & tier table (P-02, P-22, P-24)', () => {
  it('P-02: tier-0 bullet speed 120 and the four muzzle spawn positions', () => {
    // Tank AABB 16x16 at (100,100); muzzle offset = (TANK_SIZE-BULLET_SIZE)/2 = 6.
    const cases: [Dir, number, number][] = [
      [UP, 106, 98],
      [DOWN, 106, 114],
      [RIGHT, 114, 106],
      [LEFT, 98, 106],
    ];
    for (const [dir, ex, ey] of cases) {
      const s = createGame(emptyLevel(), OPTS);
      const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, dir });
      expect(tryFire(s, t)).toBe(true);
      const b = s.bullets[0];
      expect(b.speed).toBe(120);
      expect(b.x).toBe(ex);
      expect(b.y).toBe(ey);
      expect(b.dir).toBe(dir);
      expect(b.byPlayer).toBe(true);
      expect(b.canHurtSteel).toBe(false);
      // shotFired carries the spawn top-left.
      const shot = findEvent(s, 'shotFired');
      expect(shot.x).toBe(ex);
      expect(shot.y).toBe(ey);
      expect(shot.tankId).toBe(1);
      expect(shot.byPlayer).toBe(true);
    }
  });

  it('P-02: tier>=1 fires fast (240); canHurtSteel only at tier 3', () => {
    for (const [tier, speed, steel] of [
      [0, 120, false],
      [1, 240, false],
      [2, 240, false],
      [3, 240, true],
    ] as const) {
      const s = createGame(emptyLevel(), OPTS);
      const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, dir: UP, tier });
      expect(tryFire(s, t)).toBe(true);
      expect(s.bullets[0].speed).toBe(speed);
      expect(s.bullets[0].canHurtSteel).toBe(steel);
    }
  });

  it('P-22: tier-0 cap — refused while airborne, allowed once freed', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 100, y: 6, dir: UP });
    expect(tryFire(s, t)).toBe(true);
    expect(t.bulletsAirborne).toBe(1);
    expect(tryFire(s, t)).toBe(false); // at cap
    flyUntilDead(s, s.bullets[0]); // bullet exits the top border
    expect(s.bullets[0].alive).toBe(false);
    expect(t.bulletsAirborne).toBe(0);
    expect(tryFire(s, t)).toBe(true); // freed
  });

  it('P-22: tier-2 allows two airborne, refuses the third', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, dir: UP, tier: 2 });
    expect(tryFire(s, t)).toBe(true);
    expect(tryFire(s, t)).toBe(true);
    expect(t.bulletsAirborne).toBe(2);
    expect(tryFire(s, t)).toBe(false);
  });

  it('P-24: enemy cap is one; basic fires slow, power fires fast', () => {
    const s = createGame(emptyLevel(), OPTS);
    const basic = addTank(s, { id: 5, kind: 'enemy', enemyType: 'basic', dir: DOWN });
    expect(tryFire(s, basic)).toBe(true);
    expect(s.bullets[0].speed).toBe(120);
    expect(s.bullets[0].byPlayer).toBe(false);
    expect(s.bullets[0].canHurtSteel).toBe(false);
    expect(tryFire(s, basic)).toBe(false); // cap 1

    const s2 = createGame(emptyLevel(), OPTS);
    const power = addTank(s2, { id: 5, kind: 'enemy', enemyType: 'power', dir: DOWN });
    expect(tryFire(s2, power)).toBe(true);
    expect(s2.bullets[0].speed).toBe(240);
  });

  it('tryFire is refused for disabled tanks and spawns nothing', () => {
    const s = createGame(emptyLevel(), OPTS);
    const base = { id: 1, kind: 'player' as const, playerIndex: 0 as const };
    expect(tryFire(s, makeTank({ ...base, x: 100, y: 100, alive: false }))).toBe(false);
    expect(tryFire(s, makeTank({ ...base, x: 100, y: 100, spawningT: 1 }))).toBe(false);
    expect(tryFire(s, makeTank({ ...base, x: 100, y: 100, stunT: 1 }))).toBe(false);
    expect(tryFire(s, makeTank({ ...base, x: 100, y: 100, frozenT: 1 }))).toBe(false);
    expect(s.bullets.length).toBe(0);
  });
});

// --- 3 · firingSystem press-edge semantics ---------------------------------

describe('bullets — firingSystem press edge', () => {
  it('holding fire yields exactly one shot; release+press yields a second', () => {
    // tier 2 (cap 2) isolates edge behaviour from the fire cap.
    const s = createGame(emptyLevel(), OPTS);
    const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, dir: UP, tier: 2 });
    for (let i = 0; i < 10; i++) firingSystem(s, [fireIntent(), NULL_INTENT]);
    expect(countAlive(s.bullets)).toBe(1); // edge, not per-tick
    expect(t.fireHeld).toBe(true);
    firingSystem(s, [NULL_INTENT, NULL_INTENT]); // release
    expect(t.fireHeld).toBe(false);
    firingSystem(s, [fireIntent(), NULL_INTENT]); // new press edge
    expect(countAlive(s.bullets)).toBe(2);
  });

  it('firingSystem updates fireHeld unconditionally even when the tank cannot fire', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, stunT: 1 });
    firingSystem(s, [fireIntent(), NULL_INTENT]);
    expect(t.fireHeld).toBe(true); // level tracking is unconditional
    expect(countAlive(s.bullets)).toBe(0); // stunned -> no shot
  });
});

// --- 5,6 · terrain damage (P-04, P-05) -------------------------------------

describe('bullets — brick & steel damage (P-04, P-05)', () => {
  it('P-04: non-tier-3 removes the near half; two hits clear the tile', () => {
    const s = gameWithTile(5, 5, 'B'); // tile x[80,96] y[80,96]
    const b = addBullet(s, { x: 76, y: 88, dir: RIGHT, byPlayer: true });
    flyUntilDead(s, b);
    const hit = findEvent(s, 'brickHit');
    expect(hit.removedMask).toBe(5); // west pair (TL|BL)
    expect(hit.tx).toBe(5);
    expect(hit.ty).toBe(5);
    expect(tileMask(s, 5, 5, Terrain.Brick)).toBe(10); // east column remains

    s.events.length = 0;
    const b2 = addBullet(s, { x: 76, y: 88, dir: RIGHT, byPlayer: true });
    flyUntilDead(s, b2);
    expect(findEvent(s, 'brickHit').removedMask).toBe(10); // far pair now
    expect(tileMask(s, 5, 5, Terrain.Brick)).toBe(0); // fully cleared
  });

  it('P-04: dir Up removes the south pair (mask 12) first', () => {
    const s = gameWithTile(5, 5, 'B');
    const b = addBullet(s, { x: 88, y: 100, dir: UP, byPlayer: true });
    flyUntilDead(s, b);
    expect(findEvent(s, 'brickHit').removedMask).toBe(12); // BL|BR
    expect(tileMask(s, 5, 5, Terrain.Brick)).toBe(3); // north row remains
  });

  it('P-05: a tier-3 bullet clears a full brick tile in one hit', () => {
    const s = gameWithTile(5, 5, 'B');
    const b = addBullet(s, { x: 76, y: 88, dir: RIGHT, byPlayer: true, canHurtSteel: true });
    flyUntilDead(s, b);
    expect(findEvent(s, 'brickHit').removedMask).toBe(15);
    expect(tileMask(s, 5, 5, Terrain.Brick)).toBe(0);
  });

  it('P-05: tier-3 destroys a steel half-tile; non-tier-3 leaves steel intact', () => {
    const s = gameWithTile(5, 5, 'S');
    const b = addBullet(s, { x: 76, y: 88, dir: RIGHT, byPlayer: true, canHurtSteel: true });
    flyUntilDead(s, b);
    const hit = findEvent(s, 'steelHit');
    expect(hit.destroyed).toBe(true);
    expect(hit.removedMask).toBe(5);
    expect(tileMask(s, 5, 5, Terrain.Steel)).toBe(10);
    expect(b.alive).toBe(false);

    const s2 = gameWithTile(5, 5, 'S');
    const b2 = addBullet(s2, { x: 76, y: 88, dir: RIGHT, byPlayer: true, canHurtSteel: false });
    flyUntilDead(s2, b2);
    const hit2 = findEvent(s2, 'steelHit');
    expect(hit2.destroyed).toBe(false);
    expect(hit2.removedMask).toBe(0);
    expect(tileMask(s2, 5, 5, Terrain.Steel)).toBe(15); // intact
    expect(b2.alive).toBe(false); // still consumed
  });
});

// --- 7,8 · bullet vs bullet (P-07, P-06) -----------------------------------

describe('bullets — bullet vs bullet (P-06, P-07)', () => {
  it('P-07: a player and an enemy bullet annihilate head-on', () => {
    const s = createGame(emptyLevel(), OPTS);
    const p = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 40, y: 100, dir: RIGHT });
    const e = addTank(s, { id: 5, kind: 'enemy', enemyType: 'basic', x: 120, y: 100, dir: LEFT });
    expect(tryFire(s, p)).toBe(true);
    expect(tryFire(s, e)).toBe(true);
    let guard = 0;
    while (s.bullets[0].alive && s.bullets[1].alive && guard++ < 200) {
      bulletsSystem(s, INTENTS);
    }
    expect(s.bullets[0].alive).toBe(false);
    expect(s.bullets[1].alive).toBe(false);
    expect(hasEvent(s, 'bulletsCanceled')).toBe(true);
    expect(p.bulletsAirborne).toBe(0);
    expect(e.bulletsAirborne).toBe(0);
  });

  it('P-06: an enemy bullet passes through an enemy tank (no damage)', () => {
    const s = createGame(emptyLevel(), OPTS);
    const target = addTank(s, { id: 6, kind: 'enemy', enemyType: 'basic', x: 100, y: 100 });
    const b = addBullet(s, { x: 96, y: 106, dir: RIGHT, byPlayer: false, fromTankId: 5 });
    bulletsSystem(s, INTENTS);
    expect(b.alive).toBe(true); // not consumed by the enemy tank
    expect(target.hp).toBe(1);
    expect(target.alive).toBe(true);
  });

  it('P-06: two enemy bullets cross without cancelling', () => {
    const s = createGame(emptyLevel(), OPTS);
    const b1 = addBullet(s, { x: 40, y: 106, dir: RIGHT, byPlayer: false, fromTankId: 5 });
    const b2 = addBullet(s, { x: 60, y: 106, dir: LEFT, byPlayer: false, fromTankId: 6 });
    for (let i = 0; i < 12; i++) bulletsSystem(s, INTENTS);
    expect(b1.alive).toBe(true);
    expect(b2.alive).toBe(true);
    expect(hasEvent(s, 'bulletsCanceled')).toBe(false);
  });
});

// --- 9,10,11 · bullet vs tank (P-08, P-19, shield) -------------------------

describe('bullets — bullet vs tank (P-08, P-19, shield)', () => {
  it('P-08: a player bullet stuns (not kills) the other player and cancels its slide', () => {
    const s = createGame(emptyLevel(), OPTS);
    const p0 = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 40, y: 100, dir: RIGHT });
    const p1 = addTank(s, {
      id: 2,
      kind: 'player',
      playerIndex: 1,
      x: 80,
      y: 100,
      sliding: true,
      slideV: 30,
    });
    void p0;
    const b = addBullet(s, {
      x: 76,
      y: 106,
      dir: RIGHT,
      byPlayer: true,
      playerIndex: 0,
      fromTankId: 1,
    });
    bulletsSystem(s, INTENTS);
    expect(b.alive).toBe(false);
    expect(p1.stunT).toBe(STUN_S);
    expect(p1.hp).toBe(1); // no damage
    expect(p1.sliding).toBe(false);
    expect(p1.slideV).toBe(0);
    const ev = findEvent(s, 'playerStunned');
    expect(ev.playerIndex).toBe(1);
    expect(ev.durS).toBe(STUN_S);
    expect(tryFire(s, p1)).toBe(false); // stunned cannot fire
  });

  it('P-19: an armor enemy takes four hits (three tankHit, then tankDestroyed 400)', () => {
    const s = createGame(emptyLevel(), OPTS);
    const armor = addTank(s, { id: 6, kind: 'enemy', enemyType: 'armor', hp: 4, x: 100, y: 100 });
    const hpLeft: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = addBullet(s, {
        x: 96,
        y: 106,
        dir: RIGHT,
        byPlayer: true,
        playerIndex: 0,
        fromTankId: 1,
      });
      s.events.length = 0;
      bulletsSystem(s, INTENTS);
      hpLeft.push(findEvent(s, 'tankHit').hpLeft);
      expect(b.alive).toBe(false);
    }
    expect(hpLeft).toEqual([3, 2, 1]);
    expect(armor.alive).toBe(true);

    const b = addBullet(s, {
      x: 96,
      y: 106,
      dir: RIGHT,
      byPlayer: true,
      playerIndex: 0,
      fromTankId: 1,
    });
    s.events.length = 0;
    bulletsSystem(s, INTENTS);
    expect(b.alive).toBe(false);
    const dead = findEvent(s, 'tankDestroyed');
    expect(dead.points).toBe(400);
    expect(dead.byPlayerIndex).toBe(0);
    expect(dead.enemyType).toBe('armor');
    expect(dead.kind).toBe('enemy');
    expect(armor.alive).toBe(false);
  });

  it('a shield consumes an enemy bullet with no damage', () => {
    const s = createGame(emptyLevel(), OPTS);
    const p = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 100, y: 100, shieldT: 1 });
    const b = addBullet(s, { x: 96, y: 106, dir: RIGHT, byPlayer: false, fromTankId: 5 });
    bulletsSystem(s, INTENTS);
    expect(p.alive).toBe(true);
    expect(p.hp).toBe(1);
    expect(b.alive).toBe(false);
    expect(findEvent(s, 'bulletDespawned').reason).toBe('hit');
  });

  it('an enemy bullet destroys an unshielded player (points 0, no byPlayerIndex)', () => {
    const s = createGame(emptyLevel(), OPTS);
    const p = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 100, y: 100 });
    const b = addBullet(s, { x: 96, y: 106, dir: RIGHT, byPlayer: false, fromTankId: 5 });
    bulletsSystem(s, INTENTS);
    expect(p.alive).toBe(false);
    expect(b.alive).toBe(false);
    const dead = findEvent(s, 'tankDestroyed');
    expect(dead.kind).toBe('player');
    expect(dead.points).toBe(0);
    expect(dead.byPlayerIndex).toBeUndefined();
  });

  it('a spawning enemy has no hitbox — a player bullet passes through', () => {
    const s = createGame(emptyLevel(), OPTS);
    const e = addTank(s, {
      id: 6,
      kind: 'enemy',
      enemyType: 'basic',
      x: 100,
      y: 100,
      spawningT: 1,
    });
    const b = addBullet(s, {
      x: 96,
      y: 106,
      dir: RIGHT,
      byPlayer: true,
      playerIndex: 0,
      fromTankId: 1,
    });
    bulletsSystem(s, INTENTS);
    expect(e.hp).toBe(1);
    expect(e.alive).toBe(true);
    expect(b.alive).toBe(true); // passed through
  });
});

// --- 12 · eagle (P-10) -----------------------------------------------------

describe('bullets — eagle & base (P-10)', () => {
  it('P-10: a player bullet destroys the base -> baseLost', () => {
    const s = createGame(emptyLevel(), OPTS); // eagle at tile (6,12) -> x[96,112] y[192,208]
    s.phaseT = 5;
    const b = addBullet(s, {
      x: 100,
      y: 188,
      dir: DOWN,
      byPlayer: true,
      playerIndex: 0,
      fromTankId: 1,
    });
    flyUntilDead(s, b);
    expect(s.eagleAlive).toBe(false);
    expect(s.phase).toBe('baseLost');
    expect(s.phaseT).toBe(0);
    expect(hasEvent(s, 'baseDestroyed')).toBe(true);
    expect(b.alive).toBe(false);
  });

  it('P-10: an enemy bullet destroys the base too', () => {
    const s = createGame(emptyLevel(), OPTS);
    const b = addBullet(s, { x: 100, y: 188, dir: DOWN, byPlayer: false, fromTankId: 5 });
    flyUntilDead(s, b);
    expect(s.eagleAlive).toBe(false);
    expect(hasEvent(s, 'baseDestroyed')).toBe(true);
  });
});

// --- 13,14,15,16 · border, pool, water -------------------------------------

describe('bullets — border, pool reuse, pass-through terrain', () => {
  it('a bullet leaving the field border despawns with reason border', () => {
    const s = createGame(emptyLevel(), OPTS);
    const b = addBullet(s, { x: 100, y: 4, dir: UP, byPlayer: false, fromTankId: 5 });
    flyUntilDead(s, b);
    expect(b.alive).toBe(false);
    expect(findEvent(s, 'bulletDespawned').reason).toBe('border');
    expect(b.y).toBe(0); // clamped to the crossing point
  });

  it('the bullet pool reuses dead slots (length stays 1, id 0)', () => {
    const s = createGame(emptyLevel(), OPTS);
    const t = addTank(s, { id: 1, kind: 'player', playerIndex: 0, x: 100, y: 6, dir: UP });
    expect(tryFire(s, t)).toBe(true);
    expect(s.bullets.length).toBe(1);
    expect(s.bullets[0].id).toBe(0);
    flyUntilDead(s, s.bullets[0]);
    expect(s.bullets[0].alive).toBe(false);
    expect(t.bulletsAirborne).toBe(0);
    expect(tryFire(s, t)).toBe(true);
    expect(s.bullets.length).toBe(1); // reused, not grown
    expect(s.bullets[0].id).toBe(0);
    expect(s.bullets[0].alive).toBe(true);
  });

  it('P-09: a bullet crosses a water tile unharmed', () => {
    const s = gameWithTile(5, 5, 'W'); // water x[80,96] y[80,96]
    const b = addBullet(s, { x: 74, y: 88, dir: RIGHT, byPlayer: false, fromTankId: 5 });
    for (let i = 0; i < 12; i++) bulletsSystem(s, INTENTS);
    expect(b.alive).toBe(true);
    expect(b.x).toBeGreaterThan(96); // sailed past the water tile
    expect(s.events.length).toBe(0); // water is inert
  });
});

// --- 17 · hash -------------------------------------------------------------

describe('bullets — determinism (P-23)', () => {
  it('P-23: fireHeld participates in the state hash', () => {
    const a = createGame(emptyLevel(), OPTS);
    const b = createGame(emptyLevel(), OPTS);
    a.tanks.push(makeTank({ id: 1, kind: 'player', playerIndex: 0, x: 32, y: 80 }));
    b.tanks.push(makeTank({ id: 1, kind: 'player', playerIndex: 0, x: 32, y: 80 }));
    expect(hashState(a)).toBe(hashState(b));
    b.tanks[0].fireHeld = true;
    expect(hashState(a)).not.toBe(hashState(b));
  });
});
