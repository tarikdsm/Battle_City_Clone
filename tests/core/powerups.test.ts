// tests/core/powerups.test.ts — the six power-ups and their timed effects (T1.5,
// fidelity §8 + §3.2). Parity coverage tagged in the test names: P-13 (carrier
// drops a power-up on the FIRST hit), P-14 (at most one on field — a new one
// replaces the old), P-15 (star / helmet / clock pickups), P-16 (shovel: steel →
// blink → fully repaired brick), P-17 (clock freeze, including enemies that
// materialize mid-clock), P-18 (grenade: no points, mid-spawn enemies spared).
//
// Effect timers are always driven through `stepGame` (stageflow is system #1);
// the pickup pass is called directly wherever staging a bullet flight would only
// add noise to a test about the EFFECT.
import { describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import { tryFire } from '../../src/core/systems/bullets';
import { powerupsSystem } from '../../src/core/systems/index';
import { makeTank } from '../../src/core/systems/movement';
import {
  BASE_RING_TILES,
  CLOCK_S,
  FIELD_U,
  HELMET_S,
  POWERUP_TYPES,
  SHOVEL_BLINK_S,
  SHOVEL_SOLID_S,
  SPAWN_ANIM_S,
  START_LIVES,
  STUN_S,
  SUBCELL,
  TICK_S,
  TILE,
} from '../../src/core/constants';
import { aabbOverlap, subcellIndex, type Aabb } from '../../src/core/grid';
import { NULL_INTENT, Terrain } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
  Dir,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  PowerupType,
  Tank,
} from '../../src/core/types';

const OPTS = { players: 1 as const, seed: 42, stageNumber: 1 };
const OPTS_2P = { players: 2 as const, seed: 42, stageNumber: 1 };
const NO_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  NULL_INTENT,
  NULL_INTENT,
];
const FIRE: PlayerIntent = { dir: null, fire: true, pause: false };
const WALK_RIGHT: PlayerIntent = { dir: 1, fire: false, pause: false };

// The base exclusion rectangle, spelled out exactly as the spec documents it
// (tiles 5..7 × 11..12) so the test pins the RULE, not the implementation's
// derivation of it.
const BASE_ZONE: Aabb = { x: 80, y: 176, w: 48, h: 32 };

const SUBCELLS_PER_TILE = TILE / SUBCELL; // 2
const ANIM_TICKS = Math.round(SPAWN_ANIM_S / TICK_S); // 78
const CLOCK_TICKS = Math.round(CLOCK_S / TICK_S); // 600
const HELMET_TICKS = Math.round(HELMET_S / TICK_S); // 600
const STUN_TICKS = Math.round(STUN_S / TICK_S); // 180
const SOLID_TICKS = Math.round(SHOVEL_SOLID_S / TICK_S); // 1020
const BLINK_TICKS = Math.round(SHOVEL_BLINK_S / TICK_S); // 180
const RING_SUBCELLS = BASE_RING_TILES.length * SUBCELLS_PER_TILE ** 2; // 20

// --- Fixtures --------------------------------------------------------------

function level(enemies: EnemyType[], noAutoBase: boolean): LevelData {
  return {
    version: 1,
    id: 'pu',
    name: 'Power-up Test',
    terrain: Array.from({ length: 13 }, () => '.'.repeat(13)),
    enemies,
    noAutoBase,
  };
}

// Bare field, no base ring: nothing but the power-up logic under test.
function openField(enemies: EnemyType[] = []): LevelData {
  return level(enemies, true);
}

// Field with the auto-stamped brick ring — the shovel tests need it.
function baseField(): LevelData {
  return level([], false);
}

function addPlayer(
  s: GameState,
  playerIndex: 0 | 1,
  x: number,
  y: number,
  dir: Dir = 0,
): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'player',
    playerIndex,
    x,
    y,
    dir,
  });
  s.tanks.push(t);
  return t;
}

function addEnemy(
  s: GameState,
  x: number,
  y: number,
  init: Partial<Tank> = {},
): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'enemy',
    enemyType: 'basic',
    x,
    y,
    dir: 2,
    ...init,
  });
  s.tanks.push(t);
  return t;
}

// --- Drivers ---------------------------------------------------------------

