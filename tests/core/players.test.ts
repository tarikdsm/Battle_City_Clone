// tests/core/players.test.ts — lives, deaths/respawn, scoring and the two-player
// rules (T1.7, fidelity §3.1 + §10 + §12 + §13). Parity coverage tagged in the
// test names: P-03 (death resets tier and re-arms the spawn shield), P-19
// (100/200/300/400/500 to the player whose bullet landed), P-20 (one bonus life
// per player at 20,000), P-21 (separate scores/lives; an out player stays out and
// the game continues while the other still has lives).
//
// Kills are staged through REAL bullets so the whole chain is under test —
// bulletsSystem emits `tankDestroyed`, playersSystem turns it into points. Enemy
// targets are parked with a huge `frozenT` so the AI never moves or shoots them
// (aiSystem skips frozen tanks entirely, drawing no rng), which keeps every
// assertion about the scoring, not about where a wandering tank drifted to.
import { describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import { tryFire } from '../../src/core/systems/bullets';
import { makeTank } from '../../src/core/systems/movement';
import {
  ARMOR_HP,
  P1_SPAWN_TILE,
  PLAYER_RESPAWN_S,
  SCORE,
  SPAWN_SHIELD_S,
  START_LIVES,
  TICK_S,
  TILE,
} from '../../src/core/constants';
import { NULL_INTENT } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
  Bullet,
  Dir,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  Tank,
} from '../../src/core/types';

const OPTS = { players: 1 as const, seed: 42, stageNumber: 1 };
const OPTS_2P = { players: 2 as const, seed: 42, stageNumber: 1 };
const NO_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  NULL_INTENT,
  NULL_INTENT,
];

const UP: Dir = 0;
const RIGHT: Dir = 1;

const RESPAWN_TICKS = Math.round(PLAYER_RESPAWN_S / TICK_S); // 60
const ENEMY_TYPES: readonly EnemyType[] = ['basic', 'fast', 'power', 'armor'];

// A shooting lane in open space, well clear of the eagle and both spawn tiles.
const SHOOTER_X = 32;
const SHOOTER_Y = 96;
const TARGET_X = 64;

// --- Fixtures --------------------------------------------------------------

function level(): LevelData {
  return {
    version: 1,
    id: 'pl',
    name: 'Players Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
    noAutoBase: true,
  };
}

// A game already in 'playing' with the spawner parked far in the future: each
// test stages exactly the tanks it needs, and the untouched 20-enemy queue keeps
// winloseSystem from clearing the stage underneath it.
function scene(
  opts = OPTS as { players: 1 | 2; seed: number; stageNumber: number },
): GameState {
  const s = createGame(level(), opts);
  s.phase = 'playing';
  s.phaseT = 0;
  s.spawner.timerT = 1e9;
  return s;
}

// Move an existing player tank (createGame owns slots 0 and 1) into position and
// drop its spawn shield, so an enemy bullet can actually reach it.
function place(
  s: GameState,
  playerIndex: 0 | 1,
  x: number,
  y: number,
  dir: Dir = RIGHT,
): Tank {
  const t = s.tanks[playerIndex];
  t.x = x;
  t.y = y;
  t.prevX = x;
  t.prevY = y;
  t.dir = dir;
  t.shieldT = 0;
  return t;
}

// A stationary target: `frozenT` keeps aiSystem out of it completely.
function target(
  s: GameState,
  x: number,
  y: number,
  type: EnemyType = 'basic',
): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'enemy',
    enemyType: type,
    hp: type === 'armor' ? ARMOR_HP : 1,
    x,
    y,
    dir: 2,
    frozenT: 1e9,
  });
  s.tanks.push(t);
  return t;
}

function addBullet(s: GameState, over: Partial<Bullet>): Bullet {
  const b: Bullet = {
    id: s.bullets.length,
    alive: true,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    dir: UP,
    speed: 120,
    fromTankId: -1,
    byPlayer: false,
    playerIndex: undefined,
    canHurtSteel: false,
    ...over,
  };
  b.prevX = b.x;
  b.prevY = b.y;
  s.bullets.push(b);
  return b;
}

