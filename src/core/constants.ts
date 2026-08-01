// src/core/constants.ts — canonical simulation constants. Lengths in `u`
// (1 tile = 16 u, 1 subcell = 8 u), times in seconds. Values tagged `CAL-nn` are
// calibration placeholders (fidelity spec §16): each keeps its tag so the calibration
// pass can locate and adjust it without changing structure.
import type { EnemyType, PowerupType } from './types';

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

// Countdowns are stored in SECONDS but stepped one TICK_S at a time, so repeated
// subtraction drifts by a few ULPs — 3 s minus 180 ticks lands on 5.7e-15, not 0.
// HALF_TICK is the ONE shared "this countdown has reached zero" threshold: a still
// running timer is always ≳ TICK_S away from it, a finished one ≲ 0. It is
// determinism-critical (`<=` vs `<` here shifts exact tick counts, and therefore
// every golden replay), so it is defined exactly once and imported by both the
// spawner's cadence comparison and the effect timers below.
export const HALF_TICK = TICK_S / 2;

// One tick off a countdown, snapped to a hard 0 at the end (see HALF_TICK). A
// timer armed with a whole multiple of TICK_S therefore lasts EXACTLY that many
// ticks — never one more because of accumulated float error, and never one fewer.
export function stepDown(t: number): number {
  const next = t - TICK_S;
  return next <= HALF_TICK ? 0 : next;
}

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

// --- Power-ups ---
// The canonical order of the six types. Replay-canonical in two ways: it is the
// order `nextInt(rng, 6)` indexes when a carrier drops one (fidelity §8), and it
// is the index order the state hash writes. Reordering it changes every seeded
// run, so it lives here once rather than in each consumer.
export const POWERUP_TYPES: readonly PowerupType[] = [
  'star',
  'helmet',
  'clock',
  'shovel',
  'grenade',
  'tank',
];

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

// The campaign loops after stage 35 but the internal counter keeps rising, so
// every stage-scaled formula clamps its stage term here (fidelity §7, §9, §11).
export const STAGE_CAP = 35;

// Ticks between enemy spawn attempts. CAL-11
// = clamp(190 - 4*min(stage,35) - 20*(players-1), 30, 192)  (fidelity spec §7)
export function spawnIntervalTicks(stage: number, players: 1 | 2): number {
  const raw = 190 - 4 * Math.min(stage, STAGE_CAP) - 20 * (players - 1);
  return Math.min(192, Math.max(30, raw));
}

// --- Enemy AI ---
// [FEEL] fidelity §9. The NES AI is not documented at instruction level; this is
// a perceived-equivalent reconstruction, and the calibration pass (§16) tunes
// these numbers against reference footage until blind side-by-side review can't
// tell them apart. What is NOT tunable is the structure they plug into: the
// per-tick rng draw order (lattice roll → weighted pick → uniform fallback →
// timer reset → fire roll) is what every golden replay bakes in, so changing a
// value here rewrites recorded runs while changing the order breaks them.
export const AI_W_KEEP = 0.4; // weight: keep the current direction
export const AI_W_BASE_BASE = 0.2; // weight: turn toward the eagle, at stage 0
export const AI_W_BASE_PER_STAGE = 0.005; // …+ per stage (stage term capped at STAGE_CAP)
export const AI_W_BASE_MAX = 0.4; // …and never above this
export const AI_W_PLAYER = 0.1; // weight: turn toward the nearest player
// Everything left over goes to a uniform pick among the open directions.

export const AI_LATTICE_RECONSIDER = 0.25; // P(reconsider) when a tile line is crossed
export const AI_TIMER_MIN = 0.5; // decision timer = MIN + rand*SPAN → 0.5..2.0 s
export const AI_TIMER_SPAN = 1.5;

export const AI_FIRE_ALIGNED_PS = 0.9; // shots/s while lined up on a target
export const AI_FIRE_RANDOM_PS = 0.4; // shots/s otherwise
export const AI_ALIGN_TOLERANCE = 6; // max lateral centre offset (u) to count as lined up