function step(
  s: GameState,
  intents: readonly [PlayerIntent, PlayerIntent] = NO_INTENTS,
): void {
  stepGame(s, intents);
}

function stepN(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) step(s);
}

// Step `n` ticks, accumulating every event emitted along the way.
function stepCollect(
  s: GameState,
  n: number,
  intents: readonly [PlayerIntent, PlayerIntent] = NO_INTENTS,
): GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(s, intents);
    for (const e of s.events) out.push(e);
  }
  return out;
}

function only<K extends GameEvent['t']>(
  evs: readonly GameEvent[],
  t: K,
): Extract<GameEvent, { t: K }>[] {
  return evs.filter((e): e is Extract<GameEvent, { t: K }> => e.t === t);
}

// Put a power-up under `tank` and run system #7 on its own. Isolating the pickup
// keeps the EFFECT tests free of bullet flights and stray RNG draws.
function giveTo(s: GameState, tank: Tank, type: PowerupType): void {
  s.events.length = 0;
  s.powerup = { type, x: tank.x, y: tank.y };
  powerupsSystem(s, NO_INTENTS);
}

// Fire one player bullet outside the pipeline, then take the shooter off the
// board: a dead shooter can never collect the drop it is about to cause, so
// these tests observe the drop itself and never a same-tick pickup.
function snipe(s: GameState, shooter: Tank): void {
  shooter.alive = true;
  tryFire(s, shooter);
  shooter.alive = false;
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

function ringSubcells(s: GameState): number[] {
  const out: number[] = [];
  for (const [tx, ty] of BASE_RING_TILES) {
    const sx = tx * SUBCELLS_PER_TILE;
    const sy = ty * SUBCELLS_PER_TILE;
    out.push(
      s.terrain[subcellIndex(sx, sy)],
      s.terrain[subcellIndex(sx + 1, sy)],
      s.terrain[subcellIndex(sx, sy + 1)],
      s.terrain[subcellIndex(sx + 1, sy + 1)],
    );
  }
  return out;
}

function allRing(kind: number): number[] {
  return Array.from({ length: RING_SUBCELLS }, () => kind);
}

// --- 1..4: carrier drops & spawn placement ---------------------------------

describe('power-ups — carrier drops (P-13, P-14)', () => {
  it('P-13: an armor carrier drops on the FIRST hit and never again', () => {
    const s = createGame(openField(), OPTS);
    const shooter = addPlayer(s, 0, 0, 96, 1); // facing Right
    const carrier = addEnemy(s, 32, 96, {
      enemyType: 'armor',
      hp: 4,
      carrier: true,
      frozenT: 60, // holds still as a target: since T1.6 the AI would drive it
      // out of the bullet's lane (and shoot back). A freeze changes nothing
      // about taking damage or dropping.
    });

    step(s, [FIRE, NULL_INTENT]); // press edge → one bullet
    shooter.alive = false; // the shooter must not collect its own drop
    const first = stepCollect(s, 20);

    expect(only(first, 'powerupSpawned')).toHaveLength(1);
    expect(s.powerup).not.toBeNull();
    expect(carrier.carrier).toBe(false);
    expect(carrier.alive).toBe(true);
    expect(carrier.hp).toBe(3);

    // Second hit on the same (no longer flashing) carrier: no new drop.
    const before = { ...s.powerup };
    snipe(s, shooter);
    const second = stepCollect(s, 20);

    expect(only(second, 'tankHit')).toHaveLength(1);
    expect(only(second, 'powerupSpawned')).toHaveLength(0);
    expect(carrier.hp).toBe(2);
    expect(s.powerup).toEqual(before);
  });

  it('P-13: a carrier killed outright by one hit still drops', () => {
    const s = createGame(openField(), OPTS);
    const shooter = addPlayer(s, 0, 0, 96, 1);
    const carrier = addEnemy(s, 32, 96, { carrier: true }); // basic, hp 1

    step(s, [FIRE, NULL_INTENT]);
    shooter.alive = false;
    const evs = stepCollect(s, 20);

    expect(only(evs, 'tankDestroyed')).toHaveLength(1);
    expect(only(evs, 'powerupSpawned')).toHaveLength(1);
    expect(carrier.alive).toBe(false);
    expect(carrier.carrier).toBe(false);
    expect(s.powerup).not.toBeNull();
  });

  it('P-14: a second drop REPLACES the first — only ever one on the field', () => {
    const s = createGame(openField(), OPTS);
    const shooter = addPlayer(s, 0, 0, 96, 1);
    // Frozen only so both hold their lane as targets (see the P-13 test above).
    addEnemy(s, 32, 96, { carrier: true, frozenT: 60 });
    addEnemy(s, 80, 96, { carrier: true, frozenT: 60 });

    shooter.alive = false;
    snipe(s, shooter);
    const firstRun = stepCollect(s, 20);
    const firstSpawn = only(firstRun, 'powerupSpawned');
    expect(firstSpawn).toHaveLength(1);
    expect(s.powerup).toEqual({
      type: firstSpawn[0].type,
      x: firstSpawn[0].x,
      y: firstSpawn[0].y,
    });

    snipe(s, shooter);
    const secondRun = stepCollect(s, 40);
    const secondSpawn = only(secondRun, 'powerupSpawned');
    expect(secondSpawn).toHaveLength(1);
    expect(s.powerup).toEqual({
      type: secondSpawn[0].type,
      x: secondSpawn[0].x,
      y: secondSpawn[0].y,
    });
  });

  // Golden values for seed 42, computed from the DOCUMENTED draw order — type
  // first, then a (x, y) pair per placement attempt with BOTH coordinates
  // redrawn on a reject. Drop 1 rejects its first pair (it lands on the base),
  // so this pair of triples also pins the reroll shape, not just the order.
  // T1.8's golden replays inherit this stream: swapping x/y, hoisting the type
  // roll, dropping a coordinate on reject, or reordering POWERUP_TYPES must all
  // fail here rather than silently rewrite every recorded run.
  // The triples below can only pin the table slots they happen to draw, so pin
  // the whole canonical order here too. game.ts's state hash indexes this same
  // array, so one reorder would shift both the RNG roll and every hash.
  it('pins the canonical power-up order shared by the roll and the state hash', () => {
    expect(POWERUP_TYPES).toEqual([
      'star',
      'helmet',
      'clock',
      'shovel',
      'grenade',
      'tank',
    ]);
  });

  it('pins the RNG draw order: type, then x, then y, both redrawn per attempt', () => {
    const s = createGame(openField(), OPTS); // seed 42, nothing has drawn yet
    const carrier = addEnemy(s, 0, 0, { carrier: true });

    const drops: { type: PowerupType; x: number; y: number }[] = [];
    for (let i = 0; i < 2; i++) {
      carrier.carrier = true;
      s.events.length = 0;
      s.events.push({ t: 'tankHit', tankId: carrier.id, hpLeft: 1 });
      powerupsSystem(s, NO_INTENTS);
      const spawned = only(s.events, 'powerupSpawned');
      expect(spawned).toHaveLength(1);
      drops.push({ type: spawned[0].type, x: spawned[0].x, y: spawned[0].y });
      expect(s.powerup).toEqual(drops[i]); // state and event always agree
    }

    expect(drops).toEqual([
      { type: 'shovel', x: 128, y: 32 },
      { type: 'shovel', x: 48, y: 120 },
    ]);
  });

  it('P-13: a carrier hit twice in ONE tick still drops exactly one power-up', () => {
    const s = createGame(openField(), OPTS);
    const carrier = addEnemy(s, 0, 0, { carrier: true });

    s.events.length = 0;
    s.events.push({ t: 'tankHit', tankId: carrier.id, hpLeft: 3 });
    s.events.push({
      t: 'tankDestroyed',
      tankId: carrier.id,
      kind: 'enemy',
      points: 0,
      x: 0,
      y: 0,
    });
    powerupsSystem(s, NO_INTENTS);

    expect(only(s.events, 'powerupSpawned')).toHaveLength(1);
    expect(carrier.carrier).toBe(false);
  });

  it('a carrier wiped by a grenade drops nothing (ruling: the drop needs a hit)', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);
    const carrier = addEnemy(s, 96, 96, { carrier: true });

    giveTo(s, p, 'grenade');

    expect(only(s.events, 'grenadeUsed')).toEqual([
      { t: 'grenadeUsed', kills: 1 },
    ]);
    expect(only(s.events, 'powerupSpawned')).toHaveLength(0);
    expect(s.powerup).toBeNull();
    expect(carrier.alive).toBe(false);

    // And the grenade's own tankDestroyed must not drop one on the NEXT tick
    // either — events are per-tick, and the carrier is gone regardless.
    expect(only(stepCollect(s, 5), 'powerupSpawned')).toHaveLength(0);
  });

  it('every drop lands subcell-aligned, in-field and clear of the base', () => {
    let drops = 0;
    for (const seed of [1, 42, 1337]) {
      const s = createGame(openField(), { players: 1, seed, stageNumber: 1 });
      const carrier = addEnemy(s, 0, 0, { carrier: true }); // no player: nothing collects

      for (let i = 0; i < 100; i++) {
        carrier.carrier = true;
        s.events.length = 0;
        s.events.push({ t: 'tankHit', tankId: carrier.id, hpLeft: 1 });
        powerupsSystem(s, NO_INTENTS);

        const p = s.powerup;
        expect(p).not.toBeNull();
        if (p === null) return;
        expect(p.x % SUBCELL).toBe(0);
        expect(p.y % SUBCELL).toBe(0);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(FIELD_U - TILE);
        expect(p.y).toBeLessThanOrEqual(FIELD_U - TILE);
        expect(
          aabbOverlap({ x: p.x, y: p.y, w: TILE, h: TILE }, BASE_ZONE),
        ).toBe(false);
        drops++;
      }
    }
    expect(drops).toBe(300);
  });
});

