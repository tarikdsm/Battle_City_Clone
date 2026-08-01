// src/core/systems/winlose.ts — win/lose evaluation (pipeline system #9, fidelity
// spec §11 + §13 + §3.2). Last in the tick on purpose: every kill, death and life
// change is already settled, so this reads a finished frame and decides whether
// the stage — or the run — is over.
//
// It owns two of the three ways out of 'playing':
//   · stage cleared  — the pool is empty and the field is clear (§11.2)
//   · all lives lost — every ACTIVE player is out (§11.4, P-21)
// The third, the eagle falling, is set by bulletsSystem the instant the shot
// lands (§11.3); the check here is a defensive backstop for any other way the
// eagle could ever be lost.
//
// Order is a rule, not an implementation detail: cleared is evaluated FIRST, so
// the shot that kills the twentieth enemy still clears the stage even when it was
// fired on a last life that runs out in the same tick.
import { PLAYER_INDICES } from './players';
import type { GameState, PlayerIntent } from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

export function winloseSystem(state: GameState, intents: Intents): void {
  void intents; // outcomes come from the field, not from the pad

  if (state.phase !== 'playing') {
    // A stage that has ended keeps no uncollected power-up: fidelity §8 says one
    // persists "until collected or stage end", and this is the stage end. Written
    // as a standing invariant of the ended phases rather than as an action on one
    // transition, so it also covers the eagle path — bulletsSystem flips the
    // phase itself and never sees this system's transition code.
    if (state.phase !== 'intro' && state.powerup !== null) state.powerup = null;
    return;
  }

  if (stageCleared(state)) {
    state.phase = 'cleared';
    state.phaseT = 0;
    state.powerup = null;
    state.events.push({ t: 'stageCleared' });
    return;
  }

  // Backstop: the eagle is gone but nothing moved the phase (§11.3).
  if (!state.eagleAlive) {
    state.phase = 'baseLost';
    state.phaseT = 0;
    state.powerup = null;
    return;
  }

  // P-21: an out player stays out, and the run continues while any active player
  // still has a life or a tank on the field. No base explosion on this path.
  if (allPlayersOut(state)) {
    state.phase = 'gameOver';
    state.phaseT = 0;
    state.powerup = null;
    state.events.push({ t: 'gameOver' });
  }
}

// §11.2: the twentieth enemy is dead. "Alive" includes enemies still twinkling
// through their spawn animation, so a stage cannot clear out from under one that
// is a frame away from materializing.
function stageCleared(state: GameState): boolean {
  if (state.spawner.queue.length > 0) return false;
  for (const t of state.tanks) {
    if (t.kind === 'enemy' && t.alive) return false;
  }
  return true;
}

// Out = no lives in reserve, no tank on the field, and no respawn pending. The
// pending-respawn term is what gives the last death its full second before the
// game-over sequence starts. Inactive slots (the unused P2 of a 1-player game)
// are not players and never hold the run open or close it.
function allPlayersOut(state: GameState): boolean {
  for (const index of PLAYER_INDICES) {
    if (!state.players[index].active) continue;
    if (state.players[index].lives > 0) return false;
    if (state.respawnT[index] > 0) return false;
    for (const t of state.tanks) {
      if (t.kind === 'player' && t.playerIndex === index && t.alive) {
        return false;
      }
    }
  }
  return true;
}
