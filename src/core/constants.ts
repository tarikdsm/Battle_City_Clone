// src/core/constants.ts — canonical simulation constants. Lengths in `u`
// (1 tile = 16 u, 1 subcell = 8 u), times in seconds. Values tagged `CAL-nn` are
// calibration placeholders (fidelity spec §16): each keeps its tag so the calibration
// pass can locate and adjust it without changing structure.
import type { EnemyType } from './types';

// --- Grid / geometry ---
export const TILE = 16;
export const SUBCELL = 8;
export const FIELD_TILES = 13;
export const FIELD_SUBCELLS = 26;
export const FIELD_U = 208;
export const TANK_SIZE = 16;
export const BULLET_SIZE = 4;

// --- Time ---
export const TICK_S = 1 / 60;

// --- Speeds (u/s) ---
export const PLAYER_SPEED = 45; // CAL-01
export const ENEMY_SPEED: Record<EnemyType, number> = {
  basic: 30,
  fast: 60,
  power: 45,
  armor: 30,
}; // CAL-03
export const BULLET_SLOW = 120;
export const BULLET_FAST = 240;

// --- Timers (seconds) ---
export const SPAWN_SHIELD_S = 3; // CAL-02
export const STUN_S = 3; // CAL-06
export const HELMET_S = 10; // CAL-15
export const CLOCK_S = 10; // CAL-16
export const SHOVEL_SOLID_S = 17; // CAL-17
export const SHOVEL_BLINK_S = 3; // CAL-17
export const SPAWN_ANIM_S = 1.3; // CAL-12
export const PLAYER_RESPAWN_S = 1;
export const SPAWN_RETRY_S = 0.5;

// --- Physics ---
export const ICE_DECEL = 240; // CAL-05

// --- Spawning ---
export const ENEMY_CAP = 4; // CAL-09
export const ENEMY_TOTAL = 20;
export const CARRIER_ORDINALS: readonly number[] = [4, 11, 18]; // 1-based spawn ordinals

// --- Scoring ---
export const SCORE: Record<EnemyType, number> & { powerup: number } = {
  basic: 100,
  fast: 200,
  power: 300,
  armor: 400,
  powerup: 500,
};
export const BONUS_LIFE_AT = 20000;
export const START_LIVES = 3;
export const ARMOR_HP = 4;

// --- Field layout (tile coords) ---
export const ENEMY_SPAWN_TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [6, 0],
  [12, 0],
]; // cycle order L->C->R  CAL-10
export const P1_SPAWN_TILE: readonly [number, number] = [4, 12];
export const P2_SPAWN_TILE: readonly [number, number] = [8, 12];
export const EAGLE_TILE: readonly [number, number] = [6, 12];
export const BASE_RING_TILES: readonly (readonly [number, number])[] = [
  [5, 11],
  [6, 11],
  [7, 11],
  [5, 12],
  [7, 12],
];

// Ticks between enemy spawn attempts. CAL-11
// = clamp(190 - 4*min(stage,35) - 20*(players-1), 30, 192)  (fidelity spec §7)
export function spawnIntervalTicks(stage: number, players: 1 | 2): number {
  const raw = 190 - 4 * Math.min(stage, 35) - 20 * (players - 1);
  return Math.min(192, Math.max(30, raw));
}