// --- 5, 15: pickup ---------------------------------------------------------

describe('power-ups — pickup', () => {
  it('a player who walks onto a power-up consumes it', () => {
    const s = createGame(openField(), OPTS);
    addPlayer(s, 0, 0, 0, 1);
    s.powerup = { type: 'helmet', x: 24, y: 0 };

    // 45 u/s → 0.75 u/tick; the boxes strictly overlap once x > 8.
    const evs = stepCollect(s, 20, [WALK_RIGHT, NULL_INTENT]);
    const collected = only(evs, 'powerupCollected');

    expect(s.powerup).toBeNull();
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({
      t: 'powerupCollected',
      type: 'helmet',
      playerIndex: 0,
      x: 24,
      y: 0,
    });
  });

  it('with both players overlapping, P1 collects and P2 gets nothing', () => {
    const s = createGame(openField(), OPTS_2P);
    const p1 = addPlayer(s, 0, 0, 0);
    const p2 = addPlayer(s, 1, 8, 0);
    s.powerup = { type: 'helmet', x: 0, y: 0 };
    s.events.length = 0;

    powerupsSystem(s, NO_INTENTS);

    const collected = only(s.events, 'powerupCollected');
    expect(collected).toHaveLength(1);
    expect(collected[0].playerIndex).toBe(0);
    expect(p1.shieldT).toBe(HELMET_S);
    expect(p2.shieldT).toBe(0);
    expect(s.powerup).toBeNull();
  });
});

