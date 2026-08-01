// src/core/types.ts — Contract Zero data shapes for the core simulation.
// Types plus a few frozen constant tables only; no logic (the systems live elsewhere).
import type { GameEvent } from './events';

export type Dir = 0 | 1 | 2 | 3; // Up, Right, Down, Left (clockwise)

// Unit direction vectors indexed by Dir. Origin is top-left, so Up is -y.
export const DIR_VECS: readonly (readonly [number, number])[] = [
  [0, -1], // 0 Up
  [1, 0], // 1 Right
  [0, 1], // 2 Down
  [-1, 0], // 3 Left
];

export type EnemyType = 'basic' | 'fast' | 'power' | 'armor';
export type PowerupType =
  'star' | 'helmet' | 'clock' | 'shovel' | 'grenade' | 'tank';

// Level authoring format (v1) — see content doc 05 §1. Kept in core (not
// levels/) so the core stays import-free while game.ts consumes it directly.
export interface LevelData {
  version: 1;
  id: string;
  name: string;
  author?: string;
  terrain: string[];
  partials?: { tx: number; ty: number; mask: number }[];
  enemies: EnemyType[];
  noAutoBase?: boolean;
}

export const Terrain = {
  Empty: 0,
  Brick: 1,
  Steel: 2,
  Water: 3,
  Trees: 4,
  Ice: 5,
} as const;
export type TerrainKind = 0 | 1 | 2 | 3 | 4 | 5;

export interface PlayerIntent {
  dir: Dir | null;
  fire: boolean;
  pause: boolean;
}

// The neutral, do-nothing intent. Frozen so a single shared instance is safe.
export const NULL_INTENT: PlayerIntent = Object.freeze({
  dir: null,
  fire: false,
  pause: false,
});

export interface Tank {
  id: number;
  alive: boolean;
  kind: 'player' | 'enemy';
  playerIndex?: 0 | 1;
  enemyType?: EnemyType;
  spawnOrdinal?: number;
  carrier?: boolean;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  dir: Dir;
  moving: boolean;
  sliding: boolean;
  slideV: number; // residual ice-slide speed (u/s); 0 when not sliding. Hashed.
  hp: number;
  tier: 0 | 1 | 2 | 3;
  shieldT: number;
  stunT: number;
  frozenT: number;
  spawningT: number;
  bulletsAirborne: number;
  // Edge-detect state for firing: the fire-intent value observed last tick. Core
  // fires only on the press edge (fire && !fireHeld); the input layer's turbo
  // pulse is what produces autofire. Updated unconditionally every tick (T1.3).
  fireHeld: boolean;
  // Seconds left on an enemy's AI decision timer (§9). 0 = due, and a decision
  // re-arms it to 0.5..2.0 s. Player tanks keep it at 0. Hashed immediately
  // after fireHeld — it is simulation state, not a cache (T1.6).
  aiTimerT: number;
  // The AI's lattice memory: the tile the tank occupied when the PREVIOUS tick
  // began, per axis. §9 reconsiders when the tank crosses a tile line, and this
  // is the only record of where it came from — prevX/prevY cannot serve, since
  // they are re-stamped for rendering before system #3 ever reads them. Written
  // by aiSystem for every enemy (frozen included) and hashed immediately after
  // aiTimerT, so a future task that stops the AI running breaks a golden replay
  // instead of silently deadening the rule (T1.6).
  aiTileX: number;
  aiTileY: number;
}

export interface Bullet {
  id: number;
  alive: boolean;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  dir: Dir;
  speed: number;
  fromTankId: number;
  byPlayer: boolean;
  playerIndex?: 0 | 1;
  canHurtSteel: boolean;
}

export interface PlayerMeta {
  lives: number;
  score: number;
  nextBonusAt: number;
  destroyedByType: Record<EnemyType, number>;
  active: boolean;
}

export type StagePhase =
  'intro' | 'playing' | 'cleared' | 'baseLost' | 'gameOver';

export interface GameState {
  tick: number;
  rng: { s: number };
  stageNumber: number;
  phase: StagePhase;
  phaseT: number;
  paused: boolean;
  // The pause-intent value observed last tick, per player — the edge-detect state
  // that makes pause a PRESS, not a level (a held button toggles once). Updated
  // unconditionally every tick, including frozen ones, so releasing the button
  // while paused is registered and the next press can unpause. Hashed immediately
  // after `paused` (T1.7).
  pauseHeld: [boolean, boolean];
  terrain: Uint8Array;
  eagleAlive: boolean;
  shovel: { phase: 'off' | 'steel' | 'blink'; t: number };
  clockT: number;
  tanks: Tank[];
  bullets: Bullet[];
  powerup: { type: PowerupType; x: number; y: number } | null;
  players: [PlayerMeta, PlayerMeta];
  // Seconds until each player's tank returns to the field; 0 = not waiting. Armed
  // by playersSystem on death and counted down by stageflowSystem, which does the
  // respawn itself when it reaches 0 and the player still has lives. Hashed
  // immediately after the `players` block, both entries in index order (T1.7).
  respawnT: [number, number];
  spawner: {
    queue: EnemyType[];
    nextOrdinal: number;
    cyclePos: number;
    timerT: number;
    retryT: number;
  };
  events: GameEvent[];
}
