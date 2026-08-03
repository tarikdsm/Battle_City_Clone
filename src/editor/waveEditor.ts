// src/editor/waveEditor.ts — the 20-slot enemy wave (arch §9, fidelity §3.2).
//
// The whole file exists to make one distinction impossible to blur:
//
//   the **types** in a wave are data — the author picks all twenty;
//   the **carriers** are a rule — the 4th, 11th and 18th spawns, always.
//
// Content §1 says it outright ("Carrier positions are **not** data"), and core's
// spawner derives them from the spawn ordinal rather than reading anything off
// the level. So this module exposes carriers as a *computed* property of a slot
// and offers no way to set one. An editor that let an author drag a carrier
// marker would be promising something the simulation would then ignore, which
// is worse than not offering it: the level would play differently from the way
// it was drawn, and nothing would say why.
//
// Pure and DOM-free (tests run in the node environment).

import type { EnemyType } from '../core/types';

/** Enemies per stage (fidelity §3.2). */
export const WAVE_SIZE = 20;

/** Spawn ordinals (1-based) that arrive flashing and drop a power-up. */
export const CARRIER_ORDINALS: readonly number[] = Object.freeze([4, 11, 18]);

/** The four types, in the order the picker cycles them. */
export const ENEMY_TYPES: readonly EnemyType[] = Object.freeze([
  'basic',
  'fast',
  'power',
  'armor',
]);

/** Display labels for the picker. English sentence case. */
export const ENEMY_LABELS: Readonly<Record<EnemyType, string>> = Object.freeze({
  basic: 'Basic',
  fast: 'Fast',
  power: 'Power',
  armor: 'Armor',
});

export interface WaveSlot {
  /** 0-based position in `LevelData.enemies`. */
  index: number;
  /** 1-based spawn order, which is what fidelity §3.2 counts. */
  ordinal: number;
  type: EnemyType;
  /** Derived from {@link CARRIER_ORDINALS}. There is no setter. */
  carrier: boolean;
}

/** 0-based indices of the carrier slots: `[3, 10, 17]`. */
export function carrierSlots(): number[] {
  return CARRIER_ORDINALS.map((o) => o - 1);
}

export function isCarrierSlot(index: number): boolean {
  return CARRIER_ORDINALS.includes(index + 1);
}

/** The wave as the editor renders it. Reflects what is there, valid or not. */
export function waveSlots(enemies: readonly EnemyType[]): WaveSlot[] {
  return enemies.map((type, index) => ({
    index,
    ordinal: index + 1,
    type,
    carrier: isCarrierSlot(index),
  }));
}

/** Set one slot. Out-of-range is ignored rather than throwing: a click on a
 *  stale row should not take the screen down. */
export function setSlotType(
  enemies: readonly EnemyType[],
  index: number,
  type: EnemyType,
): EnemyType[] {
  if (index < 0 || index >= enemies.length) {
    return [...enemies];
  }
  const next = [...enemies];
  next[index] = type;
  return next;
}

/** Step a slot through {@link ENEMY_TYPES}, wrapping in both directions. */
export function cycleSlotType(
  enemies: readonly EnemyType[],
  index: number,
  delta: number,
): EnemyType[] {
  if (index < 0 || index >= enemies.length) {
    return [...enemies];
  }
  const n = ENEMY_TYPES.length;
  const at = ENEMY_TYPES.indexOf(enemies[index]);
  const next = ((((at < 0 ? 0 : at) + delta) % n) + n) % n;
  return setSlotType(enemies, index, ENEMY_TYPES[next]);
}

/**
 * Set this slot and every slot after it.
 *
 * Twenty pickers is twenty clicks for "the back half is armor", which is the
 * single most common thing the originals do (stage 35's wave is four power,
 * six fast, ten armor). This is the affordance that makes authoring a wave a
 * few actions rather than twenty.
 */
export function fillFrom(
  enemies: readonly EnemyType[],
  index: number,
  type: EnemyType,
): EnemyType[] {
  const next = [...enemies];
  for (let i = Math.max(0, index); i < next.length; i++) {
    next[i] = type;
  }
  return next;
}

export function waveCounts(
  enemies: readonly EnemyType[],
): Record<EnemyType, number> {
  const counts: Record<EnemyType, number> = {
    basic: 0,
    fast: 0,
    power: 0,
    armor: 0,
  };
  for (const e of enemies) {
    if (e in counts) {
      counts[e] += 1;
    }
  }
  return counts;
}
