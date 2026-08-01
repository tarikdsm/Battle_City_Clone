// src/core/systems/players.ts — per-player bookkeeping (pipeline system #8,
// fidelity spec §3.1 + §12 + §3.2). It reads THIS tick's events and nothing else:
// bullets (system #6) and power-ups (system #7) have already run, so every kill
// and pickup they announced is sitting in `state.events` waiting to be priced.
//
// Three passes, in this order:
//   1. deaths   — a destroyed player costs a life and arms its respawn timer
//   2. scoring  — enemy kills and pickups pay the player who caused them
//   3. bonus    — 20,000 points buys one extra life, once per player (§12)
//
// The order matters only between 2 and 3: the bonus is evaluated after every
// addition this tick, so a single kill that crosses the line is caught on the
// same tick it happens. Deaths are independent of both.
//
// This module also owns the SHAPE of a player tank — `createPlayerTank` for
// createGame and `respawnPlayerTank` for the stage-flow respawn — so the two can
// never drift into producing different tanks. Allocation-free in steady state:
// every pass is an index loop over the event array.
import {
  P1_SPAWN_TILE,
  P2_SPAWN_TILE,
  PLAYER_RESPAWN_S,
  SCORE,
  SPAWN_SHIELD_S,
  TILE,
} from '../constants';
import { makeTank } from './movement';
import type { GameState, PlayerIntent, Tank } from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// Spawn tiles indexed by playerIndex, so both the factory and the respawn read
// the same table instead of branching on the index.
const SPAWN_TILES: readonly (readonly [number, number])[] = [
  P1_SPAWN_TILE,
  P2_SPAWN_TILE,
];

// The two player slots, as a frozen table: iterating it keeps the index typed as
// `0 | 1` without a cast and without allocating a fresh array every tick. Shared
// with winlose.ts, which walks the same slots.
export const PLAYER_INDICES: readonly (0 | 1)[] = [0, 1];

// --- Player tanks ----------------------------------------------------------

// The tank for `playerIndex`, in its canonical fresh state. `alive` is false for
// the unused second slot of a 1-player game: the slot still exists (so the tank
// array index, the tank id and the player index stay the same number forever, and
// the spawner's enemy-slot recycling can never claim it), it simply never plays.
export function createPlayerTank(playerIndex: 0 | 1, alive: boolean): Tank {
  const tile = SPAWN_TILES[playerIndex];
  return makeTank({
    id: playerIndex,
    kind: 'player',
    playerIndex,
    alive,
    x: tile[0] * TILE,
    y: tile[1] * TILE,
    dir: 0, // facing up (§3.1)
    shieldT: SPAWN_SHIELD_S,
  });
}

// Return a dead player tank to its spawn tile. Every field that can change during
// a life is overwritten, so nothing leaks across the death — the tier reset (P-03)
// is exactly this, not a special case.
//
// prevX/prevY are re-anchored to the new position on purpose: a respawn is a
// teleport, and leaving prev at the place the tank died would make the renderer
// lerp it across the whole field for one frame. The enemy spawner's slot reuse
// (spawner.ts resetEnemyTank) re-anchors for the same reason.
export function respawnPlayerTank(tank: Tank, playerIndex: 0 | 1): void {
  const tile = SPAWN_TILES[playerIndex];
  const x = tile[0] * TILE;
  const y = tile[1] * TILE;
  tank.alive = true;
  tank.x = x;
  tank.y = y;
  tank.prevX = x;
  tank.prevY = y;
  tank.dir = 0;
  tank.moving = false;
  tank.sliding = false;
  tank.slideV = 0;
  tank.hp = 1;
  tank.tier = 0; // P-03: every star is lost on death
  tank.shieldT = SPAWN_SHIELD_S;
  tank.stunT = 0;
  tank.frozenT = 0;
  tank.spawningT = 0;
  tank.bulletsAirborne = 0;
  tank.fireHeld = false;
  tank.aiTimerT = 0;
  tank.aiTileX = Math.floor(x / TILE);
  tank.aiTileY = Math.floor(y / TILE);
}

// --- System ----------------------------------------------------------------

export function playersSystem(state: GameState, intents: Intents): void {
  void intents; // this system reads events, never input — control gating is stepGame's
  applyDeaths(state);
  applyScores(state);
  applyBonusLives(state);
}

// 1 — a player tank destroyed this tick. bulletsSystem already flipped `alive`;
// what is left is the life and the respawn clock. stageflowSystem performs the
// respawn itself when the clock runs out, and refuses it at 0 lives — so a player
// on its last life still spends the full timer before the game can end.
function applyDeaths(state: GameState): void {
  const n = state.events.length;
  for (let i = 0; i < n; i++) {
    const e = state.events[i];
    if (e.t !== 'tankDestroyed' || e.kind !== 'player') continue;
    const index = playerIndexOfTank(state, e.tankId);
    if (index === undefined) continue;
    state.players[index].lives -= 1;
    state.respawnT[index] = PLAYER_RESPAWN_S;
  }
}

// 2 — P-19, fidelity §12. An enemy kill pays the player whose bullet landed it;
// `byPlayerIndex` is the credit, and a grenade deliberately omits it (P-18), so
// its kills fall out here with no points and no tally entry. A pickup pays a flat
// SCORE.powerup to whoever walked into it.
function applyScores(state: GameState): void {
  const n = state.events.length; // snapshot: scoreAwarded appends to this array
  for (let i = 0; i < n; i++) {
    const e = state.events[i];
    if (e.t === 'tankDestroyed') {
      if (e.kind !== 'enemy' || e.byPlayerIndex === undefined) continue;
      const p = state.players[e.byPlayerIndex];
      p.score += e.points;
      if (e.enemyType !== undefined) p.destroyedByType[e.enemyType] += 1;
      state.events.push({
        t: 'scoreAwarded',
        playerIndex: e.byPlayerIndex,
        points: e.points,
        x: e.x,
        y: e.y,
      });
    } else if (e.t === 'powerupCollected') {
      state.players[e.playerIndex].score += SCORE.powerup;
      state.events.push({
        t: 'scoreAwarded',
        playerIndex: e.playerIndex,
        points: SCORE.powerup,
        x: e.x,
        y: e.y,
      });
    }
  }
}

// 3 — P-20: one bonus life per player, at 20,000 cumulative points (§12). Retiring
// the threshold to +Infinity is what makes it once-per-RUN rather than once-per-
// crossing; hashing a non-finite float is fine (its f64 bits are stable).
//
// The `active` guard is load-bearing, not defensive: an inactive slot starts with
// nextBonusAt 0, and 0 >= 0 would hand a free life to a player who is not even in
// the game.
function applyBonusLives(state: GameState): void {
  for (const index of PLAYER_INDICES) {
    const p = state.players[index];
    if (!p.active || p.score < p.nextBonusAt) continue;
    p.lives += 1;
    p.nextBonusAt = Number.POSITIVE_INFINITY;
    state.events.push({ t: 'extraLife', playerIndex: index });
  }
}

// The player slot a tank id belongs to. Player tanks live in slots 0/1 with
// id === index === playerIndex, but the lookup is by id so nothing here depends
// on that layout holding.
function playerIndexOfTank(state: GameState, id: number): 0 | 1 | undefined {
  for (const t of state.tanks) {
    if (t.id === id) return t.kind === 'player' ? t.playerIndex : undefined;
  }
  return undefined;
}
