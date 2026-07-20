import { describe, expect, it } from 'vitest';
import {
  ARMOR_HP,
  BONUS_LIFE_AT,
  BULLET_FAST,
  CARRIER_ORDINALS,
  ENEMY_CAP,
  ENEMY_SPEED,
  PLAYER_SPEED,
  SCORE,
  START_LIVES,
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
    expect(ENEMY_CAP).toBe(4);
    expect(START_LIVES).toBe(3);
  });
});

describe('spawnIntervalTicks (CAL-11)', () => {
  it('follows clamp(190 - 4*min(stage,35) - 20*(players-1), 30, 192)', () => {
    expect(spawnIntervalTicks(1, 1)).toBe(186);
    expect(spawnIntervalTicks(35, 1)).toBe(50);
    expect(spawnIntervalTicks(1, 2)).toBe(166);
    expect(spawnIntervalTicks(99, 1)).toBe(50); // stage term capped at 35
  });

  it('clamps to the floor of 30 ticks (0.5s)', () => {
    expect(spawnIntervalTicks(35, 2)).toBe(30);
  });

  it('clamps to the ceiling of 192 ticks (3.2s)', () => {
    // Real stages (>=1) never reach the ceiling (max is 186 at stage 1, 1P);
    // a synthetic out-of-range stage exercises the upper clamp guard.
    expect(spawnIntervalTicks(-1, 1)).toBe(192);
  });
});
