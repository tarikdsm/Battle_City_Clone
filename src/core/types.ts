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
  hp: number;
  tier: 0 | 1 | 2 | 3;
  shieldT: number;
  stunT: number;
  frozenT: number;
  spawningT: number;
  bulletsAirborne: number;
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
  terrain: Uint8Array;
  eagleAlive: boolean;
  shovel: { phase: 'off' | 'steel' | 'blink'; t: number };
  clockT: number;
  tanks: Tank[];
  bullets: Bullet[];
  powerup: { type: PowerupType; x: number; y: number } | null;
  players: [PlayerMeta, PlayerMeta];
  spawner: {
    queue: EnemyType[];
    nextOrdinal: number;
    cyclePos: number;
    timerT: number;
    retryT: number;
  };
  events: GameEvent[];
}
