// tests/core/replay.test.ts — the golden-replay regression net (P-23, fidelity
// §14). Each fixture under tests/replays/ is a recorded run: a level id, a seed, a
// player count and a sparse intent change-list. Replaying it must reproduce the
// exact recorded state hash, event count and event order — so any change to the
// simulation that alters an outcome, an rng draw order or a system's place in the
// pipeline fails here loudly instead of drifting in silently.
//
// The fixtures are produced by `npm run replays:record` (scripts/record-replay.ts),
// which is committed alongside them: when a calibration pass deliberately changes
// a constant, re-record rather than edit the numbers by hand.
//
// Beyond the recorded values, every fixture is also held to a NON-TRIVIALITY floor
// (event volume, event variety, at least one kill) plus its own scenario-specific
// requirements — a fixture that silently stopped simulating would still hash
// consistently, and would read as coverage while testing nothing.
//
// Node fs and the timing API are used here on purpose: tests are outside
// src/core, so the core's headless/deterministic boundary does not apply to them.
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, hashState, stepGame } from '../../src/core/game';
import type { GameEvent } from '../../src/core/events';
import type {
  Dir,
  GameState,
  LevelData,
  PlayerIntent,
} from '../../src/core/types';

const FIXTURES_DIR = new URL('../fixtures/', import.meta.url);
const REPLAYS_DIR = new URL('../replays/', import.meta.url);

// [tick, p0dir, p0fire, p0pause, p1dir, p1fire, p1pause] — see the fixture format
// in the T1.8 brief. Sparse: a row appears only on a tick where something changed,
// and the runner holds the last value until the next row.
type IntentRow = [
  number,
  Dir | null,
  boolean,
  boolean,
  Dir | null,
  boolean,
  boolean,
];

interface ReplayFixture {
  version: number;
  levelId: string;
  seed: number;
  players: 1 | 2;
  stageNumber: number;
  ticks: number;
  intents: IntentRow[];
  expected: { hash: number; eventCount: number; firstEvents: string[] };
}

interface RunResult {
  state: GameState;
  events: GameEvent[];
}

// --- Loading ---------------------------------------------------------------

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

// Every level fixture, indexed by its own `id` — so a replay names a level the
// same way a level names itself and adding a level file needs no wiring here.
function loadLevels(): Map<string, LevelData> {
  const levels = new Map<string, LevelData>();
  for (const name of readdirSync(FIXTURES_DIR)) {
    if (!name.endsWith('.json')) continue;
    const level = readJson(new URL(name, FIXTURES_DIR)) as LevelData;
    levels.set(level.id, level);
  }
  return levels;
}

const LEVELS = loadLevels();

function loadFixture(name: string): ReplayFixture {
  return readJson(new URL(`${name}.json`, REPLAYS_DIR)) as ReplayFixture;
}

function levelOf(fixture: ReplayFixture): LevelData {
  const level = LEVELS.get(fixture.levelId);
  if (level === undefined) {
    throw new Error(`replay fixture names unknown level "${fixture.levelId}"`);
  }
  return level;
}

// --- The runner ------------------------------------------------------------

// One `stepGame` call per `tick` of the fixture — NOT one advance of state.tick.
// A paused call advances nothing (T1.7), so a fixture that scripts a pause ends
// with state.tick < ticks, and that gap is asserted rather than smoothed over.
function runReplay(
  level: LevelData,
  opts: { players: 1 | 2; seed: number; stageNumber: number },
  ticks: number,
  rows: readonly IntentRow[],
): RunResult {
  const state = createGame(level, opts);
  const held: [PlayerIntent, PlayerIntent] = [
    { dir: null, fire: false, pause: false },
    { dir: null, fire: false, pause: false },
  ];
  const events: GameEvent[] = [];

  let next = 0;
  for (let call = 1; call <= ticks; call++) {
    while (next < rows.length && rows[next][0] === call) {
      const row = rows[next];
      held[0].dir = row[1];
      held[0].fire = row[2];
      held[0].pause = row[3];
      held[1].dir = row[4];
      held[1].fire = row[5];
      held[1].pause = row[6];
      next++;
    }
    stepGame(state, held);
    for (const e of state.events) events.push(e);
  }

  return { state, events };
}

function replay(fixture: ReplayFixture): RunResult {
  return runReplay(
    levelOf(fixture),
    {
      players: fixture.players,
      seed: fixture.seed,
      stageNumber: fixture.stageNumber,
    },
    fixture.ticks,
    fixture.intents,
  );
}

function typesOf(events: readonly GameEvent[]): Set<string> {
  const kinds = new Set<string>();
  for (const e of events) kinds.add(e.t);
  return kinds;
}

function countOf(events: readonly GameEvent[], t: GameEvent['t']): number {
  let n = 0;
  for (const e of events) {
    if (e.t === t) n += 1;
  }
  return n;
}

