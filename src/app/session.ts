// src/app/session.ts — what a *run* is, across the stages it spans.
//
// One rule governs this file: **core already implements the rules.** Scoring,
// lives, the bonus life, the phases and the spawn cadence are all in
// `src/core/` and stay there. A run, however, is bigger than a `GameState` —
// each stage is a fresh `createGame`, and the things fidelity §12 says "carry
// across stages within a run" have to live somewhere that outlives one of them.
// That is this file, and it does exactly three jobs:
//
//   1. the **stage counter** (§11.5): one number that rises forever, and the
//      1…35 label the player is shown;
//   2. the **carryover** (§12): lives, score and the bonus-life threshold from
//      the stage that just ended into the one about to start;
//   3. the **arcade table** (§12/§13): the top ten, the 20,000 seed, and the
//      three-character entry model.
//
// Nothing here touches the DOM. `tests/app/session.test.ts` runs all of it in
// the node environment against the real `createGame`/`stepGame`.

import {
  BONUS_LIFE_AT,
  SCORE,
  STAGE_CAP,
  START_LIVES,
} from '../core/constants';
import type { EnemyType, GameState } from '../core/types';
import {
  MAX_SCORES,
  loadSave,
  loadScores,
  saveSave,
  saveScores,
  type SaveV1,
  type ScoreEntry,
} from './storage';

export { MAX_SCORES } from './storage';

/**
 * GDD §4: "the 35 original stages in order, **looping after 35** as in the NES".
 *
 * The same number as core's {@link STAGE_CAP}, and deliberately its own
 * constant: they mean different things and could in principle diverge. Core's
 * caps the *spawn formula's* stage term (fidelity §7); this one is the length
 * of the campaign. `tests/app/session.test.ts` pins them equal so a future
 * change to one is a decision about the other.
 */
export const STAGE_LOOP = STAGE_CAP;

/** Per-player state that survives a stage boundary (fidelity §12). */
export interface PlayerCarry {
  lives: number;
  score: number;
  /** Fidelity §3.1: "+1 at 20,000 points, **once per player**" — per RUN, not
   *  per stage, so the consumed threshold has to travel with the score. */
  nextBonusAt: number;
  active: boolean;
}

export type KillCounts = Record<EnemyType, number>;

export interface Session {
  players: 1 | 2;
  /**
   * The **internal** stage counter (fidelity §11.5). It rises forever; after 35
   * the campaign loops back to stage 1's *layout* while this number keeps
   * climbing, which is what keeps the spawn cadence tightening. Handed to
   * `createGame` unchanged — the cap lives in `spawnIntervalTicks`, and capping
   * it here would make stage 36 play exactly like stage 1.
   */
  stageNumber: number;
  seed: number;
  carry: [PlayerCarry, PlayerCarry];
  /** Cumulative kills for the whole run, per player. The tally screen shows a
   *  STAGE's counts; this is what a run summary would show. */
  totals: [KillCounts, KillCounts];
}

const ENEMY_TYPES: readonly EnemyType[] = Object.freeze([
  'basic',
  'fast',
  'power',
  'armor',
]);

function zeroKills(): KillCounts {
  return { basic: 0, fast: 0, power: 0, armor: 0 };
}

function freshCarry(active: boolean): PlayerCarry {
  // Mirrors `makePlayer` in core/game.ts exactly, including the deliberate
  // `nextBonusAt: 0` for an inactive slot (T1.7's ruling: the `!active` guard
  // is load-bearing, and a carry that disagreed would re-open it).
  return {
    lives: active ? START_LIVES : 0,
    score: 0,
    nextBonusAt: active ? BONUS_LIFE_AT : 0,
    active,
  };
}

/**
 * The seed is the app layer's job: the core takes it and stays deterministic
 * (arch §3.5). A fresh run draws it from the wall clock; a replay, a debug
 * `?seed=` flag or a test passes its own.
 */
export function createSession(init?: Partial<Session>): Session {
  const players = init?.players ?? 1;
  return {
    players,
    stageNumber: init?.stageNumber ?? 1,
    seed: init?.seed ?? Date.now() >>> 0,
    carry: init?.carry ?? [freshCarry(true), freshCarry(players === 2)],
    totals: init?.totals ?? [zeroKills(), zeroKills()],
  };
}

// ---------------------------------------------------------------------------
// --- Progression (fidelity §11.5, GDD §4) ----------------------------------
// ---------------------------------------------------------------------------

/**
 * The 1…35 stage a rising counter is currently on — the layout to load and the
 * number to show. Stage 36 is stage 1 again.
 */
