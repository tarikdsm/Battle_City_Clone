// src/core/systems/spawner.ts — enemy spawner (pipeline system #2, fidelity §7 +
// §3.2). Every tick it (1) counts its schedule/retry timers down, (2) starts at
// most one spawn when the cadence is due and the field is below the active cap,
// and (3) advances the twinkle animation of enemies already mid-spawn, giving
// them a hitbox (and a Clock freeze, if one is active) the instant it completes.
//
// It is phase-agnostic on purpose: stage-flow / pause gating is a later task, and
// the tests drive ticks directly. Written allocation-free in steady state — dead
// enemy slots are recycled (never a fresh Tank per spawn in the common case) and
// the per-tick hot path uses the two module-level scratch AABBs below.
import {
  ARMOR_HP,
  CARRIER_ORDINALS,
  ENEMY_SPAWN_TILES,
  HALF_TICK,
  SPAWN_ANIM_S,
  SPAWN_CYCLE_ORDER,
  SPAWN_RETRY_S,
  TICK_S,
  TILE,
  enemyCap,
  spawnIntervalTicks,
} from '../constants';
import { aabbOverlap, type Aabb } from '../grid';
import { makeTank } from './movement';
import type { Dir, EnemyType, GameState, PlayerIntent, Tank } from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// `timerT`/`retryT` are countdowns stored in SECONDS but stepped one TICK_S at a
// time, so repeated subtraction drifts by a few ULPs. Comparing against the shared
// HALF_TICK threshold (constants.ts) makes the cadence land on EXACT tick counts —
// a 186-tick interval fires the next start exactly 186 ticks later, not 187. The
// effect timers in stageflow.ts snap onto the same threshold via `stepDown`.

// Enemies always face the base as they appear (types.ts Dir: 0 Up,1 Right,2 Down,3 Left).
const DIR_DOWN: Dir = 2;

// Module-level scratch AABBs (w/h are the fixed 16×16 tank/spawn box) — reused so
// the per-tick blocked check never allocates.
const spawnBox: Aabb = { x: 0, y: 0, w: TILE, h: TILE };
const otherBox: Aabb = { x: 0, y: 0, w: TILE, h: TILE };

export function spawnerSystem(state: GameState, intents: Intents): void {
  void intents; // driven by internal timers, not player input
  const sp = state.spawner;

  // 1 — schedule/retry countdowns (unconditional so an overdue attempt fires the
  //     moment the cap frees; retryT only counts while a block is being throttled).
  sp.timerT -= TICK_S;
  if (sp.retryT > 0) sp.retryT = Math.max(0, sp.retryT - TICK_S);

  // 2 — at most one spawn START per tick: the schedule is due, no blocked-point
  //     retry is throttling, the pool still has enemies, and the active count
  //     (alive enemies INCLUDING ones still animating) is below the cap (P-11).
  if (
    sp.timerT <= HALF_TICK &&
    sp.retryT <= HALF_TICK &&
    sp.queue.length > 0 &&
    activeEnemyCount(state) < enemyCap(activePlayers(state))
  ) {
    attemptSpawn(state);
  }

  // 3 — advance every enemy still mid-spawn; on reaching 0 it materializes (gains
  //     its hitbox) and, if a Clock is active, spawns already frozen (fidelity §8;
  //     T1.5 owns clockT — read it here only).
  for (const t of state.tanks) {
    if (t.kind !== 'enemy' || !t.alive || t.spawningT <= 0) continue;
    t.spawningT = Math.max(0, t.spawningT - TICK_S);
    if (t.spawningT === 0) {
      state.events.push({ t: 'enemySpawned', tankId: t.id });
      if (state.clockT > 0) t.frozenT = state.clockT;
    }
  }
}

// One spawn attempt at the current cycle point. Blocked → schedule a retry and
// leave the cycle/queue/schedule untouched. Clear → start the spawn and re-arm.
function attemptSpawn(state: GameState): void {
  const sp = state.spawner;
  // `cyclePos` counts spawns; SPAWN_CYCLE_ORDER maps that onto the ROM's visit
  // order, which starts at the CENTRE point and not at the left one (CAL-10).
  const point = ENEMY_SPAWN_TILES[SPAWN_CYCLE_ORDER[sp.cyclePos]];
  const x = point[0] * TILE;
  const y = point[1] * TILE;

  // Any alive tank (materialized OR mid-animation) overlapping the 16×16 spawn box
  // blocks the attempt: retry next tick, do not advance the cycle or consume the
  // queue (§7, P-12). Spawning tanks are intangible to bullets/movement but they
  // DO reserve their spawn tile.
  if (isSpawnBlocked(state, x, y)) {
    sp.retryT = SPAWN_RETRY_S;
    return;
  }

  const enemyType = sp.queue.shift(); // consume queue[0] (guarded: length > 0)
  if (enemyType === undefined) return; // unreachable — the caller checks the length
  const ordinal = sp.nextOrdinal;
  const carrier = CARRIER_ORDINALS.includes(ordinal);
  spawnEnemyTank(state, enemyType, ordinal, carrier, x, y);

  // The HUD decrements its `20 − spawned` icon count on this START event (P-11).
  state.events.push({
    t: 'enemySpawnStarted',
    spawnOrdinal: ordinal,
    x,
    y,
    enemyType,
    carrier,
  });

  sp.nextOrdinal += 1;
  sp.cyclePos = (sp.cyclePos + 1) % SPAWN_CYCLE_ORDER.length;
  sp.timerT =
    spawnIntervalTicks(state.stageNumber, activePlayers(state)) * TICK_S;
  sp.retryT = 0;
}