// --- Drivers ---------------------------------------------------------------

function step(s: GameState): void {
  stepGame(s, NO_INTENTS);
}

function stepN(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) step(s);
}

// Fire one shot and run the tick loop until it is resolved (hit or despawned).
function shoot(s: GameState, shooter: Tank): void {
  expect(tryFire(s, shooter)).toBe(true);
  for (let i = 0; i < 60 && shooter.bulletsAirborne > 0; i++) step(s);
  expect(shooter.bulletsAirborne).toBe(0);
}

// Fire until `enemy` is dead (armor needs ARMOR_HP hits).
function kill(s: GameState, shooter: Tank, enemy: Tank): void {
  for (let i = 0; i < ARMOR_HP && enemy.alive; i++) shoot(s, shooter);
  expect(enemy.alive).toBe(false);
}

function only<K extends GameEvent['t']>(
  s: GameState,
  t: K,
): Extract<GameEvent, { t: K }>[] {
  return s.events.filter((e): e is Extract<GameEvent, { t: K }> => e.t === t);
}

// Collect events of one kind across a run of ticks (state.events is per-tick).
function collect<K extends GameEvent['t']>(
  s: GameState,
  t: K,
  ticks: number,
): Extract<GameEvent, { t: K }>[] {
  const out: Extract<GameEvent, { t: K }>[] = [];
  for (let i = 0; i < ticks; i++) {
    step(s);
    out.push(...only(s, t));
  }
  return out;
}

// --- 1 · createGame lays out the player slots ------------------------------

describe('players — slot layout', () => {
  it('slots 0 and 1 hold P1 and P2 at their spawn tiles, shielded', () => {
    const s = createGame(level(), OPTS_2P);
    expect(s.tanks).toHaveLength(2);
    for (const i of [0, 1] as const) {
      const t = s.tanks[i];
      expect(t.id).toBe(i);
      expect(t.kind).toBe('player');
      expect(t.playerIndex).toBe(i);
      expect(t.alive).toBe(true);
      expect(t.dir).toBe(UP);
      expect(t.tier).toBe(0);
      expect(t.shieldT).toBe(SPAWN_SHIELD_S);
    }
    expect(s.tanks[0].x).toBe(P1_SPAWN_TILE[0] * TILE);
    expect(s.tanks[0].y).toBe(P1_SPAWN_TILE[1] * TILE);
    expect(s.respawnT).toEqual([0, 0]);
    expect(s.pauseHeld).toEqual([false, false]);
    expect(s.events).toHaveLength(0); // events are per-tick, never per-construction
  });

  it('1P leaves the P2 slot present but dead and inactive', () => {
    const s = createGame(level(), OPTS);
    expect(s.tanks).toHaveLength(2);
    expect(s.tanks[1].alive).toBe(false);
    expect(s.players[1].active).toBe(false);
    expect(s.players[1].lives).toBe(0);
    expect(s.players[0].lives).toBe(START_LIVES);
  });
});

// --- 2 · death, lives and respawn (P-03) -----------------------------------