export function levelStageOf(stageNumber: number): number {
  const n = Math.max(1, Math.floor(stageNumber));
  return ((n - 1) % STAGE_LOOP) + 1;
}

export function advanceStage(session: Session): void {
  session.stageNumber += 1;
}

/** Stage-select progress (arch §4.2's `bc.save.v1`). */
export function loadProgress(): SaveV1 {
  return loadSave();
}

/**
 * Record that a stage was reached. Monotonic: a looped run re-reaches stage 1,
 * and progress that could go *down* would relock the campaign at the moment of
 * its greatest achievement.
 */
export function unlockStage(levelStage: number): void {
  const save = loadSave();
  const reached = Math.min(STAGE_LOOP, Math.max(1, Math.floor(levelStage)));
  if (reached <= save.highestStage) {
    return;
  }
  saveSave({ ...save, highestStage: reached });
}

// ---------------------------------------------------------------------------
// --- Carryover (fidelity §12) ----------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Seeds a freshly built `GameState` with the run's carryover.
 *
 * This **writes to core state**, which every presentation layer is forbidden to
 * do (arch §3.3) — and it is not one of them: arch §2 gives `app/` the job of
 * *constructing* the simulation, and this runs before the first tick, alongside
 * `createGame` rather than after it. It is initialization, not feedback.
 *
 * An inactive slot is never touched, so the unused P2 of a 1-player game cannot
 * be brought to life by a stale carry.
 */
export function applyCarry(state: GameState, session: Session): void {
  for (let i = 0; i < state.players.length; i++) {
    const meta = state.players[i];
    if (!meta.active) {
      continue;
    }
    const carry = session.carry[i];
    meta.lives = carry.lives;
    meta.score = carry.score;
    meta.nextBonusAt = carry.nextBonusAt;
  }
}

/**
 * Pulls a finished stage's numbers back into the run.
 *
 * `destroyedByType` is **not** carried forward into the next `GameState`: the
 * tally is a per-stage screen (fidelity §11.2), so core's counters start each
 * stage at zero and the run's cumulative totals live here instead.
 */
export function absorbStage(session: Session, state: GameState): void {
  for (let i = 0; i < state.players.length; i++) {
    const meta = state.players[i];
    const carry = session.carry[i];
    carry.active = meta.active;
    if (!meta.active) {
      continue;
    }
    carry.lives = meta.lives;
    carry.score = meta.score;
    carry.nextBonusAt = meta.nextBonusAt;
    for (const type of ENEMY_TYPES) {
      session.totals[i][type] += meta.destroyedByType[type];
    }
  }
}

