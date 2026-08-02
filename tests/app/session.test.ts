// tests/app/session.test.ts — T6.2's campaign model.
//
// The session is what survives a stage: the ever-rising internal stage counter
// (fidelity §11.5), the per-run carryover (§12), and the arcade high-score table
// (§13). All of it is DOM-free and node-testable — the screens that present it
// are verified by screenshot.
//
// The rule this file is written around: **core already implements the rules.**
// Nothing here re-derives scoring, lives or phases; it asserts that the session
// carries core's numbers from one `createGame` to the next without loss.

import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, stepGame } from '../../src/core/game';
import {
  BONUS_LIFE_AT,
  SCORE,
  START_LIVES,
  STAGE_CAP,
  spawnIntervalTicks,
} from '../../src/core/constants';
import {
  NULL_INTENT,
  type GameState,
  type LevelData,
} from '../../src/core/types';
import {
  HI_SCORE_SEED,
  MAX_SCORES,
  STAGE_LOOP,
  absorbStage,
  advanceStage,
  applyCarry,
  applyInitials,
  createInitials,
  createSession,
  initialsText,
  insertScore,
  levelStageOf,
  loadProgress,
  qualifies,
  seedScores,
  stageTally,
  unlockStage,
  type Session,
} from '../../src/app/session';
import { loadScores, saveScores, type ScoreEntry } from '../../src/app/storage';
import basic from '../fixtures/level-basic.json';

function installStorage(
  seed: Record<string, string> = {},
): Map<string, string> {
  const map = new Map<string, string>(Object.entries(seed));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
  };
  return map;
}

const LEVEL = basic as unknown as LevelData;

function game(session: Session): GameState {
  const state = createGame(LEVEL, {
    players: session.players,
    seed: session.seed,
    stageNumber: session.stageNumber,
  });
  applyCarry(state, session);
  return state;
}

beforeEach(() => {
  installStorage();
});

describe('stage progression (fidelity §11.5, GDD §4)', () => {
  it('maps the internal counter onto the 35-stage loop', () => {
    expect(levelStageOf(1)).toBe(1);
    expect(levelStageOf(35)).toBe(35);
    expect(levelStageOf(36)).toBe(1); // "loops to stage 1"
    expect(levelStageOf(70)).toBe(35);
    expect(levelStageOf(71)).toBe(1);
    expect(STAGE_LOOP).toBe(35);
  });

  it('keeps the internal counter rising past the loop', () => {
    const s = createSession({ stageNumber: 34 });
    advanceStage(s);
    expect(s.stageNumber).toBe(35);
    advanceStage(s);
    expect(s.stageNumber).toBe(36);
    expect(levelStageOf(s.stageNumber)).toBe(1);
    for (let i = 0; i < 40; i++) {
      advanceStage(s);
    }
    expect(s.stageNumber).toBe(76);
    expect(levelStageOf(s.stageNumber)).toBe(6);
  });

  it('hands core the rising counter, whose spawn term core caps at 35', () => {
    // P-25. The session must NOT cap: capping here would make stage 36 play
    // like stage 1. The cap belongs to the formula, and it already lives there.
    const atLoop = spawnIntervalTicks(36, 1);
    expect(atLoop).toBe(spawnIntervalTicks(STAGE_CAP, 1));
    expect(atLoop).toBeLessThan(spawnIntervalTicks(1, 1));
  });

  it('persists the highest LOOPED stage as progress, and never lowers it', () => {
    unlockStage(12);
    expect(loadProgress().highestStage).toBe(12);
    unlockStage(4);
    expect(loadProgress().highestStage).toBe(12);
    unlockStage(35);
    expect(loadProgress().highestStage).toBe(35);
    // A looped run re-reaches low stage numbers; progress must not regress.
    unlockStage(levelStageOf(36));
    expect(loadProgress().highestStage).toBe(35);
  });
});

