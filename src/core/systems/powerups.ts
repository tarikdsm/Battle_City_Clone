// src/core/systems/powerups.ts — power-up drops, pickup and effects (pipeline
// system #7, fidelity spec §8 + §3.2). Two passes, in this order:
//
//   A. carrier drop — scan THIS tick's events (bulletsSystem is system #6, so its
//      tankHit/tankDestroyed are already in state.events) and spawn a power-up for
//      every carrier that was struck for the first time (P-13).
//   B. pickup      — the first eligible player whose 16×16 box overlaps the
//      power-up consumes it and its effect fires immediately (P-14..P-18).
//
// Scoring is deliberately absent: this system only announces `powerupCollected`
// and `tankDestroyed`; the players system (T1.7) turns those into points.
//
// Written allocation-free in steady state: the two module-level scratch AABBs
// below are reused, and a replacement drop overwrites the existing power-up
// object rather than allocating a new one.
import {
  BASE_RING_TILES,
  CLOCK_S,
  FIELD_U,
  HELMET_S,
  SHOVEL_SOLID_S,
  SUBCELL,
  TANK_SIZE,
  TILE,
} from '../constants';
import { aabbOverlap, subcellIndex, type Aabb } from '../grid';
import { nextInt } from '../rng';
import {
  Terrain,
  type GameState,
  type PlayerIntent,
  type PowerupType,
  type Tank,
  type TerrainKind,
} from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// Roll order for `nextInt(rng, 6)`. Fixed and canonical — changing it changes
// every seeded replay (fidelity §8/§14).
const POWERUP_TYPES: readonly PowerupType[] = [
  'star',
  'helmet',
  'clock',
  'shovel',
  'grenade',
  'tank',
];

// Star tier progression, indexed by current tier: 3 is the cap (§3.1).
const NEXT_TIER: readonly (0 | 1 | 2 | 3)[] = [1, 2, 3, 3];

// A power-up occupies one tile (16×16) and is placed on the subcell lattice, so
// its top-left may be any of 25 slots per axis: 0, 8, … 192 (192 + 16 = 208).
const PLACEMENT_SLOTS = (FIELD_U - TILE) / SUBCELL + 1; // 25

// Rejection sampling bound. Roughly 4.5 % of the 625 slot pairs land on the base,
// so 32 draws all failing has probability ~1e-44 — the (0,0) fallback below exists
// only to keep the loop provably terminating, never as a real outcome.
const MAX_PLACEMENT_TRIES = 32;

// Power-ups never spawn on the base: the bounding box of the brick ring,
// tiles 5..7 × 11..12 → (80, 176, 48, 32). Derived from the ring so the two can
// never drift apart.
const BASE_ZONE: Aabb = baseRingBounds();

// Module-level scratch — reused every tick so the hot path never allocates.
const tankBox: Aabb = { x: 0, y: 0, w: TANK_SIZE, h: TANK_SIZE };
const itemBox: Aabb = { x: 0, y: 0, w: TILE, h: TILE };

// --- System ----------------------------------------------------------------

export function powerupsSystem(state: GameState, intents: Intents): void {
  void intents; // driven by bullet events and tank geometry, not by input
  dropFromStruckCarriers(state);
  collect(state);
}

// Stamp all four subcells of every base-ring tile to `kind`. Used by the Shovel
// (→ Steel, which also repairs shot-out subcells) and by the stage-flow timer
// when the effect reverts (→ a FULLY repaired Brick ring, fidelity §8).
export function stampBaseRing(state: GameState, kind: TerrainKind): void {
  for (const [tx, ty] of BASE_RING_TILES) {
    const sx = tx * 2; // two subcells per tile
    const sy = ty * 2;
    state.terrain[subcellIndex(sx, sy)] = kind;
    state.terrain[subcellIndex(sx + 1, sy)] = kind;
    state.terrain[subcellIndex(sx, sy + 1)] = kind;
    state.terrain[subcellIndex(sx + 1, sy + 1)] = kind;
  }
}

// --- A. Carrier drops ------------------------------------------------------

// P-13: the FIRST hit on a carrier drops a power-up and stops the flashing. The
// damage itself was already applied by bulletsSystem; the `carrier` flag is the
// one-shot guard, so a later hit (or a lethal hit that also emits tankDestroyed)
// can never produce a second drop.
function dropFromStruckCarriers(state: GameState): void {
  const n = state.events.length; // snapshot: spawning appends to this same array
  for (let i = 0; i < n; i++) {
    const e = state.events[i];
    if (e.t !== 'tankHit' && e.t !== 'tankDestroyed') continue;
    const tank = findTank(state, e.tankId);
    if (tank === undefined || tank.carrier !== true) continue;
    tank.carrier = false;
    spawnPowerup(state);
  }
}