/** The score each active player would submit to the table (GDD §8: per player). */
export function runScores(
  session: Session,
): { playerIndex: 0 | 1; score: number }[] {
  const out: { playerIndex: 0 | 1; score: number }[] = [];
  for (const i of [0, 1] as const) {
    if (session.carry[i].active) {
      out.push({ playerIndex: i, score: session.carry[i].score });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// --- The tally (fidelity §12) ----------------------------------------------
// ---------------------------------------------------------------------------

export interface TallyRow {
  type: EnemyType;
  count: number;
  points: number;
  subtotal: number;
}

export interface TallyColumn {
  playerIndex: 0 | 1;
  rows: TallyRow[];
  /** Tanks destroyed this stage — the NES's "TOTAL" line. */
  tanks: number;
  /** The kill subtotal. Deliberately NOT the score: power-ups (500 each) and
   *  the bonus life sit outside this table, so the two legitimately differ. */
  killPoints: number;
  /** The player's running score, which is what carries (fidelity §12). */
  score: number;
}

/** One column per **active** player — a 1P run does not show a dead second one. */
export function stageTally(state: GameState): TallyColumn[] {
  const columns: TallyColumn[] = [];
  for (const i of [0, 1] as const) {
    const meta = state.players[i];
    if (!meta.active) {
      continue;
    }
    const rows: TallyRow[] = ENEMY_TYPES.map((type) => ({
      type,
      count: meta.destroyedByType[type],
      points: SCORE[type],
      subtotal: meta.destroyedByType[type] * SCORE[type],
    }));
    columns.push({
      playerIndex: i,
      rows,
      tanks: rows.reduce((n, r) => n + r.count, 0),
      killPoints: rows.reduce((n, r) => n + r.subtotal, 0),
      score: meta.score,
    });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// --- High scores (fidelity §12, §13) ---------------------------------------
// ---------------------------------------------------------------------------

/**
 * GDD §8 / fidelity §12: "seed entry **20,000** pts as the NES default `HI`
 * value". The NES shows a bare `HI 20000` with no name behind it; a table needs
 * three characters, so the seed wears the arcade default.
 */
export const HI_SCORE_SEED: ScoreEntry = Object.freeze({
  score: 20_000,
  initials: 'AAA',
  stage: 1,
});

/** The stored table, with the NES default standing in for an empty one. */
export function seedScores(stored: ScoreEntry[]): ScoreEntry[] {
  return stored.length > 0 ? stored : [{ ...HI_SCORE_SEED }];
}

export function loadTable(): ScoreEntry[] {
  return seedScores(loadScores());
}

/**
 * Fidelity §13: "if score beats table's 10th entry". Two edges are decided
 * here rather than left to the caller:
 *
 * - a **tie does not displace** — the incumbent keeps the slot, which is how
 *   every arcade table behaves;
 * - a **zero never qualifies**, even into an empty table. Offering initials
 *   entry for not having played is a bug wearing a feature's clothes.
 */
export function qualifies(
  scores: readonly ScoreEntry[],
  score: number,
): boolean {
  if (score <= 0) {
    return false;
  }
  if (scores.length < MAX_SCORES) {
    return true;
  }
  return score > scores[scores.length - 1].score;
}

/** Insert, sort descending, truncate to ten. Stable, so a tie keeps its order. */
export function insertScore(
  scores: readonly ScoreEntry[],
  entry: ScoreEntry,
): ScoreEntry[] {
  return [...scores, entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SCORES);
}

/** Insert and persist in one step, returning the table that was written. */
export function commitScore(entry: ScoreEntry): ScoreEntry[] {
  const table = insertScore(loadTable(), entry);
  saveScores(table);
  return table;
}

// ---------------------------------------------------------------------------
// --- Arcade initials entry (fidelity §13) ----------------------------------
// ---------------------------------------------------------------------------

/**
 * The character wheel. Letters first (an arcade table is mostly initials),
 * then digits, then the three separators a name might want. Space is included
 * and `.`/`-` follow it, so `initialsText` can never produce a character the
 * storage validator would reject.
 */
export const INITIALS_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-';

export const INITIALS_LENGTH = 3;

/**
 * The five things a cabinet's initials entry can be asked to do, named for what
 * they mean rather than for the keys that produce them. `src/ui/screens/hiScore.ts`
 * maps `NavEvent` onto these, so a gamepad drives the same model in Phase 9.
 */
export type InitialsInput =
  'prev' | 'next' | 'left' | 'right' | 'commit' | 'cancel';

export interface InitialsModel {
  /** Indices into {@link INITIALS_ALPHABET}. */
  chars: [number, number, number];
  cursor: 0 | 1 | 2;
}

export interface InitialsResult {
  /** The three characters are settled. */
  done: boolean;
  /** The player backed out of the first column — abandon the entry. */
  cancelled: boolean;
}

export function createInitials(): InitialsModel {
  return { chars: [0, 0, 0], cursor: 0 };
}

export function initialsText(m: InitialsModel): string {
  return m.chars.map((i) => INITIALS_ALPHABET[i]).join('');
}

/**
 * The columns are **walls, not a ring**: `left` on the first column does not
 * wrap to the third. On a cabinet, over-travelling past the end of your own
 * name and landing back on the first letter is how initials get mistyped, and
 * `cancel` is the way out of the first column instead.
 *
 * The *characters* do wrap, because a wheel of 39 with no wrap would make `-`
 * a twelve-press journey from `A`.
 */
export function applyInitials(
  m: InitialsModel,
  input: InitialsInput,
): InitialsResult {
  const n = INITIALS_ALPHABET.length;
  switch (input) {
    case 'prev':
      m.chars[m.cursor] = (m.chars[m.cursor] + n - 1) % n;
      break;
    case 'next':
      m.chars[m.cursor] = (m.chars[m.cursor] + 1) % n;
      break;
    case 'left':
      if (m.cursor > 0) {
        m.cursor = (m.cursor - 1) as 0 | 1 | 2;
      }
      break;
    case 'right':
      if (m.cursor < INITIALS_LENGTH - 1) {
        m.cursor = (m.cursor + 1) as 0 | 1 | 2;
      }
      break;
    case 'commit':
      if (m.cursor < INITIALS_LENGTH - 1) {
        m.cursor = (m.cursor + 1) as 0 | 1 | 2;
        break;
      }
      return { done: true, cancelled: false };
    case 'cancel':
      if (m.cursor > 0) {
        m.cursor = (m.cursor - 1) as 0 | 1 | 2;
        break;
      }
      return { done: false, cancelled: true };
  }
  return { done: false, cancelled: false };
}
