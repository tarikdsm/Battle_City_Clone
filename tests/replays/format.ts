// tests/replays/format.ts — the golden-replay fixture format, defined ONCE.
//
// The recorder (scripts/record-replay.ts) and the runner (tests/core/replay.test.ts)
// sit on opposite sides of a serialized file, so a schema kept in two places is a
// schema that can silently diverge — and divergence in a replay format does not
// surface as a type error, it surfaces as a hash mismatch nobody can explain. The
// shape, the encoder and the decoder therefore live here together, and both sides
// import them.
//
// `encodeIntents` and `replayIntents` are inverse by construction and by test
// (tests/core/replay.test.ts pins the round trip): the encoder writes a row only
// where the pad changed, the decoder holds the last row's value until the next
// one, and the recorder itself records through the DECODER — so the `expected`
// block in a fixture always describes what replaying that fixture's rows does,
// never what some parallel code path did.
import { createGame, stepGame } from '../../src/core/game';
import type { GameEvent } from '../../src/core/events';
import type {
  Dir,
  GameState,
  LevelData,
  PlayerIntent,
} from '../../src/core/types';

export type Intents = readonly [PlayerIntent, PlayerIntent];

// [tick, p0dir, p0fire, p0pause, p1dir, p1fire, p1pause]. `tick` is the 1-based
// index of the `stepGame` CALL the row takes effect on — not the value of
// `state.tick`, which a paused call does not advance.
export type IntentRow = [
  number,
  Dir | null,
  boolean,
  boolean,
  Dir | null,
  boolean,
  boolean,
];

export interface ReplayFixture {
  version: number;
  levelId: string;
  seed: number;
  players: 1 | 2;
  stageNumber: number;
  ticks: number;
  intents: IntentRow[];
  expected: {
    hash: number;
    eventCount: number;
    // The `t` discriminators of the first 50 events, in order. This pins event
    // ORDER and kind only — payload fields (positions, ids, points) are NOT in
    // it, so a regression in, say, a `brickHit`'s coordinates is invisible here
    // unless it also moves hashed state. Do not read a green `firstEvents` as
    // "the first 50 events are correct"; it means "the first 50 events are the
    // same kinds in the same order".
    firstEvents: string[];
  };
}

export interface RunResult {
  state: GameState;
  events: GameEvent[];
}

export const IDLE: PlayerIntent = { dir: null, fire: false, pause: false };

export function sameIntent(a: PlayerIntent, b: PlayerIntent): boolean {
  return a.dir === b.dir && a.fire === b.fire && a.pause === b.pause;
}

// --- Encoder ---------------------------------------------------------------

// Sparse change-list of a per-call intent script. The baseline is IDLE for both
// players — the value a fresh runner holds before it has read any row — so a
// script that starts idle writes no leading row.
export function encodeIntents(
  script: (call: number) => Intents,
  ticks: number,
): IntentRow[] {
  const rows: IntentRow[] = [];
  let prev: Intents = [IDLE, IDLE];
  for (let call = 1; call <= ticks; call++) {
    const intents = script(call);
    if (!sameIntent(intents[0], prev[0]) || !sameIntent(intents[1], prev[1])) {
      rows.push([
        call,
        intents[0].dir,
        intents[0].fire,
        intents[0].pause,
        intents[1].dir,
        intents[1].fire,
        intents[1].pause,
      ]);
    }
    prev = intents;
  }
  return rows;
}

// --- Decoder ---------------------------------------------------------------

// The decoder as a plain sequence, one entry per call — used by the round-trip
// test to compare against the script the encoder was given. `runReplay` below
// walks the same rows the same way; this is that walk, without a simulation.
export function replayIntents(
  rows: readonly IntentRow[],
  ticks: number,
): Intents[] {
  const out: Intents[] = [];
  const held = newHeld();
  let next = 0;
  for (let call = 1; call <= ticks; call++) {
    next = applyRowsFor(held, rows, next, call);
    out.push([{ ...held[0] }, { ...held[1] }]);
  }
  return out;
}

// Run a fixture's rows against the real simulation. One `stepGame` call per
// `tick` — NOT one advance of `state.tick`: a paused call advances nothing
// (T1.7), so a fixture that scripts a pause ends with `state.tick < ticks`.
export function runReplay(
  level: LevelData,
  opts: { players: 1 | 2; seed: number; stageNumber: number },
  ticks: number,
  rows: readonly IntentRow[],
): RunResult {
  const state = createGame(level, opts);
  const held = newHeld();
  const events: GameEvent[] = [];

  let next = 0;
  for (let call = 1; call <= ticks; call++) {
    next = applyRowsFor(held, rows, next, call);
    stepGame(state, held);
    for (const e of state.events) events.push(e);
  }

  return { state, events };
}

// --- Internals -------------------------------------------------------------

function newHeld(): [PlayerIntent, PlayerIntent] {
  return [{ ...IDLE }, { ...IDLE }];
}

// Apply every row scheduled for `call` (a well-formed fixture has at most one),
// returning the new cursor. Rows are in ascending call order.
function applyRowsFor(
  held: [PlayerIntent, PlayerIntent],
  rows: readonly IntentRow[],
  next: number,
  call: number,
): number {
  let cursor = next;
  while (cursor < rows.length && rows[cursor][0] === call) {
    const row = rows[cursor];
    held[0].dir = row[1];
    held[0].fire = row[2];
    held[0].pause = row[3];
    held[1].dir = row[4];
    held[1].fire = row[5];
    held[1].pause = row[6];
    cursor++;
  }
  return cursor;
}
