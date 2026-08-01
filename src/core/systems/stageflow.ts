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
// Stage phases (intro/cleared/baseLost/gameOver) and pause are T1.7's slice and
// extend this same module: they become additional steps around `tickTimers`.
import { SHOVEL_BLINK_S, TICK_S } from '../constants';
import { stampBaseRing } from './powerups';
import { Terrain, type GameState, type PlayerIntent } from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// Countdowns are stored in SECONDS but stepped one TICK_S at a time, so repeated
// subtraction drifts by a few ULPs — 3 s minus 180 ticks lands on 5.7e-15, not 0.
// Treating "within half a tick of zero" as zero makes every effect last an EXACT
// number of ticks (SHOVEL_BLINK_S is 180 ticks, never 181) and stays fully
// deterministic: a still-running timer is always ≳ TICK_S away. Same rule the
// spawner uses for its cadence. Derived from TICK_S — not a magic number.
const HALF_TICK = TICK_S / 2;

export function stageflowSystem(state: GameState, intents: Intents): void {
  void intents; // phases and pause (which do read intents) arrive with T1.7
  tickTankTimers(state);
  tickClock(state);
  tickShovel(state);
}

// One tick off a countdown, snapped to a hard 0 at the end (see HALF_TICK).
function stepDown(t: number): number {
  const next = t - TICK_S;
  return next <= HALF_TICK ? 0 : next;
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