// --- 6, 7, 13: star / helmet / tank ----------------------------------------

describe('power-ups — star, helmet, extra life (P-15)', () => {
  it('P-15 star: tier climbs 0→1→2→3 and stays at 3', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);

    for (const expected of [1, 2, 3, 3]) {
      giveTo(s, p, 'star');
      const changes = only(s.events, 'tierChanged');
      expect(p.tier).toBe(expected);
      expect(changes).toHaveLength(1); // emitted even at the cap — a real pickup
      expect(changes[0]).toEqual({
        t: 'tierChanged',
        playerIndex: 0,
        tier: expected,
      });
    }
  });

  it('P-15 helmet: full shield on pickup, decays each tick, resets on re-pickup', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);

    giveTo(s, p, 'helmet');
    expect(p.shieldT).toBe(HELMET_S);

    stepN(s, 60); // one second of stageflow decay
    near(p.shieldT, HELMET_S - 1);

    giveTo(s, p, 'helmet'); // restart, never stack
    expect(p.shieldT).toBe(HELMET_S);

    // The snap must never SHORTEN the effect: still shielded one tick out,
    // exactly zero on the 600th — so HELMET_S is pinned at 600 whole ticks.
    stepN(s, HELMET_TICKS - 1);
    expect(p.shieldT).toBeGreaterThan(0);
    stepN(s, 1);
    expect(p.shieldT).toBe(0);
  });

  it('tank: +1 life to the collector and an extraLife event', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);
    expect(s.players[0].lives).toBe(START_LIVES);

    giveTo(s, p, 'tank');

    expect(s.players[0].lives).toBe(START_LIVES + 1);
    expect(only(s.events, 'extraLife')).toEqual([
      { t: 'extraLife', playerIndex: 0 },
    ]);
    expect(s.players[1].lives).toBe(0); // 1P: the inactive slot is untouched
  });
});