describe('per-run carryover (fidelity §12)', () => {
  it('starts a fresh run at the spec defaults', () => {
    const s = createSession();
    const state = game(s);
    expect(state.players[0].lives).toBe(START_LIVES);
    expect(state.players[0].score).toBe(0);
    expect(state.players[0].nextBonusAt).toBe(BONUS_LIFE_AT);
  });

  it('carries score and lives into the next stage', () => {
    const s = createSession();
    const first = game(s);
    first.players[0].score = 3400;
    first.players[0].lives = 2;
    first.players[0].destroyedByType.basic = 7;
    first.players[0].destroyedByType.armor = 1;

    absorbStage(s, first);
    advanceStage(s);
    const second = game(s);

    expect(second.players[0].score).toBe(3400);
    expect(second.players[0].lives).toBe(2);
    // The per-STAGE counts reset — the tally is a stage screen (fidelity §11.2)
    // — while the run's totals accumulate in the session.
    expect(second.players[0].destroyedByType.basic).toBe(0);
    expect(s.totals[0].basic).toBe(7);
    expect(s.totals[0].armor).toBe(1);
  });

  it('carries the bonus-life threshold so it fires exactly once per run (P-20)', () => {
    const s = createSession();
    const first = game(s);
    first.players[0].score = BONUS_LIFE_AT + 500;
    first.players[0].nextBonusAt = 0; // core consumed it in stage 1
    absorbStage(s, first);
    advanceStage(s);
    expect(game(s).players[0].nextBonusAt).toBe(0);
  });

  it('accumulates run totals across several stages', () => {
    const s = createSession();
    for (let i = 0; i < 3; i++) {
      const state = game(s);
      state.players[0].destroyedByType.basic = 5;
      state.players[0].destroyedByType.fast = 2;
      state.players[0].score = 1000 * (i + 1);
      absorbStage(s, state);
      advanceStage(s);
    }
    expect(s.totals[0].basic).toBe(15);
    expect(s.totals[0].fast).toBe(6);
    expect(s.carry[0].score).toBe(3000);
    expect(s.stageNumber).toBe(4);
  });

  it('leaves an inactive second player inactive across the whole run', () => {
    const s = createSession({ players: 1 });
    const first = game(s);
    expect(first.players[1].active).toBe(false);
    absorbStage(s, first);
    advanceStage(s);
    const second = game(s);
    expect(second.players[1].active).toBe(false);
    expect(second.players[1].lives).toBe(0);
  });

  it('carries a 2P run without letting one player spend the other lives', () => {
    const s = createSession({ players: 2 });
    const first = game(s);
    first.players[0].lives = 0;
    first.players[1].lives = 3;
    first.players[0].score = 900;
    first.players[1].score = 2500;
    absorbStage(s, first);
    advanceStage(s);
    const second = game(s);
    expect(second.players[0].lives).toBe(0);
    expect(second.players[1].lives).toBe(3);
    expect(second.players[0].score).toBe(900);
    expect(second.players[1].score).toBe(2500);
  });

  it('survives the 35 → 1 loop with the carryover intact', () => {
    const s = createSession({ stageNumber: 35 });
    const last = game(s);
    last.players[0].score = 88_000;
    last.players[0].lives = 1;
    absorbStage(s, last);
    advanceStage(s);

    expect(s.stageNumber).toBe(36);
    expect(levelStageOf(s.stageNumber)).toBe(1);
    const looped = game(s);
    expect(looped.stageNumber).toBe(36); // core gets the RISING number
    expect(looped.players[0].score).toBe(88_000);
    expect(looped.players[0].lives).toBe(1);
  });
});

describe('tally rows (fidelity §12)', () => {
  it('reports count × points per type, with a subtotal and a total', () => {
    const s = createSession();
    const state = game(s);
    state.players[0].destroyedByType = {
      basic: 3,
      fast: 2,
      power: 1,
      armor: 4,
    };
    state.players[0].score = 12_345;

    const tally = stageTally(state);
    expect(tally.length).toBe(1); // 1P: one column, not a dead second one
    const rows = tally[0].rows;
    expect(rows.map((r) => r.type)).toEqual([
      'basic',
      'fast',
      'power',
      'armor',
    ]);
    expect(rows[0]).toEqual({
      type: 'basic',
      count: 3,
      points: SCORE.basic,
      subtotal: 3 * SCORE.basic,
    });
    expect(rows[3].subtotal).toBe(4 * SCORE.armor);
    expect(tally[0].tanks).toBe(10);
    // The kill subtotal, not the score — fidelity §12 puts power-ups and the
    // bonus outside the per-type table, so the two legitimately differ.
    expect(tally[0].killPoints).toBe(
      3 * SCORE.basic + 2 * SCORE.fast + SCORE.power + 4 * SCORE.armor,
    );
    expect(tally[0].score).toBe(12_345);
  });

  it('gives a 2P run one column per player', () => {
    const s = createSession({ players: 2 });
    const state = game(s);
    state.players[1].destroyedByType.fast = 6;
    const tally = stageTally(state);
    expect(tally.length).toBe(2);
    expect(tally[1].playerIndex).toBe(1);
    expect(tally[1].tanks).toBe(6);
  });

  it('reads the real counts core produced over a played stage', () => {
    // Not a hand-written state: step the simulation far enough that the spawner
    // and the AI have actually run, then assert the tally reads that state.
    const s = createSession({ seed: 20_260_802 });
    const state = game(s);
    for (let i = 0; i < 600; i++) {
      stepGame(state, [NULL_INTENT, NULL_INTENT]);
    }
    const tally = stageTally(state);
    const sum =
      state.players[0].destroyedByType.basic +
      state.players[0].destroyedByType.fast +
      state.players[0].destroyedByType.power +
      state.players[0].destroyedByType.armor;
    expect(tally[0].tanks).toBe(sum);
  });
});