// --- The fixture table -----------------------------------------------------

// `pausedCalls` is the number of `stepGame` calls the fixture spends frozen — the
// exact stall its scripted pause costs the tick counter (P-26 / T1.7). `requires`
// is the scenario's REASON to exist: replay2 exists to cover 2P friendly fire, so
// a re-record that quietly stopped producing `playerStunned` must fail, not pass.
const FIXTURES: readonly {
  name: string;
  pausedCalls: number;
  requires: readonly GameEvent['t'][];
}[] = [
  {
    name: 'replay1',
    pausedCalls: 0,
    requires: ['brickHit', 'tankDestroyed', 'enemySpawned'],
  },
  {
    name: 'replay2',
    pausedCalls: 61,
    requires: ['pauseToggled', 'playerStunned', 'tankDestroyed', 'brickHit'],
  },
  {
    name: 'replay3',
    pausedCalls: 0,
    requires: [
      'tankDestroyed',
      'powerupSpawned',
      'powerupCollected',
      'scoreAwarded',
    ],
  },
];

describe.each(FIXTURES)(
  'golden replay $name (P-23)',
  ({ name, pausedCalls, requires }) => {
    const fixture = loadFixture(name);
    const result = replay(fixture);

    it('P-23: reproduces the recorded final state hash', () => {
      expect(hashState(result.state)).toBe(fixture.expected.hash);
    });

    it('P-23: reproduces the recorded event count and first 50 event kinds', () => {
      expect(result.events.length).toBe(fixture.expected.eventCount);
      expect(result.events.slice(0, 50).map((e) => e.t)).toEqual(
        fixture.expected.firstEvents,
      );
    });

    it('advances the tick counter once per unpaused call', () => {
      expect(result.state.tick).toBe(fixture.ticks - pausedCalls);
    });

    it('is a non-trivial run (volume, variety, at least one kill)', () => {
      expect(result.events.length).toBeGreaterThanOrEqual(200);
      const kinds = typesOf(result.events);
      kinds.delete('shotFired');
      expect(kinds.size).toBeGreaterThanOrEqual(3);
      expect(countOf(result.events, 'tankDestroyed')).toBeGreaterThanOrEqual(1);
    });

    it('exercises the behaviour it was recorded for', () => {
      const kinds = typesOf(result.events);
      const missing = requires.filter((t) => !kinds.has(t));
      expect(missing, `${name} never emitted: ${missing.join(', ')}`).toEqual(
        [],
      );
    });
  },
);

// --- Determinism, independent of the fixtures ------------------------------

// The fixtures pin WHAT the simulation produces; this pins the property itself, so
// determinism is still covered even if every fixture were re-recorded at once.
describe('replay determinism (P-23)', () => {
  const level = LEVELS.get('test-open');
  if (level === undefined) throw new Error('missing level fixture test-open');

  // A short scripted run: drive up out of the intro, then sweep and fire.
  const SCRIPT: readonly IntentRow[] = [
    [121, 0, false, false, null, false, false],
    [140, 0, true, false, null, false, false],
    [141, 1, false, false, null, false, false],
    [200, 1, true, false, null, false, false],
    [201, 3, false, false, null, false, false],
    [260, 2, true, false, null, false, false],
    [261, 2, false, false, null, false, false],
  ];
  const OPTS = { players: 1 as const, seed: 4242, stageNumber: 2 };

  it('P-23: the same level + seed + intents hash identically twice over', () => {
    const a = runReplay(level, OPTS, 400, SCRIPT);
    const b = runReplay(level, OPTS, 400, SCRIPT);
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(b.events.map((e) => e.t)).toEqual(a.events.map((e) => e.t));
  });

  it('P-23: a seed one apart diverges', () => {
    const a = runReplay(level, OPTS, 400, SCRIPT);
    const b = runReplay(level, { ...OPTS, seed: OPTS.seed + 1 }, 400, SCRIPT);
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });
});

// --- Perf smoke ------------------------------------------------------------

// Deliberately generous: the spec target is <= 2 ms/step, which would allow ~3.6 s
// for replay1's 1800 ticks. This bound only catches an order-of-magnitude
// regression (an accidental per-tick allocation storm, an O(n^2) scan), not the
// jitter of a shared CI box.
describe('perf smoke', () => {
  const clock: { now: () => number } = globalThis.performance ?? Date;

  it('steps replay1 well inside the frame budget', () => {
    const fixture = loadFixture('replay1');
    const level = levelOf(fixture);
    const opts = {
      players: fixture.players,
      seed: fixture.seed,
      stageNumber: fixture.stageNumber,
    };
    const started = clock.now();
    runReplay(level, opts, fixture.ticks, fixture.intents);
    expect(clock.now() - started).toBeLessThan(1500);
  });
});
