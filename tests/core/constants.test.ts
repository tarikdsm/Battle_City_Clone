import { describe, expect, it } from 'vitest';
import {
  ARMOR_HP,
  BONUS_LIFE_AT,
  BULLET_FAST,
  CARRIER_ORDINALS,
  ENEMY_CAP_1P,
  ENEMY_CAP_2P,
  ENEMY_SPEED,
  PLAYER_SPEED,
  POWERUP_ROLL_TABLE,
  SCORE,
  START_LIVES,
  TICK_S,
  CLOCK_S,
  HELMET_S,
  SHOVEL_BLINK_S,
  SHOVEL_SOLID_S,
  SPAWN_ANIM_S,
  SPAWN_SHIELD_S,
  STUN_S,
  enemyCap,
  spawnIntervalTicks,
} from '../../src/core/constants';

describe('constants (fidelity spot-checks)', () => {
  it('matches the fidelity tables', () => {
    expect(PLAYER_SPEED).toBe(45);
    expect(ENEMY_SPEED.fast).toBe(60);
    expect(BULLET_FAST).toBe(240);
    expect(CARRIER_ORDINALS).toEqual([4, 11, 18]);
    expect(SCORE.armor).toBe(400);
    expect(BONUS_LIFE_AT).toBe(20000);
    expect(ARMOR_HP).toBe(4);
    expect(START_LIVES).toBe(3);
  });

  // CAL-03 ($DC18..$DC33): the ROM tests only tank type $A0 for the every-frame
  // move tick, so `power` is a HALF-rate tank like basic and armor. Its "fast"
  // trait is the bullet ($E0C2), not the hull.
  it('CAL-03: only the fast enemy moves at 60 u/s', () => {
    expect(ENEMY_SPEED).toEqual({ basic: 30, fast: 60, power: 30, armor: 30 });
  });

  // CAL-09 ($CA6F / $CA74 into `ram_enemy_limit`, scanned down to slot 2 at $DB72).
  it('CAL-09: the on-field enemy cap is 4 in 1P and 6 in 2P', () => {
    expect(ENEMY_CAP_1P).toBe(4);
    expect(ENEMY_CAP_2P).toBe(6);
    expect(enemyCap(1)).toBe(4);
    expect(enemyCap(2)).toBe(6);
  });

  // CAL-14 (tbl_E8FA at $E8FA, indexed by `rand AND #$07`): star and grenade
  // each appear twice in an eight-slot table, so the drop is NOT uniform.
  it('CAL-14: the drop table is eight weighted slots, not six uniform ones', () => {
    expect(POWERUP_ROLL_TABLE).toHaveLength(8);
    const count = (t: string): number =>
      POWERUP_ROLL_TABLE.filter((x) => x === t).length;
    expect(count('star')).toBe(2);
    expect(count('grenade')).toBe(2);
    for (const t of ['helmet', 'clock', 'shovel', 'tank']) {
      expect(count(t)).toBe(1);
    }
  });
});

// Every timer the ROM stores is a whole number of frames; ours must land on a
// whole number of 60 Hz ticks or a countdown would end a tick late and drift the
// goldens. The frame counts are the values read out of the disassembly.
describe('calibrated timers are whole ROM frame counts', () => {
  const ticks = (s: number): number => s / TICK_S;
  it('converts each stored ROM timer to an exact tick count', () => {
    expect(ticks(SPAWN_SHIELD_S)).toBeCloseTo(192, 9); // CAL-02, $E3C1 x 64
    expect(ticks(STUN_S)).toBeCloseTo(267, 9); // CAL-06, $E8AA @ 3-in-4
    expect(ticks(SPAWN_ANIM_S)).toBeCloseTo(56, 9); // CAL-12, $DE55/$DE64
    expect(ticks(HELMET_S)).toBeCloseTo(640, 9); // CAL-15, $E9F0 x 64
    expect(ticks(CLOCK_S)).toBeCloseTo(640, 9); // CAL-16, $E9F5 x 64
    expect(ticks(SHOVEL_SOLID_S)).toBeCloseTo(1088, 9); // CAL-17, 17 x 64
    expect(ticks(SHOVEL_BLINK_S)).toBeCloseTo(192, 9); // CAL-17, 3 x 64
  });
});

// CAL-11, confirmed instruction for instruction at $C39E. The ROM has no clamp:
// over stages 1..35 and 1..2 players the raw expression already spans exactly
// [30, 186], so ours only guards out-of-range input from the editor.
describe('spawnIntervalTicks (CAL-11)', () => {
  it('follows 190 - 4*min(stage,35) - 20*(players-1) frames', () => {
    expect(spawnIntervalTicks(1, 1)).toBe(186);
    expect(spawnIntervalTicks(35, 1)).toBe(50);
    expect(spawnIntervalTicks(1, 2)).toBe(166);
    expect(spawnIntervalTicks(99, 1)).toBe(50); // stage term capped at 35
  });

  it('bottoms out at the ROM minimum of 30 ticks (stage 35, 2P)', () => {
    expect(spawnIntervalTicks(35, 2)).toBe(30);
  });

  it('never needs either clamp for a real stage', () => {
    for (let stage = 1; stage <= 35; stage++) {
      for (const players of [1, 2] as const) {
        const raw = 190 - 4 * stage - 20 * (players - 1);
        expect(spawnIntervalTicks(stage, players)).toBe(raw);
        expect(raw).toBeGreaterThanOrEqual(30);
        expect(raw).toBeLessThanOrEqual(186);
      }
    }
  });

  it('clamps to the ceiling of 192 ticks (3.2s)', () => {
    // Real stages (>=1) never reach the ceiling (max is 186 at stage 1, 1P);
    // a synthetic out-of-range stage exercises the upper clamp guard.
    expect(spawnIntervalTicks(-1, 1)).toBe(192);
  });
});
