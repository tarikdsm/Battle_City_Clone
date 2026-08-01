// tests/core/spawner.test.ts — enemy spawner (T1.4, fidelity §7 + §3.2).
// Parity coverage tagged in the test names: P-11 (cap + HUD icon decrement),
// P-12 (first spawn at t=0 / blocked-point retry), P-25 (interval formula), and
// the carrier flagging half of P-13. Everything is driven through `stepGame`
// (movement/firing/bullets are live but inert without intents).
import { describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import { makeTank } from '../../src/core/systems/movement';
import {
  ARMOR_HP,
  CARRIER_ORDINALS,
  ENEMY_CAP,
  SPAWN_ANIM_S,
  SPAWN_RETRY_S,
  TICK_S,
} from '../../src/core/constants';
import { NULL_INTENT } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
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

type SpawnStarted = Extract<GameEvent, { t: 'enemySpawnStarted' }>;

// A wholly-empty field with NO auto base ring, so nothing but the spawn cadence
// is under test. `enemies` becomes spawner.queue (createGame copies it).
function levelWith(enemies: EnemyType[]): LevelData {
  return {
    version: 1,
    id: 'sp',
    name: 'Spawner Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies,
    noAutoBase: true,
  };
}

function basicLevel(): LevelData {
  return levelWith(Array.from({ length: 20 }, (): EnemyType => 'basic'));
}

function step(s: GameState): void {
  stepGame(s, NO_INTENTS);
}

function stepN(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) step(s);
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

function aliveEnemies(s: GameState): Tank[] {
  return s.tanks.filter((t) => t.alive && t.kind === 'enemy');
}

function spawnStarts(s: GameState): SpawnStarted[] {
  return s.events.filter((e): e is SpawnStarted => e.t === 'enemySpawnStarted');
}

// Interval, in whole ticks, between one spawn start and the next attempt.
const INTERVAL_1P = 186; // spawnIntervalTicks(1, 1)
const ANIM_TICKS = Math.round(SPAWN_ANIM_S / TICK_S); // 78
const RETRY_TICKS = Math.round(SPAWN_RETRY_S / TICK_S); // 30

describe('spawner — first spawn & cadence (P-12, P-25)', () => {
  it('P-12: first spawn starts at t=0 at the LEFT point', () => {
    const s = createGame(basicLevel(), OPTS);
    step(s); // tick 1

    const enemies = aliveEnemies(s);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(0);
    expect(enemies[0].y).toBe(0);
    expect(enemies[0].dir).toBe(2); // Down — enemies face the base
    // Started this tick, then decremented once by the materialization pass.
    near(enemies[0].spawningT, SPAWN_ANIM_S - TICK_S);

    const starts = spawnStarts(s);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      spawnOrdinal: 1,
      carrier: false,
      x: 0,
      y: 0,
      enemyType: 'basic',
    });
    expect(s.spawner.queue).toHaveLength(19);
  });

  it('cadence: spawns start every 186 ticks cycling L → C → R', () => {
    const s = createGame(basicLevel(), OPTS);

    stepN(s, 1 + INTERVAL_1P); // through tick 187 → second spawn
    expect(aliveEnemies(s)).toHaveLength(2);
    expect(aliveEnemies(s).some((t) => t.x === 96 && t.y === 0)).toBe(true); // C

    stepN(s, INTERVAL_1P); // through tick 373 → third spawn
    expect(aliveEnemies(s)).toHaveLength(3);
    expect(aliveEnemies(s).some((t) => t.x === 192 && t.y === 0)).toBe(true); // R
  });

  it('P-25: stage number caps at 35 in the interval (stage 99 → 50 ticks)', () => {
    const s = createGame(basicLevel(), {
      players: 1,
      seed: 42,
      stageNumber: 99,
    });
    stepN(s, 50); // spawnIntervalTicks(99,1) === 50 → second spawn is at tick 51
    expect(aliveEnemies(s)).toHaveLength(1);
    step(s); // tick 51
    expect(aliveEnemies(s)).toHaveLength(2);
  });

  it('P-25: two active players widen the interval to 166 ticks', () => {
    const s = createGame(basicLevel(), {
      players: 2,
      seed: 42,
      stageNumber: 1,
    });
    stepN(s, 166); // second spawn at tick 167
    expect(aliveEnemies(s)).toHaveLength(1);
    step(s); // tick 167
    expect(aliveEnemies(s)).toHaveLength(2);
  });
});

