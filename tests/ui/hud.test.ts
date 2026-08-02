// tests/ui/hud.test.ts — the HUD's model (GDD §9, art §10).
//
// Node environment, no DOM: `hudModel` is the pure half of `src/ui/hud.ts`, so
// everything the HUD *says* is testable here and only how it *looks* needs a
// screenshot. The rule the whole file rests on: the HUD derives from
// `GameState`, never from a running total of its own — a HUD that counted
// events would drift the moment one was missed.

import { describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import { ENEMY_TOTAL, START_LIVES } from '../../src/core/constants';
import {
  NULL_INTENT,
  type GameState,
  type LevelData,
} from '../../src/core/types';
import { LIFE_PIPS, TIER_PIPS, hudModel } from '../../src/ui/hud';
import basic from '../fixtures/level-basic.json';

const LEVEL = basic as unknown as LevelData;

function game(players: 1 | 2 = 1, stageNumber = 1): GameState {
  return createGame(LEVEL, { players, seed: 20_260_802, stageNumber });
}

describe('the enemy grid (GDD §9)', () => {
  it('starts at twenty icons, none spent', () => {
    const view = hudModel(game());
    expect(view.enemiesLeft).toBe(ENEMY_TOTAL);
    expect(view.spent).toHaveLength(ENEMY_TOTAL);
    expect(view.spent.filter(Boolean)).toHaveLength(0);
  });

  it('decrements on the tick a spawn STARTS, not when the tank materializes', () => {
    // GDD §9: "an icon is consumed when a spawn begins (star animation start),
    // as in the NES". The spawner shifts the queue on the tick it emits
    // `enemySpawnStarted`, and the model reads the queue — so the two cannot
    // disagree, whatever happens to the tank afterwards.
    const state = game();
    expect(hudModel(state).enemiesLeft).toBe(ENEMY_TOTAL);

    stepGame(state, [NULL_INTENT, NULL_INTENT]); // fidelity §11.1: first spawn at t = 0
    const started = state.events.some((e) => e.t === 'enemySpawnStarted');
    expect(started, 'expected the first spawn on tick 1').toBe(true);
    expect(hudModel(state).enemiesLeft).toBe(ENEMY_TOTAL - 1);
    // …and the tank is still twinkling, not on the field.
    expect(state.tanks.some((t) => t.kind === 'enemy' && t.spawningT > 0)).toBe(
      true,
    );
  });

  it('spends icons from the front, so the grid empties in one direction', () => {
    const state = game();
    for (let i = 0; i < 600; i++) {
      stepGame(state, [NULL_INTENT, NULL_INTENT]);
    }
    const view = hudModel(state);
    const spentCount = ENEMY_TOTAL - view.enemiesLeft;
    expect(spentCount).toBeGreaterThan(0);
    for (let i = 0; i < ENEMY_TOTAL; i++) {
      expect(view.spent[i]).toBe(i >= view.enemiesLeft);
    }
  });

  it('reads an emptied pool as every icon spent', () => {
    const state = game();
    state.spawner.queue.length = 0;
    const view = hudModel(state);
    expect(view.enemiesLeft).toBe(0);
    expect(view.spent.every(Boolean)).toBe(true);
  });
});

describe('the per-player card (GDD §9, fidelity §3.1)', () => {
  it('starts at three lives, no stars, zero score', () => {
    const p = hudModel(game()).players[0];
    expect(p.active).toBe(true);
    expect(p.lives).toBe(START_LIVES);
    expect(p.pips).toBe(START_LIVES);
    expect(p.overflow).toBe(0);
    expect(p.tier).toBe(0);
    expect(p.score).toBe(0);
  });

  it('hides the second player in a 1P run rather than showing a dead one', () => {
    expect(hudModel(game(1)).players[1].active).toBe(false);
    expect(hudModel(game(2)).players[1].active).toBe(true);
  });

  it('tracks the score and the star tier from state', () => {
    const state = game();
    state.players[0].score = 12_345;
    state.tanks[0].tier = 3;
    const p = hudModel(state).players[0];
    expect(p.score).toBe(12_345);
    expect(p.tier).toBe(3);
    expect(p.tier).toBeLessThanOrEqual(TIER_PIPS);
  });

  it('reads each player’s own tier, not the first tank’s', () => {
    const state = game(2);
    state.tanks[0].tier = 1;
    state.tanks[1].tier = 3;
    const view = hudModel(state);
    expect(view.players[0].tier).toBe(1);
    expect(view.players[1].tier).toBe(3);
  });

  it('draws lives as pips, and overflows past the pip count', () => {
    // The Tank power-up (fidelity §8) can push lives past what fits, so the
    // card shows what it can and counts the rest.
    const state = game();
    state.players[0].lives = LIFE_PIPS;
    expect(hudModel(state).players[0]).toMatchObject({
      pips: LIFE_PIPS,
      overflow: 0,
    });

    state.players[0].lives = LIFE_PIPS + 3;
    expect(hudModel(state).players[0]).toMatchObject({
      pips: LIFE_PIPS,
      overflow: 3,
    });
  });

  it('never draws a negative pip count for an out player', () => {
    const state = game();
    state.players[0].lives = 0;
    const p = hudModel(state).players[0];
    expect(p.lives).toBe(0);
    expect(p.pips).toBe(0);
    expect(p.overflow).toBe(0);
  });

  it('follows a real death through the simulation', () => {
    // Not a hand-written number: kill the tank the way the game does and let
    // the systems settle, then assert the HUD reads what core decided.
    const state = game();
    for (let i = 0; i < 130; i++) {
      stepGame(state, [NULL_INTENT, NULL_INTENT]);
    }
    const before = hudModel(state).players[0].lives;
    const tank = state.tanks[0];
    tank.alive = false;
    tank.shieldT = 0;
    state.players[0].lives = before - 1;
    const after = hudModel(state).players[0];
    expect(after.lives).toBe(before - 1);
    expect(after.pips).toBe(before - 1);
  });
});

describe('the stage number (fidelity §11.5)', () => {
  it('defaults to core’s own', () => {
    expect(hudModel(game(1, 7)).stage).toBe(7);
  });

  it('shows the LOOPED number when one is given', () => {
    // After stage 35 the two numbers stop being the same: core keeps rising so
    // the spawn cadence keeps tightening, while the player is told stage 1.
    const state = game(1, 36);
    expect(hudModel(state).stage).toBe(36);
    expect(hudModel(state, 1).stage).toBe(1);
    expect(state.stageNumber).toBe(36);
  });
});