// --- 8, 11, 14: clock & stun timers ----------------------------------------

describe('power-ups — clock (P-15, P-17)', () => {
  it('P-17 clock: freezes every materialized enemy, cancels slides, ends once', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);
    const still = addEnemy(s, 96, 96);
    const slider = addEnemy(s, 96, 32, {
      sliding: true,
      slideV: 30,
      moving: true,
    });

    giveTo(s, p, 'clock');

    expect(s.clockT).toBe(CLOCK_S);
    expect(still.frozenT).toBe(CLOCK_S);
    expect(slider.frozenT).toBe(CLOCK_S);
    expect(slider.sliding).toBe(false);
    expect(slider.slideV).toBe(0);
    expect(only(s.events, 'clockStarted')).toHaveLength(1);

    // One tick short of the window: still frozen, still counting, no event yet —
    // the half-tick snap must not shorten the freeze by even one tick.
    const almost = stepCollect(s, CLOCK_TICKS - 1);
    expect(s.clockT).toBeGreaterThan(0);
    expect(still.frozenT).toBeGreaterThan(0);
    expect(only(almost, 'clockEnded')).toHaveLength(0);

    const evs = stepCollect(s, 1);

    expect(s.clockT).toBe(0);
    expect(still.frozenT).toBe(0);
    expect(slider.frozenT).toBe(0);
    expect(only(evs, 'clockEnded')).toHaveLength(1);

    // And it stays ended — no repeat event once the countdown has bottomed out.
    expect(only(stepCollect(s, 60), 'clockEnded')).toHaveLength(0);
  });

  it('P-17: an enemy materializing mid-clock inherits the REMAINING freeze', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);

    giveTo(s, p, 'clock');
    stepN(s, 299); // 10 s − 299 ticks ≈ 5.017 s left

    // A tank one tick away from materializing; the spawner (system #2) completes
    // it after stageflow has taken this tick's slice off the clock.
    const late = addEnemy(s, 96, 0, { spawningT: TICK_S });
    step(s);

    expect(late.spawningT).toBe(0);
    near(s.clockT, CLOCK_S / 2);
    expect(late.frozenT).toBe(s.clockT); // exactly in lockstep, not merely close

    const evs = stepCollect(s, CLOCK_TICKS / 2);
    expect(s.clockT).toBe(0);
    expect(late.frozenT).toBe(0); // both unfreeze on the very same tick
    expect(only(evs, 'clockEnded')).toHaveLength(1);
  });

  it('stun decays through stageflow like every other tank timer', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);
    p.stunT = STUN_S;

    stepN(s, 60);

    near(p.stunT, STUN_S - 1); // 2.0
    stepN(s, STUN_TICKS - 60 - 1);
    expect(p.stunT).toBeGreaterThan(0); // 179 ticks in — still stunned
    stepN(s, 1);
    expect(p.stunT).toBe(0); // exactly 180
  });
});

// --- 9, 10: shovel ---------------------------------------------------------

