// tests/core/replay.test.ts — the golden-replay regression net (P-23, fidelity
// §14). Each fixture under tests/replays/ is a recorded run: a level id, a seed, a
// player count and a sparse intent change-list. Replaying it must reproduce the
// exact recorded state hash, event count and event order — so any change to the
// simulation that alters an outcome, an rng draw order or a system's place in the
// pipeline fails here loudly instead of drifting in silently.
//
// The fixtures are produced by `npm run replays:record` (scripts/record-replay.ts),
// which is committed alongside them: when a calibration pass deliberately changes
// a constant, re-record rather than edit the numbers by hand. The format, the
// encoder and the runner all live in tests/replays/format.ts, shared with the
// recorder, so the two sides of the serialized file cannot drift apart.
//
// Beyond the recorded values, every fixture is also held to a LIVE-PLAY and
// NON-TRIVIALITY floor: it must still be in phase 'playing' at the end, and it
// must still be killing enemies and collecting drops. A re-record whose seed now
// reached game over at call 900 and idled for the next 900 would otherwise
// reproduce a perfectly stable hash of a finished game — coverage in name only.
//
// Node fs and the timing API are used here on purpose: tests are outside
// src/core, so the core's headless/deterministic boundary does not apply to them
// (they compile under tsconfig.node.json, the only program that carries
// @types/node).
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashState } from '../../src/core/game';
import {
  IDLE,
  encodeIntents,
  replayIntents,
  runReplay,
  type IntentRow,
  type ReplayFixture,
  type RunResult,
} from '../replays/format';
import type { GameEvent } from '../../src/core/events';
import type { Dir, LevelData, PlayerIntent } from '../../src/core/types';

const FIXTURES_DIR = new URL('../fixtures/', import.meta.url);
const REPLAYS_DIR = new URL('../replays/', import.meta.url);

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

// `tankDestroyed` alone does not mean the player is fighting: a fixture in which
// only the PLAYER dies satisfies it. Enemy kills are the honest measure.
function enemyKills(events: readonly GameEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.t === 'tankDestroyed' && e.kind === 'enemy') n += 1;
  }
  return n;
}

// --- The fixture table -----------------------------------------------------

// `pausedCalls` is the number of `stepGame` calls the fixture spends frozen — the
// exact stall its scripted pause costs the tick counter (P-26 / T1.7).
// `minEnemyKills` / `minPowerupsCollected` are FLOORS with headroom under what the
// recordings actually produce (6/10/9 kills and 1/1/2 collections as recorded),
// deliberately not the exact values: a legitimate re-record may move the numbers,
// but one that stops fighting or stops collecting has to fail.
// `requires` is the scenario's REASON to exist — replay2 exists to cover 2P
// friendly fire, so a re-record that quietly stopped producing `playerStunned`
// must fail, not pass.
const FIXTURES: readonly {
  name: string;
  pausedCalls: number;
  minEnemyKills: number;
  minPowerupsCollected: number;
  requires: readonly GameEvent['t'][];
}[] = [
  {
    name: 'replay1',
    pausedCalls: 0,
    minEnemyKills: 3,
    minPowerupsCollected: 1,
    requires: ['brickHit', 'tankDestroyed', 'enemySpawned', 'powerupCollected'],
  },
  {
    name: 'replay2',
    pausedCalls: 61,
    minEnemyKills: 3,
    minPowerupsCollected: 1,
    requires: ['pauseToggled', 'playerStunned', 'tankDestroyed', 'brickHit'],
  },
  {
    name: 'replay3',
    pausedCalls: 0,
    minEnemyKills: 3,
    minPowerupsCollected: 1,
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
  ({ name, pausedCalls, minEnemyKills, minPowerupsCollected, requires }) => {
    const fixture = loadFixture(name);
    // Stepped once, in the test lifecycle rather than at collection time, so a
    // throw out of the simulation is reported as a failing hook on this named
    // suite instead of a bare collection error.
    let result: RunResult;
    beforeAll(() => {
      result = replay(fixture);
    });

    it('P-23: reproduces the recorded final state hash', () => {
      expect(hashState(result.state)).toBe(fixture.expected.hash);
    });

    it('P-23: reproduces the recorded event count and first 50 event kinds', () => {
      expect(result.events.length).toBe(fixture.expected.eventCount);
      // Discriminators only — see the note on ReplayFixture.expected.firstEvents:
      // a payload regression inside those 50 events is invisible here unless it
      // also moves hashed state.
      expect(result.events.slice(0, 50).map((e) => e.t)).toEqual(
        fixture.expected.firstEvents,
      );
    });

    it('advances the tick counter once per unpaused call', () => {
      expect(result.state.tick).toBe(fixture.ticks - pausedCalls);
    });

    // The guard against the failure mode this whole file exists to prevent. A
    // fixture that reached a terminal phase early would keep hashing
    // deterministically while simulating a finished game, and every cumulative
    // assertion below would still pass on the events it emitted before it died.
    it('is still inside live play at the last recorded tick', () => {
      expect(result.state.phase).toBe('playing');
    });

    it('is a non-trivial run (volume, variety, kills, collections)', () => {
      expect(result.events.length).toBeGreaterThanOrEqual(200);
      const kinds = typesOf(result.events);
      kinds.delete('shotFired');
      expect(kinds.size).toBeGreaterThanOrEqual(3);
      expect(enemyKills(result.events)).toBeGreaterThanOrEqual(minEnemyKills);
      expect(countOf(result.events, 'powerupCollected')).toBeGreaterThanOrEqual(
        minPowerupsCollected,
      );
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

// --- The fixture format itself ---------------------------------------------

// The recorder writes the sparse rows; this file reads them back. Both sides call
// the same two functions in tests/replays/format.ts, and these pin them as
// inverse: encode a script, decode the rows, and every call must hold exactly
// what the script said on it.
describe('replay fixture format', () => {
  it('the sparse intent encoding round-trips exactly', () => {
    const dirs: readonly (Dir | null)[] = [null, 0, 1, 2, 3];
    const script = (call: number): readonly [PlayerIntent, PlayerIntent] => [
      {
        dir: dirs[Math.floor(call / 37) % dirs.length],
        fire: call % 8 === 0,
        pause: call === 200 || call === 260,
      },
      {
        dir: dirs[Math.floor(call / 23) % dirs.length],
        fire: call % 11 === 0,
        pause: false,
      },
    ];

    const rows = encodeIntents(script, 400);
    const decoded = replayIntents(rows, 400);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(400); // sparse, not one row per call
    for (let call = 1; call <= 400; call++) {
      expect(decoded[call - 1]).toEqual(script(call));
    }
  });

  it('writes no leading row while a script is still idle', () => {
    const rows = encodeIntents(
      (call) => (call < 50 ? [IDLE, IDLE] : [{ ...IDLE, dir: 0 }, IDLE]),
      100,
    );
    expect(rows[0][0]).toBe(50);
  });
});

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