describe('high scores (fidelity §12, §13)', () => {
  it('seeds the NES default HI of 20,000 into an empty table', () => {
    expect(HI_SCORE_SEED.score).toBe(20_000);
    const table = seedScores([]);
    expect(table.length).toBe(1);
    expect(table[0]).toEqual(HI_SCORE_SEED);
  });

  it('does not seed over a table that already has entries', () => {
    const stored: ScoreEntry[] = [{ score: 500, initials: 'ABC', stage: 2 }];
    expect(seedScores(stored)).toEqual(stored);
  });

  it('qualifies anything above the tenth entry, and nothing at or below it', () => {
    const full: ScoreEntry[] = Array.from({ length: MAX_SCORES }, (_, i) => ({
      score: 10_000 - i * 100,
      initials: 'AAA',
      stage: 1,
    }));
    expect(full[MAX_SCORES - 1].score).toBe(9100);
    expect(qualifies(full, 9101)).toBe(true);
    expect(qualifies(full, 9100)).toBe(false); // ties do not displace
    expect(qualifies(full, 0)).toBe(false);
    // A short table always has room.
    expect(qualifies(full.slice(0, 3), 1)).toBe(true);
    expect(qualifies([], 1)).toBe(true);
    // A zero score never qualifies, even into an empty table — an arcade table
    // that offers initials entry for not playing is a bug, not a feature.
    expect(qualifies([], 0)).toBe(false);
  });

  it('inserts in order and truncates to the top ten', () => {
    let table: ScoreEntry[] = [];
    for (let i = 0; i < 15; i++) {
      table = insertScore(table, {
        score: i * 1000,
        initials: 'AAA',
        stage: 1,
      });
    }
    expect(table.length).toBe(MAX_SCORES);
    expect(table[0].score).toBe(14_000);
    expect(table[MAX_SCORES - 1].score).toBe(5000);
    for (let i = 1; i < table.length; i++) {
      expect(table[i - 1].score).toBeGreaterThanOrEqual(table[i].score);
    }
  });

  it('round-trips a table through storage', () => {
    const table = insertScore(seedScores([]), {
      score: 31_400,
      initials: 'TDM',
      stage: 7,
    });
    saveScores(table);
    expect(loadScores()).toEqual(table);
  });

  it('clamps a stored stage into the table validator range', () => {
    // `levelStageOf` is what the entry records, so a looped run writes 1..35 and
    // the row survives a reload. A raw internal counter would not.
    const entry: ScoreEntry = {
      score: 1,
      initials: 'ZZZ',
      stage: levelStageOf(36),
    };
    saveScores([entry]);
    expect(loadScores()).toEqual([entry]);
  });
});

describe('arcade initials entry (fidelity §13)', () => {
  it('starts as three characters on the first column', () => {
    const m = createInitials();
    expect(initialsText(m)).toHaveLength(3);
    expect(m.cursor).toBe(0);
  });

  it('cycles a character with wrap in both directions', () => {
    const m = createInitials();
    const first = initialsText(m)[0];
    applyInitials(m, 'next');
    expect(initialsText(m)[0]).not.toBe(first);
    applyInitials(m, 'prev');
    expect(initialsText(m)[0]).toBe(first);
    applyInitials(m, 'prev'); // off the front of the alphabet
    expect(initialsText(m)).toHaveLength(3);
    applyInitials(m, 'next');
    expect(initialsText(m)[0]).toBe(first);
  });

  it('walks the three columns and stops at both ends', () => {
    const m = createInitials();
    applyInitials(m, 'left');
    expect(m.cursor).toBe(0); // no wrap: the ends are walls, as on the cabinet
    applyInitials(m, 'right');
    expect(m.cursor).toBe(1);
    applyInitials(m, 'right');
    expect(m.cursor).toBe(2);
    applyInitials(m, 'right');
    expect(m.cursor).toBe(2);
  });

  it('commits only from the last column, advancing before that', () => {
    const m = createInitials();
    expect(applyInitials(m, 'commit').done).toBe(false);
    expect(m.cursor).toBe(1);
    expect(applyInitials(m, 'commit').done).toBe(false);
    expect(m.cursor).toBe(2);
    expect(applyInitials(m, 'commit').done).toBe(true);
  });

  it('backs out one column at a time and cancels off the front', () => {
    const m = createInitials();
    applyInitials(m, 'right');
    expect(applyInitials(m, 'cancel').cancelled).toBe(false);
    expect(m.cursor).toBe(0);
    expect(applyInitials(m, 'cancel').cancelled).toBe(true);
  });

  it('always yields exactly three storable characters', () => {
    const m = createInitials();
    for (let i = 0; i < 100; i++) {
      applyInitials(m, 'next');
    }
    const text = initialsText(m);
    expect(text).toHaveLength(3);
    expect(text).toMatch(/^[A-Z0-9 .-]{3}$/);
    saveScores([{ score: 10, initials: text, stage: 1 }]);
    expect(loadScores()[0].initials).toBe(text);
  });
});
