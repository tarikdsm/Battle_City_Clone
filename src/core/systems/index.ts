// src/core/systems/index.ts — the nine per-tick systems, invoked by stepGame in
// this exact fixed order (arch §3.2). They are no-ops for now; tasks T1.2–T1.8
// fill in the bodies. Every system shares one signature so the call sites in
// game.ts never change as the logic lands.
import type { GameState, PlayerIntent } from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// 1. stage phase & timers (intro/clear/gameover, shovel, clock, shields, stun)
export function stageflowSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 2. enemy spawn starts / materializations
export function spawnerSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 3. AI decisions -> enemy intents
export function aiSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 4. tank movement (players then enemies, index order; turn-snap; ice) — T1.2.
// Delegated to ./movement; the exported name/signature stays identical so the
// call site in game.ts never changes.
export { movementSystem } from './movement';

// 5. firing (spawn bullets)
export function firingSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 6. bullet advance (swept) + collisions (bullet/bullet, bullet/tank, bullet/terrain)
export function bulletsSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 7. power-up spawn / pickup
export function powerupsSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 8. score / lives / bonus-life bookkeeping
export function playersSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}

// 9. win / lose evaluation
export function winloseSystem(state: GameState, intents: Intents): void {
  void state;
  void intents;
}