describe('players — death & respawn (P-03)', () => {
  it('P-03: a killed player loses a life and respawns at tier 0 with a fresh shield', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);
    p.tier = 3; // proves the reset: tier is gone after the respawn
    addBullet(s, { x: SHOOTER_X + 6, y: SHOOTER_Y + 40, dir: UP });

    let deathTick = -1;
    for (let i = 0; i < 60 && deathTick < 0; i++) {
      step(s);
      if (!p.alive) deathTick = s.tick;
    }
    expect(deathTick).toBeGreaterThan(0);
    expect(s.players[0].lives).toBe(START_LIVES - 1);
    expect(s.respawnT[0]).toBe(PLAYER_RESPAWN_S);
    expect(only(s, 'tankDestroyed')[0]).toMatchObject({ kind: 'player' });

    // Exactly RESPAWN_TICKS later — not one tick sooner.
    stepN(s, RESPAWN_TICKS - 1);
    expect(p.alive).toBe(false);
    expect(only(s, 'playerSpawned')).toHaveLength(0);

    step(s);
    expect(s.tick).toBe(deathTick + RESPAWN_TICKS);
    expect(p.alive).toBe(true);
    expect(p.x).toBe(P1_SPAWN_TILE[0] * TILE);
    expect(p.y).toBe(P1_SPAWN_TILE[1] * TILE);
    expect(p.prevX).toBe(p.x); // re-anchored: the renderer must not lerp across the field
    expect(p.prevY).toBe(p.y);
    expect(p.dir).toBe(UP);
    expect(p.tier).toBe(0);
    expect(p.hp).toBe(1);
    expect(p.shieldT).toBe(SPAWN_SHIELD_S); // a full shield, undocked by this tick
    expect(p.bulletsAirborne).toBe(0);
    expect(s.respawnT[0]).toBe(0);
    expect(only(s, 'playerSpawned')).toEqual([
      { t: 'playerSpawned', playerIndex: 0, x: p.x, y: p.y },
    ]);
  });

  it('P-03: a player with no lives left never respawns', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);
    p.alive = false;
    s.players[0].lives = 0;
    s.respawnT[0] = PLAYER_RESPAWN_S;

    const spawns = collect(s, 'playerSpawned', RESPAWN_TICKS + 30);
    expect(spawns).toHaveLength(0);
    expect(p.alive).toBe(false);
    expect(s.respawnT[0]).toBe(0); // the timer still ran down
  });
});

// --- 3 · scoring (P-19) ----------------------------------------------------

describe('players — scoring (P-19)', () => {
  it('P-19: each enemy type pays its table price to the player who killed it', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);

    let expected = 0;
    for (const type of ENEMY_TYPES) {
      const e = target(s, TARGET_X, SHOOTER_Y, type);
      kill(s, p, e);
      expected += SCORE[type];
      expect(s.players[0].score).toBe(expected);
      expect(only(s, 'scoreAwarded')).toEqual([
        {
          t: 'scoreAwarded',
          playerIndex: 0,
          points: SCORE[type],
          x: expect.any(Number),
          y: expect.any(Number),
        },
      ]);
    }

    expect(s.players[0].score).toBe(100 + 200 + 300 + 400);
    expect(s.players[0].destroyedByType).toEqual({
      basic: 1,
      fast: 1,
      power: 1,
      armor: 1,
    });
    expect(s.players[1].score).toBe(0);
  });

  it('P-19/P-21: in 2P the kill pays the shooter only', () => {
    const s = scene(OPTS_2P);
    const p2 = place(s, 1, SHOOTER_X, SHOOTER_Y);
    const e = target(s, TARGET_X, SHOOTER_Y, 'fast');
    kill(s, p2, e);

    expect(s.players[1].score).toBe(SCORE.fast);
    expect(s.players[1].destroyedByType.fast).toBe(1);
    expect(s.players[0].score).toBe(0);
    expect(s.players[0].destroyedByType).toEqual({
      basic: 0,
      fast: 0,
      power: 0,
      armor: 0,
    });
  });

  it('P-19: a collected power-up pays 500 at the pickup position', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);
    s.powerup = { type: 'helmet', x: p.x, y: p.y }; // helmet: no side effect but the shield

    step(s);
    expect(s.powerup).toBeNull();
    expect(s.players[0].score).toBe(SCORE.powerup);
    expect(only(s, 'scoreAwarded')).toEqual([
      { t: 'scoreAwarded', playerIndex: 0, points: 500, x: p.x, y: p.y },
    ]);
  });

  it('P-18/P-19: grenade kills pay nothing and are left out of the tally', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);
    target(s, TARGET_X, SHOOTER_Y, 'armor');
    target(s, TARGET_X, SHOOTER_Y + 32, 'power');
    s.powerup = { type: 'grenade', x: p.x, y: p.y };

    step(s);
    expect(only(s, 'grenadeUsed')).toEqual([{ t: 'grenadeUsed', kills: 2 }]);
    // The pickup itself scores; the two kills it caused do not.
    expect(s.players[0].score).toBe(SCORE.powerup);
    expect(only(s, 'scoreAwarded')).toHaveLength(1);
    expect(s.players[0].destroyedByType).toEqual({
      basic: 0,
      fast: 0,
      power: 0,
      armor: 0,
    });
  });
});