describe('spawner — active cap & HUD semantics (P-11)', () => {
  // Vacate spawn tiles as enemies materialize (mimics the AI driving them off),
  // so the four distinct-cycle spawns succeed and the CAP — not a blocked point —
  // is the only limiter under test.
  function vacate(s: GameState): void {
    for (const t of aliveEnemies(s))
      if (t.spawningT === 0 && t.y === 0) t.y = 96;
  }

  it('P-11: never more than ENEMY_CAP enemies active; a kill frees a slot', () => {
    const s = createGame(basicLevel(), OPTS);
    for (let i = 0; i < 800; i++) {
      step(s);
      vacate(s);
      expect(aliveEnemies(s).length).toBeLessThanOrEqual(ENEMY_CAP);
    }
    expect(aliveEnemies(s)).toHaveLength(ENEMY_CAP); // 4
    expect(s.spawner.queue).toHaveLength(20 - ENEMY_CAP); // only 4 consumed

    // Free one slot → the overdue attempt spawns a fifth on the very next tick.
    aliveEnemies(s)[0].alive = false;
    step(s);
    expect(aliveEnemies(s)).toHaveLength(ENEMY_CAP);
    expect(s.spawner.queue).toHaveLength(15);
  });

  it('P-11: exactly one enemySpawnStarted event per spawn (HUD icon decrement)', () => {
    const s = createGame(basicLevel(), OPTS);
    let starts = 0;
    for (let i = 0; i < 400; i++) {
      step(s);
      starts += spawnStarts(s).length;
    }
    // Spawns begin at ticks 1, 187, 373 within the first 400 ticks.
    expect(starts).toBe(3);
    expect(s.spawner.queue).toHaveLength(20 - starts); // one consume per start
  });
});

describe('spawner — blocked point retry (P-12)', () => {
  it('P-12: a blocked point retries after 0.5 s without advancing the cycle', () => {
    const s = createGame(basicLevel(), OPTS);
    // Park a player exactly on the LEFT spawn point before tick 1.
    s.tanks.push(
      makeTank({ id: 0, kind: 'player', playerIndex: 0, x: 0, y: 0 }),
    );

    step(s); // tick 1: attempt at LEFT is blocked
    expect(aliveEnemies(s)).toHaveLength(0);
    near(s.spawner.retryT, SPAWN_RETRY_S);
    expect(s.spawner.cyclePos).toBe(0); // cycle did NOT advance
    expect(s.spawner.queue).toHaveLength(20); // queue NOT consumed

    // Move the player away; the retry (same cycle position) fires within 0.5 s.
    s.tanks[0].x = 96;
    s.tanks[0].y = 96;
    stepN(s, RETRY_TICKS + 1); // 31 ticks → re-attempt lands

    const enemies = aliveEnemies(s);
    expect(enemies).toHaveLength(1);
    expect(enemies[0].x).toBe(0); // spawned at LEFT — the cycle held
    expect(enemies[0].y).toBe(0);
    expect(s.spawner.cyclePos).toBe(1); // advanced only after the clear spawn
  });
});

describe('spawner — carriers & stats (P-13 first half)', () => {
  it('carriers are exactly spawn ordinals 4, 11, 18', () => {
    const s = createGame(basicLevel(), OPTS);
    const carrierByOrdinal = new Map<number, boolean>();
    // Kill each enemy as it materializes: frees the cap AND clears the spawn tile
    // (dead tanks never block), so all 20 ordinals start.
    for (let i = 0; i < 4000 && carrierByOrdinal.size < 20; i++) {
      step(s);
      for (const e of spawnStarts(s))
        carrierByOrdinal.set(e.spawnOrdinal, e.carrier);
      for (const t of aliveEnemies(s)) if (t.spawningT === 0) t.alive = false;
    }

    expect(carrierByOrdinal.size).toBe(20);
    for (let ord = 1; ord <= 20; ord++) {
      expect(carrierByOrdinal.get(ord)).toBe(CARRIER_ORDINALS.includes(ord));
    }
  });

  it('armor enemies spawn with hp 4; others with hp 1', () => {
    const armorFirst = levelWith([
      'armor',
      ...Array.from({ length: 19 }, (): EnemyType => 'basic'),
    ]);
    const sa = createGame(armorFirst, OPTS);
    step(sa);
    expect(aliveEnemies(sa)[0].enemyType).toBe('armor');
    expect(aliveEnemies(sa)[0].hp).toBe(ARMOR_HP); // 4

    const sb = createGame(basicLevel(), OPTS);
    step(sb);
    expect(aliveEnemies(sb)[0].hp).toBe(1);
  });
});