function spawnPowerup(state: GameState): void {
  const type = POWERUP_TYPES[nextInt(state.rng, POWERUP_TYPES.length)];

  // Rejection-sample a subcell-aligned, fully in-field slot clear of the base.
  // Both coordinates are re-drawn on every attempt (the pair is what is rejected).
  let x = 0;
  let y = 0; // fallback slot — the top-left corner is always clear of the base
  for (let tries = 0; tries < MAX_PLACEMENT_TRIES; tries++) {
    const cx = nextInt(state.rng, PLACEMENT_SLOTS) * SUBCELL;
    const cy = nextInt(state.rng, PLACEMENT_SLOTS) * SUBCELL;
    if (!overlapsBaseZone(cx, cy)) {
      x = cx;
      y = cy;
      break;
    }
  }

  // P-14: at most one power-up on the field — a new drop replaces the old one.
  if (state.powerup === null) {
    state.powerup = { type, x, y };
  } else {
    state.powerup.type = type;
    state.powerup.x = x;
    state.powerup.y = y;
  }
  state.events.push({ t: 'powerupSpawned', type, x, y });
}

function overlapsBaseZone(x: number, y: number): boolean {
  itemBox.x = x;
  itemBox.y = y;
  return aabbOverlap(itemBox, BASE_ZONE);
}

function baseRingBounds(): Aabb {
  let txMin = Infinity;
  let txMax = -Infinity;
  let tyMin = Infinity;
  let tyMax = -Infinity;
  for (const [tx, ty] of BASE_RING_TILES) {
    if (tx < txMin) txMin = tx;
    if (tx > txMax) txMax = tx;
    if (ty < tyMin) tyMin = ty;
    if (ty > tyMax) tyMax = ty;
  }
  return {
    x: txMin * TILE,
    y: tyMin * TILE,
    w: (txMax - txMin + 1) * TILE,
    h: (tyMax - tyMin + 1) * TILE,
  };
}

// --- B. Pickup -------------------------------------------------------------

// Only a live, materialized PLAYER collects. Ties within a tick go to the lower
// array index — player tanks are created in playerIndex order, so P1 wins.
function collect(state: GameState): void {
  const item = state.powerup;
  if (item === null) return;
  itemBox.x = item.x;
  itemBox.y = item.y;

  for (const tank of state.tanks) {
    if (tank.kind !== 'player' || !tank.alive || tank.spawningT > 0) continue;
    const playerIndex = tank.playerIndex;
    if (playerIndex === undefined) continue;
    tankBox.x = tank.x;
    tankBox.y = tank.y;
    if (!aabbOverlap(tankBox, itemBox)) continue;

    state.powerup = null;
    state.events.push({
      t: 'powerupCollected',
      type: item.type,
      playerIndex,
      x: item.x,
      y: item.y,
    });
    applyEffect(state, tank, playerIndex, item.type);
    return; // consumed — nobody else can collect it this tick
  }
}

function applyEffect(
  state: GameState,
  tank: Tank,
  playerIndex: 0 | 1,
  type: PowerupType,
): void {
  switch (type) {
    case 'star':
      // P-15: +1 tier, capped at 3. The event fires even at the cap — the pickup
      // itself is observable (and still scores).
      tank.tier = NEXT_TIER[tank.tier];
      state.events.push({ t: 'tierChanged', playerIndex, tier: tank.tier });
      break;

    case 'helmet':
      // P-15: re-collecting RESTARTS the shield, it never stacks.
      tank.shieldT = HELMET_S;
      break;

    case 'clock':
      // P-15/P-17: freeze every enemy already on the field. Enemies that
      // materialize later inherit the remaining time from the spawner (system #2).
      state.clockT = CLOCK_S;
      for (const t of state.tanks) {
        if (t.kind !== 'enemy' || !t.alive || t.spawningT > 0) continue;
        t.frozenT = CLOCK_S;
        t.sliding = false; // a freeze also kills an ice slide in progress
        t.slideV = 0;
      }
      state.events.push({ t: 'clockStarted' });
      break;

    case 'shovel':
      // P-16: solid steel ring for 17 s (damage repaired on the way in), then the
      // blink warning and the revert to brick — both owned by stageflowSystem.
      state.shovel.phase = 'steel';
      state.shovel.t = SHOVEL_SOLID_S;
      stampBaseRing(state, Terrain.Steel);
      state.events.push({ t: 'shovelPhase', phase: 'steel' });
      break;

    case 'grenade':
      detonateGrenade(state);
      break;

    case 'tank':
      state.players[playerIndex].lives += 1;
      state.events.push({ t: 'extraLife', playerIndex });
      break;
  }
}

// P-18: destroy every MATERIALIZED enemy for zero points. `byPlayerIndex` is
// deliberately omitted so no player can be credited (fidelity §12); tanks still
// in their spawn animation are untouched, and airborne bullets from the dead keep
// flying (bulletsSystem refunds their owners safely).
function detonateGrenade(state: GameState): void {
  let kills = 0;
  for (const t of state.tanks) {
    if (t.kind !== 'enemy' || !t.alive || t.spawningT > 0) continue;
    t.alive = false;
    kills += 1;
    state.events.push({
      t: 'tankDestroyed',
      tankId: t.id,
      kind: 'enemy',
      enemyType: t.enemyType,
      points: 0,
      x: t.x,
      y: t.y,
    });
  }
  state.events.push({ t: 'grenadeUsed', kills });
}

function findTank(state: GameState, id: number): Tank | undefined {
  for (const t of state.tanks) {
    if (t.id === id) return t;
  }
  return undefined;
}
