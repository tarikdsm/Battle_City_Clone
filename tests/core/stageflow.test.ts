// tests/core/stageflow.test.ts — stage phases and pause (T1.7, fidelity §11 +
// §13). Parity coverage tagged in the test names: P-26 (pause freezes the whole
// simulation, timers included). The effect-timer half of stageflowSystem (shield/
// stun/clock/shovel, T1.5) is covered by powerups.test.ts and is only touched
// here through the pause freeze, which must stop it dead.
//
// Phase lengths are asserted in EXACT ticks, both sides of the boundary: the
// count-up comparison snaps on the same HALF_TICK threshold as `stepDown`, so a
// 2 s phase is 120 ticks and never 121 — and a golden replay recorded over this
// code would move if that ever changed.
import { describe, expect, it } from 'vitest';
import { createGame, hashState, stepGame } from '../../src/core/game';
import { makeTank } from '../../src/core/systems/movement';
import {
  GAME_OVER_DELAY_S,
  STAGE_CLEAR_S,
  STAGE_INTRO_S,
  TICK_S,
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
const NO_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  NULL_INTENT,
  NULL_INTENT,
];
const WALK: PlayerIntent = { dir: 1, fire: false, pause: false };
const FIRE: PlayerIntent = { dir: null, fire: true, pause: false };
const PAUSE: PlayerIntent = { dir: null, fire: false, pause: true };
const P1_WALK: readonly [PlayerIntent, PlayerIntent] = [WALK, NULL_INTENT];
const P1_FIRE: readonly [PlayerIntent, PlayerIntent] = [FIRE, NULL_INTENT];
const P1_PAUSE: readonly [PlayerIntent, PlayerIntent] = [PAUSE, NULL_INTENT];
// Unpause and keep driving on the same tick, so the resumed tick actually moves.
const P1_WALK_PAUSE: readonly [PlayerIntent, PlayerIntent] = [
  { dir: 1, fire: false, pause: true },
  NULL_INTENT,
];

const DOWN: Dir = 2;

const INTRO_TICKS = Math.round(STAGE_INTRO_S / TICK_S); // 120
const CLEAR_TICKS = Math.round(STAGE_CLEAR_S / TICK_S); // 120
const OVER_TICKS = Math.round(GAME_OVER_DELAY_S / TICK_S); // 180

// Open lane, clear of the eagle and of both spawn tiles.
const LANE_X = 32;
const LANE_Y = 96;

// --- Fixtures --------------------------------------------------------------

function level(): LevelData {
  return {
    version: 1,
    id: 'sf',
    name: 'Stage Flow Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
    noAutoBase: true,
  };
}

// Spawner parked far in the future: the queue stays full (so the stage never
// clears) and no enemy ever appears to muddy a phase-timing assertion.
function parked(): GameState {
  const s = createGame(level(), OPTS);
  s.spawner.timerT = 1e9;
  return s;
}

function playing(): GameState {
  const s = parked();
  s.phase = 'playing';
  s.phaseT = 0;
  return s;
}