describe('power-ups — shovel (P-16)', () => {
  it('P-16 shovel: repairs + steels the ring, blinks, then reverts to full brick', () => {
    const s = createGame(baseField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);

    // Blow two subcells out of ring tile (5,11) first — the shovel must repair them.
    s.terrain[subcellIndex(10, 22)] = Terrain.Empty;
    s.terrain[subcellIndex(11, 22)] = Terrain.Empty;

    giveTo(s, p, 'shovel');

    expect(ringSubcells(s)).toEqual(allRing(Terrain.Steel));
    expect(s.shovel.phase).toBe('steel');
    expect(s.shovel.t).toBe(SHOVEL_SOLID_S);
    expect(only(s.events, 'shovelPhase')).toEqual([
      { t: 'shovelPhase', phase: 'steel' },
    ]);

    // One tick short of 17 s the ring is still solid — the snap never shortens it.
    const nearlySolid = stepCollect(s, SOLID_TICKS - 1);
    expect(only(nearlySolid, 'shovelPhase')).toHaveLength(0);
    expect(s.shovel.phase).toBe('steel');
    expect(s.shovel.t).toBeGreaterThan(0);

    const solid = stepCollect(s, 1);
    expect(only(solid, 'shovelPhase')).toEqual([
      { t: 'shovelPhase', phase: 'blink' },
    ]);
    expect(s.shovel.phase).toBe('blink');
    expect(s.shovel.t).toBe(SHOVEL_BLINK_S);
    expect(ringSubcells(s)).toEqual(allRing(Terrain.Steel)); // still steel while blinking

    // Likewise for the 3 s warning: still blinking (and still steel) at tick 179.
    const nearlyDone = stepCollect(s, BLINK_TICKS - 1);
    expect(only(nearlyDone, 'shovelPhase')).toHaveLength(0);
    expect(s.shovel.phase).toBe('blink');
    expect(s.shovel.t).toBeGreaterThan(0);
    expect(ringSubcells(s)).toEqual(allRing(Terrain.Steel));

    const blink = stepCollect(s, 1);
    expect(only(blink, 'shovelPhase')).toEqual([
      { t: 'shovelPhase', phase: 'revert' },
    ]);
    expect(s.shovel.phase).toBe('off');
    expect(s.shovel.t).toBe(0);
    expect(ringSubcells(s)).toEqual(allRing(Terrain.Brick)); // FULLY repaired

    expect(only(stepCollect(s, 60), 'shovelPhase')).toHaveLength(0);
  });

  it('P-16: re-collecting mid-effect restarts the solid phase from full', () => {
    const s = createGame(baseField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);

    giveTo(s, p, 'shovel');
    stepN(s, SOLID_TICKS / 2); // half the solid phase gone
    near(s.shovel.t, SHOVEL_SOLID_S / 2);

    giveTo(s, p, 'shovel');

    expect(s.shovel.phase).toBe('steel');
    expect(s.shovel.t).toBe(SHOVEL_SOLID_S);
    expect(ringSubcells(s)).toEqual(allRing(Terrain.Steel));
  });
});

// --- 12: grenade -----------------------------------------------------------

describe('power-ups — grenade (P-18)', () => {
  it('P-18 grenade: wipes materialized enemies for 0 points, spares mid-spawn ones', () => {
    const s = createGame(openField(), OPTS);
    const p = addPlayer(s, 0, 0, 0);
    const a = addEnemy(s, 32, 0);
    const b = addEnemy(s, 64, 0, { enemyType: 'fast' });
    const c = addEnemy(s, 96, 0, { enemyType: 'armor', hp: 4 });
    const hatching = addEnemy(s, 128, 0, { spawningT: SPAWN_ANIM_S });

    giveTo(s, p, 'grenade');

    const kills = only(s.events, 'tankDestroyed');
    expect(kills).toHaveLength(3);
    for (const k of kills) {
      expect(k.kind).toBe('enemy');
      expect(k.points).toBe(0);
      expect(k.byPlayerIndex).toBeUndefined();
      expect(Object.hasOwn(k, 'byPlayerIndex')).toBe(false); // no scorer at all
    }
    expect(kills.map((k) => k.tankId)).toEqual([a.id, b.id, c.id]);
    expect(kills.map((k) => k.enemyType)).toEqual(['basic', 'fast', 'armor']);
    expect(only(s.events, 'grenadeUsed')).toEqual([
      { t: 'grenadeUsed', kills: 3 },
    ]);

    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(c.alive).toBe(false);
    expect(hatching.alive).toBe(true);
    expect(hatching.spawningT).toBeGreaterThan(0);
    expect(s.players[0].score).toBe(0); // scoring is T1.7's; a grenade never pays

    // The spared tank still finishes its animation and joins the field.
    const evs = stepCollect(s, ANIM_TICKS);
    expect(only(evs, 'enemySpawned')).toEqual([
      { t: 'enemySpawned', tankId: hatching.id },
    ]);
    expect(hatching.spawningT).toBe(0);
    expect(hatching.alive).toBe(true);
  });
});
