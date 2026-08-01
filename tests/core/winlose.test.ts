// tests/core/winlose.test.ts — the two rules winloseSystem states in prose and
// nothing pinned (T1.8 review gap, fidelity §11.2 + §11.4 + arch §3.2):
//
//   1. INSIDE the system, `stageCleared` is evaluated FIRST — the shot that kills
//      the twentieth enemy still clears the stage even on a frame that would
//      otherwise be the game over.
//   2. AROUND the system, playersSystem (#8) runs BEFORE winloseSystem (#9) —
//      winlose is last "on purpose: every kill, death and life change is already
//      settled, so this reads a finished frame". The golden replays cannot cover
//      this: they deliberately never reach a terminal phase, so swapping #8 and
//      #9 leaves all three of them green. The bonus-life case below is the one
//      that fails under that swap.
//
// Both terminal TRANSITIONS already run through the real pipeline in
// stageflow.test.ts; what is tested here is which one wins when they collide on a
// single tick, and what the frame winlose reads has to contain by then.
//
// Kills are staged through real bullets so the whole chain runs; targets carry a
// huge `frozenT` so aiSystem skips them entirely and draws no rng.
import { describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import { makeTank } from '../../src/core/systems/movement';
import {
  BONUS_LIFE_AT,
  PLAYER_RESPAWN_S,
  SCORE,
} from '../../src/core/constants';
import { NULL_INTENT } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
  Bullet,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  Tank,
} from '../../src/core/types';

const OPTS = { players: 1 as const, seed: 7, stageNumber: 1 };
const NO_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  NULL_INTENT,
  NULL_INTENT,
];

// A firing lane in open space, well clear of the eagle tile (6,12).
const TARGET_X = 64;
const TARGET_Y = 96;

function level(): LevelData {
  return {
    version: 1,
    id: 'wl',
    name: 'Win/Lose Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
    noAutoBase: true,
  };
}

// A game in 'playing' with the spawner parked, so each test owns the field.
function scene(): GameState {
  const s = createGame(level(), OPTS);
  s.phase = 'playing';
  s.phaseT = 0;
  s.spawner.timerT = 1e9;
  return s;
}

// P1 has spent its last life: no tank on the field, no reserves, no pending
// respawn — exactly the state `allPlayersOut` reads as "out".
function retireP1(s: GameState): void {
  s.tanks[0].alive = false;
  s.players[0].lives = 0;
  s.respawnT[0] = 0;
}

function target(s: GameState): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'enemy',
    enemyType: 'basic',
    x: TARGET_X,
    y: TARGET_Y,
    dir: 2,
    frozenT: 1e9,
  });
  s.tanks.push(t);
  return t;
}

// A player bullet already in flight, placed so its very first swept step overlaps
// the target: it outlives its owner (killBullet copes with a dead shooter), which
// is what lets a dead player land a kill on the tick the run would end.
function orphanBullet(s: GameState): Bullet {
  const b: Bullet = {
    id: s.bullets.length,
    alive: true,
    x: TARGET_X - 4,
    y: TARGET_Y + 6,
    prevX: TARGET_X - 4,
    prevY: TARGET_Y + 6,
    dir: 1,
    speed: 120,
    fromTankId: 0,
    byPlayer: true,
    playerIndex: 0,
    canHurtSteel: false,
  };
  s.bullets.push(b);
  return b;
}

function step(s: GameState): void {
  stepGame(s, NO_INTENTS);
}

function kinds(s: GameState): GameEvent['t'][] {
  return s.events.map((e) => e.t);
}

// --- 1 · cleared beats game over on the same tick ---------------------------

describe('win/lose — stage clear takes precedence (fidelity §11.2)', () => {
  it('the shot that kills the last enemy clears the stage on the very tick the run would end', () => {
    const s = scene();
    s.spawner.queue.length = 0; // the pool is spent; this is the twentieth enemy
    const enemy = target(s);
    retireP1(s);
    orphanBullet(s);

    step(s);

    expect(enemy.alive).toBe(false);
    expect(s.phase).toBe('cleared');
    expect(kinds(s)).toContain('stageCleared');
    expect(kinds(s)).not.toContain('gameOver');
    expect(s.phaseT).toBe(0);
  });

  it('with the pool NOT spent, the identical frame is a game over instead', () => {
    // The control: everything the same except that killing this enemy does not
    // empty the field, so `stageCleared` is false and the out-player branch is
    // the one that fires. Without it the test above would also pass if
    // winloseSystem simply never reported a game over.
    const s = scene(); // 20 enemies still queued
    const enemy = target(s);
    retireP1(s);
    orphanBullet(s);

    step(s);

    expect(enemy.alive).toBe(false);
    expect(s.phase).toBe('gameOver');
    expect(kinds(s)).toContain('gameOver');
    expect(kinds(s)).not.toContain('stageCleared');
  });
});

// --- 2 · players (#8) runs before winlose (#9) ------------------------------

describe('win/lose — reads a finished frame (arch §3.2)', () => {
  it('P-20: a bonus life earned by the killing shot saves the run on the same tick', () => {
    const s = scene();
    retireP1(s); // out: no tank, no lives, no pending respawn
    s.players[0].score = BONUS_LIFE_AT - SCORE.basic; // one kill short of 20,000
    const enemy = target(s);
    orphanBullet(s);

    step(s);

    // playersSystem prices the kill and grants the bonus life, THEN winloseSystem
    // reads the field. Swap those two systems and winlose sees a player with no
    // tank, no lives and no respawn pending, and ends the run one system too early.
    expect(enemy.alive).toBe(false);
    expect(s.players[0].score).toBe(BONUS_LIFE_AT);
    expect(kinds(s)).toContain('extraLife');
    expect(s.players[0].lives).toBe(1);
    expect(s.phase).toBe('playing');
    expect(kinds(s)).not.toContain('gameOver');
  });

  it('the last death still gets its full respawn second before the game ends', () => {
    const s = scene();
    const p = s.tanks[0];
    p.shieldT = 0;
    s.players[0].lives = 1; // the life being spent right now
    target(s); // keeps the stage from clearing underneath the test

    // An enemy bullet parked on the player's box: it lands this tick.
    s.bullets.push({
      id: 0,
      alive: true,
      x: p.x + 6,
      y: p.y - 4,
      prevX: p.x + 6,
      prevY: p.y - 4,
      dir: 2,
      speed: 120,
      fromTankId: 99,
      byPlayer: false,
      playerIndex: undefined,
      canHurtSteel: false,
    });

    step(s);

    expect(p.alive).toBe(false);
    expect(s.players[0].lives).toBe(0);
    expect(s.respawnT[0]).toBe(PLAYER_RESPAWN_S); // armed by playersSystem…
    expect(s.phase).toBe('playing'); // …and read by winlose as "not out yet"
    expect(kinds(s)).not.toContain('gameOver');

    // The countdown runs out, the respawn is refused at 0 lives, and only then
    // does the run end — one tick later than a naive "no lives left" check.
    let endedAt = -1;
    for (let i = 1; i <= 120 && endedAt < 0; i++) {
      step(s);
      if (kinds(s).includes('gameOver')) endedAt = i;
    }
    expect(endedAt).toBe(Math.round(PLAYER_RESPAWN_S * 60));
    expect(s.phase).toBe('gameOver');
  });
});