function lane(s: GameState): Tank {
  const t = s.tanks[0];
  t.x = LANE_X;
  t.y = LANE_Y;
  t.prevX = LANE_X;
  t.prevY = LANE_Y;
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
    dir: DOWN,
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

// --- Drivers ---------------------------------------------------------------

function step(
  s: GameState,
  intents: readonly [PlayerIntent, PlayerIntent] = NO_INTENTS,
): void {
  stepGame(s, intents);
}

function stepN(
  s: GameState,
  n: number,
  intents: readonly [PlayerIntent, PlayerIntent] = NO_INTENTS,
): void {
  for (let i = 0; i < n; i++) step(s, intents);
}

function only<K extends GameEvent['t']>(
  s: GameState,
  t: K,
): Extract<GameEvent, { t: K }>[] {
  return s.events.filter((e): e is Extract<GameEvent, { t: K }> => e.t === t);
}

function collect<K extends GameEvent['t']>(
  s: GameState,
  t: K,
  ticks: number,
  intents: readonly [PlayerIntent, PlayerIntent] = NO_INTENTS,
): Extract<GameEvent, { t: K }>[] {
  const out: Extract<GameEvent, { t: K }>[] = [];
  for (let i = 0; i < ticks; i++) {
    step(s, intents);
    out.push(...only(s, t));
  }
  return out;
}

// Everything the renderer interpolates, per tank.
function poses(s: GameState): number[][] {
  return s.tanks.map((t) => [t.x, t.y, t.prevX, t.prevY]);
}

// --- 1 · intro -------------------------------------------------------------

describe('stage flow — intro', () => {
  it('intro lasts exactly STAGE_INTRO_S and locks the controls while it runs', () => {
    const s = parked();
    const p = lane(s);
    expect(s.phase).toBe('intro');
    expect(s.phaseT).toBe(0);

    stepN(s, INTRO_TICKS - 1, P1_WALK);
    expect(s.phase).toBe('intro'); // 119 ticks in: not yet
    expect(p.x).toBe(LANE_X);

    step(s, P1_WALK);
    expect(s.phase).toBe('playing'); // tick 120: the curtain opens
    expect(s.phaseT).toBe(0);
    // Gating is decided once, from the phase the tick BEGAN in, so the
    // transition tick is still locked; control resumes on the next one.
    expect(p.x).toBe(LANE_X);

    step(s, P1_WALK);
    expect(p.x).toBeGreaterThan(LANE_X);
  });

  it('firing is gated during the intro too', () => {
    const s = parked();
    lane(s);
    const shots = collect(s, 'shotFired', 30, P1_FIRE);
    expect(shots).toHaveLength(0);
    expect(s.bullets).toHaveLength(0);
  });

  it('the spawner keeps running during the intro (first spawn at tick 1)', () => {
    const s = createGame(level(), OPTS); // live spawner
    step(s);
    expect(s.phase).toBe('intro');
    expect(only(s, 'enemySpawnStarted')).toHaveLength(1);
    expect(s.tanks.filter((t) => t.kind === 'enemy' && t.alive)).toHaveLength(
      1,
    );
  });
});

// --- 2 · stage cleared -----------------------------------------------------

describe('stage flow — stage cleared', () => {
  it('an emptied queue with no enemies left clears the stage exactly once', () => {
    const s = createGame(level(), OPTS); // live spawner, 20 enemies
    let clearedAt = -1;
    for (let i = 0; i < 6000 && clearedAt < 0; i++) {
      // An uncollected power-up sits on the field right up to the clearing tick.
      s.powerup = { type: 'star', x: 0, y: 0 };
      step(s);
      if (s.phase === 'cleared') clearedAt = i;
      // Kill everything the spawner puts out, so all 20 ordinals get to start.
      for (const t of s.tanks)
        if (t.kind === 'enemy' && t.alive) t.alive = false;
    }

    expect(clearedAt).toBeGreaterThan(0);
    expect(s.spawner.queue).toHaveLength(0);
    expect(s.phaseT).toBe(0);
    expect(only(s, 'stageCleared')).toEqual([{ t: 'stageCleared' }]);
    expect(s.powerup).toBeNull(); // fidelity §8: nothing survives the stage end

    // 'cleared' is terminal for the core — the app layer loads the next stage.
    const again = collect(s, 'stageCleared', CLEAR_TICKS + 60);
    expect(again).toHaveLength(0);
    expect(s.phase).toBe('cleared');
    expect(s.phaseT).toBeGreaterThan(STAGE_CLEAR_S);
  });
});

// --- 3 · base lost → game over ---------------------------------------------

describe('stage flow — base lost & game over', () => {
  it('the eagle falling locks the controls and ends the game after GAME_OVER_DELAY_S', () => {
    const s = playing();
    const p = lane(s);
    // A player bullet dropped straight onto the eagle tile (6,12).
    addBullet(s, { x: 104, y: 176, dir: DOWN });

    for (let i = 0; i < 30 && s.eagleAlive; i++) step(s, P1_WALK);
    expect(s.eagleAlive).toBe(false);
    expect(s.phase).toBe('baseLost');
    expect(s.phaseT).toBe(0);
    const frozenX = p.x;

    const early = collect(s, 'gameOver', OVER_TICKS - 1, P1_WALK);
    expect(early).toHaveLength(0);
    expect(s.phase).toBe('baseLost');
    expect(p.x).toBe(frozenX); // controls dead from the tick after the eagle fell

    step(s, P1_WALK);
    expect(s.phase).toBe('gameOver');
    expect(s.phaseT).toBe(0);
    expect(only(s, 'gameOver')).toEqual([{ t: 'gameOver' }]);

    // Terminal: no second announcement, no control.
    expect(collect(s, 'gameOver', 300, P1_WALK)).toHaveLength(0);
    expect(s.phase).toBe('gameOver');
    expect(p.x).toBe(frozenX);
  });

  it('a stray uncollected power-up is cleared once the stage has ended', () => {
    const s = playing();
    addBullet(s, { x: 104, y: 176, dir: DOWN });
    for (let i = 0; i < 30 && s.eagleAlive; i++) step(s);
    expect(s.phase).toBe('baseLost');

    s.powerup = { type: 'shovel', x: 0, y: 0 };
    step(s);
    expect(s.powerup).toBeNull();
  });
});

// --- 4 · pause (P-26) ------------------------------------------------------

describe('stage flow — pause (P-26)', () => {
  it('P-26: a paused tick advances nothing at all', () => {
    const s = playing();
    const p = lane(s);
    p.shieldT = 2; // a live effect timer that must NOT tick down while paused
    stepN(s, 20, P1_WALK); // get everything moving

    const tickBefore = s.tick;
    const posesBefore = poses(s);
    step(s, P1_PAUSE); // the press edge
    expect(s.paused).toBe(true);
    expect(only(s, 'pauseToggled')).toEqual([
      { t: 'pauseToggled', paused: true },
    ]);
    // The pausing tick itself is already frozen: nothing advanced.
    expect(s.tick).toBe(tickBefore);
    expect(poses(s)).toEqual(posesBefore);

    // 60 frozen ticks with the button still held: byte-identical state, no events.
    const frozen = hashState(s);
    for (let i = 0; i < 60; i++) {
      step(s, P1_PAUSE);
      expect(hashState(s)).toBe(frozen);
      expect(s.events).toHaveLength(0);
    }
    expect(s.tick).toBe(tickBefore);
    expect(poses(s)).toEqual(posesBefore);

    // Releasing the button does not resume — only a new press edge does.
    step(s);
    expect(s.paused).toBe(true);
    expect(s.tick).toBe(tickBefore);

    step(s, P1_PAUSE);
    expect(s.paused).toBe(false);
    expect(only(s, 'pauseToggled')).toEqual([
      { t: 'pauseToggled', paused: false },
    ]);
    expect(s.tick).toBe(tickBefore + 1); // the unpausing tick runs in full
  });

  it('P-26: pause needs a press edge — holding it toggles exactly once', () => {
    const s = playing();
    lane(s);
    const tickBefore = s.tick;
    const toggles = collect(s, 'pauseToggled', 60, P1_PAUSE);
    expect(toggles).toEqual([{ t: 'pauseToggled', paused: true }]);
    expect(s.paused).toBe(true);
    expect(s.tick).toBe(tickBefore); // 60 held ticks, zero simulation
  });

  it('P-26: either player may pause, and P2 may unpause what P1 paused', () => {
    const s = createGame(level(), { players: 2, seed: 42, stageNumber: 1 });
    s.phase = 'playing';
    s.spawner.timerT = 1e9;

    step(s, [NULL_INTENT, PAUSE]);
    expect(s.paused).toBe(true);
    expect(s.pauseHeld).toEqual([false, true]);

    step(s, [NULL_INTENT, NULL_INTENT]);
    step(s, [PAUSE, NULL_INTENT]);
    expect(s.paused).toBe(false);
    expect(s.pauseHeld).toEqual([true, false]);
  });

  it('the tick after unpausing keeps prev at the position the tick began in', () => {
    const s = playing();
    const p = lane(s);
    const enemy = makeTank({
      id: s.tanks.length,
      kind: 'enemy',
      enemyType: 'basic',
      x: 32,
      y: 32,
      dir: DOWN,
    });
    s.tanks.push(enemy);

    stepN(s, 30, P1_WALK); // player driving, enemy under AI
    step(s, P1_PAUSE); // pause
    stepN(s, 20, P1_PAUSE); // stay frozen
    step(s, P1_WALK); // release the pause button (still frozen)

    const before = poses(s).map((q) => [q[0], q[1]]);
    step(s, P1_WALK_PAUSE); // press edge: unpauses AND runs the tick

    expect(s.paused).toBe(false);
    s.tanks.forEach((t, i) => {
      expect([t.prevX, t.prevY]).toEqual(before[i]);
    });
    // …and the tick really did move both of them, so the check is not vacuous.
    expect(p.x).toBeGreaterThan(before[0][0]);
    expect(enemy.x !== enemy.prevX || enemy.y !== enemy.prevY).toBe(true);
  });
});

// --- 5 · hash --------------------------------------------------------------

describe('stage flow — determinism (P-23)', () => {
  it('respawnT and pauseHeld both participate in the state hash', () => {
    for (const mutate of [
      (s: GameState): void => {
        s.respawnT[0] = 0.5;
      },
      (s: GameState): void => {
        s.respawnT[1] = 0.5;
      },
      (s: GameState): void => {
        s.pauseHeld[0] = true;
      },
      (s: GameState): void => {
        s.pauseHeld[1] = true;
      },
    ]) {
      const a = createGame(level(), OPTS);
      const b = createGame(level(), OPTS);
      expect(hashState(a)).toBe(hashState(b));
      mutate(b);
      expect(hashState(a)).not.toBe(hashState(b));
    }
  });
});