// Alive enemies on the field, INCLUDING ones still in the spawn animation — that
// is the count the cap governs (fidelity §7).
function activeEnemyCount(state: GameState): number {
  let n = 0;
  for (const t of state.tanks) {
    if (t.alive && t.kind === 'enemy') n += 1;
  }
  return n;
}

// The player-count term of the interval formula: 2 only while BOTH players are
// active, else 1 (P-25). Allocation-free equivalent of players.filter(active).length.
function activePlayers(state: GameState): 1 | 2 {
  const n =
    (state.players[0].active ? 1 : 0) + (state.players[1].active ? 1 : 0);
  return n >= 2 ? 2 : 1;
}

function isSpawnBlocked(state: GameState, x: number, y: number): boolean {
  spawnBox.x = x;
  spawnBox.y = y;
  for (const t of state.tanks) {
    if (!t.alive) continue;
    otherBox.x = t.x;
    otherBox.y = t.y;
    if (aabbOverlap(spawnBox, otherBox)) return true;
  }
  return false;
}

// Start a new enemy in the first dead ENEMY slot (players own their own slots and
// are never recycled here), else grow the pool. `id` == the slot's array index and
// is stable for the slot's whole life — recycled across lifetimes exactly like the
// bullet pool (bullets.ts). This keeps the array bounded at 2 players + the
// on-field enemy cap (4 in 1P, 6 in 2P — CAL-09).
function spawnEnemyTank(
  state: GameState,
  enemyType: EnemyType,
  ordinal: number,
  carrier: boolean,
  x: number,
  y: number,
): void {
  const hp = enemyType === 'armor' ? ARMOR_HP : 1;

  for (let i = 0; i < state.tanks.length; i++) {
    const slot = state.tanks[i];
    if (!slot.alive && slot.kind === 'enemy') {
      resetEnemyTank(slot, enemyType, ordinal, carrier, hp, x, y);
      return;
    }
  }

  state.tanks.push(
    makeTank({
      id: state.tanks.length,
      kind: 'enemy',
      enemyType,
      spawnOrdinal: ordinal,
      carrier,
      hp,
      x,
      y,
      dir: DIR_DOWN,
      spawningT: SPAWN_ANIM_S,
    }),
  );
}

// Overwrite EVERY mutable field of a recycled slot so nothing leaks from its prior
// life (a dead enemy may have moved, been frozen, or taken damage). `id` already
// equals the slot's array index and is intentionally left untouched.
function resetEnemyTank(
  t: Tank,
  enemyType: EnemyType,
  ordinal: number,
  carrier: boolean,
  hp: number,
  x: number,
  y: number,
): void {
  t.alive = true;
  t.kind = 'enemy';
  t.playerIndex = undefined;
  t.enemyType = enemyType;
  t.spawnOrdinal = ordinal;
  t.carrier = carrier;
  t.x = x;
  t.y = y;
  t.prevX = x;
  t.prevY = y;
  t.dir = DIR_DOWN;
  t.moving = false;
  t.sliding = false;
  t.slideV = 0;
  t.hp = hp;
  t.tier = 0;
  t.shieldT = 0;
  t.stunT = 0;
  t.frozenT = 0;
  t.spawningT = SPAWN_ANIM_S;
  t.bulletsAirborne = 0;
  t.fireHeld = false;
  t.aiTimerT = 0; // due immediately: the new enemy decides on its first free tick
  // Lattice memory starts where the tank appears. Belt-and-braces rather than
  // load-bearing: aiSystem re-arms both fields later in the same tick, and the
  // read in between is discarded because `spawningT > 0` short-circuits first.
  // Kept so a recycled slot is never observably stale — it is two assignments.
  t.aiTileX = Math.floor(x / TILE);
  t.aiTileY = Math.floor(y / TILE);
}
