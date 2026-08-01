// src/core/systems/stageflow.ts — pipeline system #1.
//
// Scope today (T1.5): the EFFECT TIMERS only — every countdown that a later
// system reads as a gate. Running first means each system downstream sees the
// value for the tick it is acting on, and a timer set by system #7 (a power-up
// pickup) survives its whole first tick before losing a slice.
//
// Order inside the tick:
//   1. per-tank timers: shieldT, stunT, frozenT   (spawningT belongs to the
//      spawner, system #2 — deliberately not touched here)
//   2. the Clock countdown, emitting `clockEnded` exactly once
//   3. the Shovel state machine: steel → blink → off (+ ring repair)
//
// T1.7 added the rest of the tick's clockwork to the same module, run AFTER the
// effect timers above:
//   4. the stage phase clock (`phaseT`) and the intro → playing → … machine
//   5. the per-player respawn countdowns, and the respawn itself
// Pause is deliberately NOT here: it has to suppress this system too, so it lives
// at the top of `stepGame`, which returns before any system runs.
//
// Every countdown below is stepped with the shared `stepDown` helper from
// constants.ts — the same HALF_TICK zero-threshold the spawner's cadence compares
// against — so an effect armed with a whole multiple of TICK_S lasts exactly that
// many ticks (SHOVEL_BLINK_S is 180 ticks, never 181) and no effect is ever
// shortened by the snap.
import {
  GAME_OVER_DELAY_S,
  HALF_TICK,
  SHOVEL_BLINK_S,
  STAGE_INTRO_S,
  TICK_S,
  stepDown,
} from '../constants';
import { PLAYER_INDICES, respawnPlayerTank } from './players';
import { stampBaseRing } from './powerups';
import {
  Terrain,
  type GameState,
  type PlayerIntent,
  type Tank,
} from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

export function stageflowSystem(state: GameState, intents: Intents): void {
  void intents; // pause is the only intent-driven part of stage flow, and it lives in stepGame
  tickTankTimers(state);
  tickClock(state);
  tickShovel(state);
  tickPhase(state);
  tickRespawns(state);
}

function tickTankTimers(state: GameState): void {
  for (const t of state.tanks) {
    if (!t.alive) continue;
    if (t.shieldT > 0) t.shieldT = stepDown(t.shieldT);
    if (t.stunT > 0) t.stunT = stepDown(t.stunT);
    if (t.frozenT > 0) t.frozenT = stepDown(t.frozenT);
  }
}

// P-17: enemies frozen by the Clock hold `frozenT` equal to `clockT`, so they run
// down in lockstep and thaw on the very tick the Clock ends.
function tickClock(state: GameState): void {
  if (state.clockT <= 0) return;
  state.clockT = stepDown(state.clockT);
  if (state.clockT === 0) state.events.push({ t: 'clockEnded' });
}

// P-16: 17 s of solid steel, then 3 s of blinking warning, then back to a fully
// repaired brick ring. A transition arms the next phase's timer without also
// spending a tick of it — exactly like a fresh pickup.
function tickShovel(state: GameState): void {
  const shovel = state.shovel;
  if (shovel.phase === 'off') return;

  shovel.t = stepDown(shovel.t);
  if (shovel.t > 0) return;

  if (shovel.phase === 'steel') {
    shovel.phase = 'blink';
    shovel.t = SHOVEL_BLINK_S;
    state.events.push({ t: 'shovelPhase', phase: 'blink' });
    return;
  }

  shovel.phase = 'off';
  shovel.t = 0;
  stampBaseRing(state, Terrain.Brick);
  state.events.push({ t: 'shovelPhase', phase: 'revert' });
}

// --- Stage phases (fidelity §11, §13) --------------------------------------

// `phaseT` counts UP, so it needs the mirror of `stepDown`'s zero snap: 120
// additions of TICK_S sum to 1.9999999999999978, not 2, and a bare `>=` would
// stretch every 2 s phase to 121 ticks. Comparing with HALF_TICK of slack — the
// SAME determinism-critical threshold constants.ts defines for the countdowns —
// makes a phase last exactly `limit / TICK_S` ticks. This is baked into golden
// replays: the tick a phase flips on is part of the recorded run.
function reached(t: number, limit: number): boolean {
  return t + HALF_TICK >= limit;
}

// The phase clock always runs (a paused tick never gets here at all), then the
// machine acts on it. Only two transitions are timed: the intro curtain and the
// game-over delay after the eagle falls. 'playing' → 'cleared'/'gameOver' is
// winloseSystem's call, and 'cleared'/'gameOver' are terminal for the core — the
// app layer loads the next stage or returns to the title.
function tickPhase(state: GameState): void {
  state.phaseT += TICK_S;

  if (state.phase === 'intro') {
    if (!reached(state.phaseT, STAGE_INTRO_S)) return;
    state.phase = 'playing';
    state.phaseT = 0;
    return;
  }

  if (state.phase === 'baseLost') {
    if (!reached(state.phaseT, GAME_OVER_DELAY_S)) return;
    state.phase = 'gameOver';
    state.phaseT = 0;
    state.events.push({ t: 'gameOver' });
  }
}

// --- Player respawns (fidelity §3.1) ---------------------------------------

// A dead player's clock, armed by playersSystem. When it runs out the tank comes
// back — unless the player is out of lives (it then simply stays dead, and
// winloseSystem reads that as an out player) or the run is already over.
//
// Running here, before every other system, means the returning tank has its full
// shield for the whole tick it reappears on: `tickTankTimers` above has already
// been past, so nothing docks the freshly-armed SPAWN_SHIELD_S until next tick —
// exactly like a power-up picked up in system #7.
function tickRespawns(state: GameState): void {
  const stopped = state.phase === 'gameOver' || state.phase === 'baseLost';
  for (const index of PLAYER_INDICES) {
    if (state.respawnT[index] <= 0) continue;
    state.respawnT[index] = stepDown(state.respawnT[index]);
    if (state.respawnT[index] > 0) continue;
    if (stopped || state.players[index].lives <= 0) continue;
    const tank = playerTank(state, index);
    if (tank === undefined) continue;
    respawnPlayerTank(tank, index);
    state.events.push({
      t: 'playerSpawned',
      playerIndex: index,
      x: tank.x,
      y: tank.y,
    });
  }
}

function playerTank(state: GameState, index: 0 | 1): Tank | undefined {
  for (const t of state.tanks) {
    if (t.kind === 'player' && t.playerIndex === index) return t;
  }
  return undefined;
}