describe('spawner — materialization & slot reuse', () => {
  it('a spawning enemy has no hitbox: a player bullet passes through it', () => {
    const s = createGame(basicLevel(), OPTS);
    // Player just below the LEFT spawn point, facing Up.
    s.tanks.push(
      makeTank({ id: 0, kind: 'player', playerIndex: 0, x: 0, y: 48, dir: 0 }),
    );

    step(s); // enemy starts spawning at (0,0)
    const enemy = aliveEnemies(s)[0];
    expect(enemy.spawningT).toBeGreaterThan(0);
    expect(enemy.x).toBe(0);
    expect(enemy.y).toBe(0);

    // Fire the player's bullet up through the spawn point (press edge).
    stepGame(s, [{ dir: null, fire: true, pause: false }, NULL_INTENT]);
    stepN(s, 30); // let the bullet clear the field

    expect(enemy.alive).toBe(true); // never hit — no hitbox while spawning
    expect(enemy.spawningT).toBeGreaterThan(0);
  });

  it('materializes after SPAWN_ANIM_S and emits enemySpawned with its id', () => {
    const s = createGame(basicLevel(), OPTS);
    stepN(s, ANIM_TICKS); // 78 ticks

    const enemy = aliveEnemies(s)[0];
    expect(enemy.spawningT).toBe(0);
    const spawned = s.events.filter((e) => e.t === 'enemySpawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ tankId: enemy.id });
  });

  it('an enemy materializing during an active Clock inherits its remaining freeze', () => {
    const s = createGame(basicLevel(), OPTS);
    s.clockT = 5; // Clock active — the spawner only READS it (T1.5 owns clockT)
    stepN(s, ANIM_TICKS);

    const enemy = aliveEnemies(s)[0];
    expect(enemy.spawningT).toBe(0);
    // Since T1.5, stageflow (system #1) counts the Clock down every tick, so what
    // the enemy inherits at materialization is the REMAINING freeze — 5 s minus
    // the 1.3 s the spawn animation took — and it runs in lockstep from there.
    near(enemy.frozenT, 5 - SPAWN_ANIM_S);
    expect(enemy.frozenT).toBe(s.clockT);
  });

  it('after all 20 enemies have started, no further spawns are attempted', () => {
    const s = createGame(basicLevel(), OPTS);
    let totalStarts = 0;
    for (let i = 0; i < 5000; i++) {
      step(s);
      totalStarts += spawnStarts(s).length;
      for (const t of aliveEnemies(s)) if (t.spawningT === 0) t.alive = false;
    }
    expect(totalStarts).toBe(20);
    expect(s.spawner.queue).toHaveLength(0);
  });

  it('slot reuse keeps the enemy array bounded at ENEMY_CAP (no players here)', () => {
    const s = createGame(basicLevel(), OPTS);
    let maxLen = 0;
    for (let i = 0; i < 1500; i++) {
      step(s);
      for (const t of aliveEnemies(s))
        if (t.spawningT === 0 && t.y === 0) t.y = 96;
      const alive = aliveEnemies(s);
      if (alive.length === ENEMY_CAP && i % 200 === 199) alive[0].alive = false;
      maxLen = Math.max(maxLen, s.tanks.length);
      expect(s.tanks.length).toBeLessThanOrEqual(ENEMY_CAP);
    }
    expect(maxLen).toBe(ENEMY_CAP); // grew to 4, then plateaued via reuse
  });
});