// --- 4 · bonus life (P-20) -------------------------------------------------

describe('players — bonus life (P-20)', () => {
  it('P-20: crossing 20,000 grants exactly one extra life, ever', () => {
    const s = scene();
    const p = place(s, 0, SHOOTER_X, SHOOTER_Y);
    s.players[0].score = 19900;

    kill(s, p, target(s, TARGET_X, SHOOTER_Y, 'power')); // +300 → 20,200
    expect(s.players[0].score).toBe(20200);
    expect(s.players[0].lives).toBe(START_LIVES + 1);
    expect(only(s, 'extraLife')).toEqual([{ t: 'extraLife', playerIndex: 0 }]);
    expect(s.players[0].nextBonusAt).toBe(Number.POSITIVE_INFINITY);

    // Nothing later ever pays a second one.
    kill(s, p, target(s, TARGET_X, SHOOTER_Y, 'armor'));
    expect(s.players[0].score).toBe(20600);
    expect(s.players[0].lives).toBe(START_LIVES + 1);
    expect(only(s, 'extraLife')).toHaveLength(0);
  });
});

// --- 5 · two-player independence (P-21) ------------------------------------

describe('players — 2P independence (P-21)', () => {
  it('P-21: an out player stays out while the other keeps playing; both out ends the game', () => {
    const s = scene(OPTS_2P);
    const p1 = place(s, 0, SHOOTER_X, SHOOTER_Y + 48);
    const p2 = place(s, 1, SHOOTER_X, SHOOTER_Y);

    // P1 is out: no lives, no tank, no pending respawn.
    p1.alive = false;
    s.players[0].lives = 0;
    s.respawnT[0] = 0;
    s.players[1].lives = 1; // P2 is on its last life

    const overEarly = collect(s, 'gameOver', 120);
    expect(overEarly).toHaveLength(0);
    expect(s.phase).toBe('playing');
    expect(p1.alive).toBe(false);

    // P2 can still score while P1 sits out.
    kill(s, p2, target(s, TARGET_X, SHOOTER_Y, 'basic'));
    expect(s.players[1].score).toBe(SCORE.basic);
    expect(s.players[0].score).toBe(0);

    // Now P2 dies with nothing in reserve.
    addBullet(s, { x: p2.x + 6, y: p2.y + 40, dir: UP });
    for (let i = 0; i < 60 && p2.alive; i++) step(s);
    expect(p2.alive).toBe(false);
    expect(s.players[1].lives).toBe(0);

    const over = collect(s, 'gameOver', RESPAWN_TICKS + 5);
    expect(over).toEqual([{ t: 'gameOver' }]); // exactly once
    expect(s.phase).toBe('gameOver');
    expect(s.eagleAlive).toBe(true); // no base explosion on the all-lives-lost path
  });

  it('P-21: the inactive P2 slot of a 1P game never respawns and never scores', () => {
    const s = scene();
    const p1 = place(s, 0, SHOOTER_X, SHOOTER_Y);
    const p2 = s.tanks[1];

    const events = collect(s, 'playerSpawned', RESPAWN_TICKS * 3);
    expect(events).toHaveLength(0);
    expect(p2.alive).toBe(false);
    expect(s.respawnT[1]).toBe(0);

    kill(s, p1, target(s, TARGET_X, SHOOTER_Y, 'basic'));
    expect(s.players[0].score).toBe(SCORE.basic);
    expect(s.players[1].score).toBe(0);
    expect(s.players[1].lives).toBe(0);
    // nextBonusAt is 0 for an inactive slot — the bonus-life rule must not read
    // that as "already past 20,000" and hand out a free life.
    expect(s.players[1].nextBonusAt).toBe(0);
    expect(collect(s, 'extraLife', 30)).toHaveLength(0);
    expect(s.phase).toBe('playing'); // an inactive slot is not an "out" player
  });
});
