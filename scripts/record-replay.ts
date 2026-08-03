// scripts/record-replay.ts — the golden-replay recorder (`npm run replays:record`).
//
// It owns the SCENARIOS below — level, seed, player count, stage number, length
// and the scripted pad input — runs each one through the real `createGame`/
// `stepGame`, and writes `tests/replays/replayN.json` with the `expected` block
// filled from the run that just happened. tests/core/replay.test.ts then replays
// those fixtures and must reproduce them exactly (P-23).
//
// Committed, and re-runnable: when the calibration pass (T10.2) deliberately
// changes a simulation constant, re-record with this rather than editing the
// recorded numbers by hand. Output is byte-identical for unchanged code — the
// simulation is seeded and the JSON is emitted through Prettier with the repo's
// own config, so `npm run check` stays green after a re-record.
//
// Scenario design is constrained by facts the pipeline establishes (T1.7):
//   · player intents are IGNORED until the intro curtain lifts — the phase is
//     read at the top of the tick, so control resumes on tick 121, not 120. Every
//     script below therefore starts at CONTROL_FROM.
//   · a paused tick advances nothing, so a scripted pause makes the fixture's
//     final `state.tick` fall short of its call count by exactly the stall.
//   · the simulation keeps running after a game over, consuming rng forever. A
//     fixture that reaches one still hashes deterministically but stops testing
//     gameplay, so each scenario is picked to stay inside live play — the summary
//     printed at the end reports the final phase so that stays honest.
//
// Node fs and Prettier are used here on purpose: scripts live outside src/core,
// so the core's dependency-free/headless boundary does not apply to them.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { hashState } from '../src/core/game';
import {
  IDLE,
  encodeIntents,
  runReplay,
  type Intents,
  type IntentRow,
  type ReplayFixture,
} from '../tests/replays/format';
import type { Dir, LevelData, PlayerIntent } from '../src/core/types';

// The first tick on which the pad is live: the intro curtain lasts STAGE_INTRO_S
// (2 s = 120 ticks) and the tick that lifts it is still gated, so scripted input
// before this does nothing at all.
const CONTROL_FROM = 121;

// Dir aliases, so the scripts below read as movement rather than as digits.
const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

type Segment = readonly [Dir | null, number];

interface Scenario {
  name: string;
  levelFile: string;
  seed: number;
  players: 1 | 2;
  stageNumber: number;
  ticks: number;
  // The pad, per `stepGame` call (1-based). Called once per call, in order.
  script: (call: number) => Intents;
}

// --- Script helpers --------------------------------------------------------

function pad(dir: Dir | null, fire = false, pause = false): PlayerIntent {
  return { dir, fire, pause };
}

// Walk a cyclic list of [direction, ticks] legs starting at `from`. Cyclic so a
// script cannot run off its own end into an accidental idle tail.
function patrol(
  call: number,
  from: number,
  legs: readonly Segment[],
): Dir | null {
  if (call < from) return null;
  let total = 0;
  for (const leg of legs) total += leg[1];
  let t = (call - from) % total;
  for (const [dir, len] of legs) {
    if (t < len) return dir;
    t -= len;
  }
  return null;
}

// Firing is edge-triggered (bullets.ts): one true tick every `period` is one shot
// attempt. Attempts made while at the airborne-bullet cap are simply refused, so
// a short period costs nothing and keeps the tank shooting as fast as it may.
function firePulse(call: number, from: number, period: number): boolean {
  return call >= from && (call - from) % period === 0;
}

// A pause PRESS on `at` and again on `until` — the first freezes the simulation,
// the second thaws it. Both are single-tick presses because pause is an edge.
function pausePress(call: number, at: number, until: number): boolean {
  return call === at || call === until;
}

// --- Scenarios -------------------------------------------------------------

// Turbo cadence: one fire press every 4 ticks. This is what the input layer's
// autofire pulse looks like (bullets.ts), and at tier 0 — one airborne bullet —
// most presses are simply refused, so the tank shoots exactly as fast as its
// bullets clear rather than 15 times a second.
const TURBO = 4;

// P1's patrol on level-mixed, and P2's: different leg lengths and a 6-tick fire
// offset so the two never march or shoot in lockstep (which would collapse a
// 2-player run into one player's behaviour played twice).
const P1_LEGS: readonly Segment[] = [
  [LEFT, 60],
  [UP, 40],
  [RIGHT, 90],
  [DOWN, 60],
  [LEFT, 90],
  [UP, 60],
];
const P2_LEGS: readonly Segment[] = [
  [RIGHT, 50],
  [UP, 60],
  [LEFT, 80],
  [DOWN, 40],
  [RIGHT, 80],
  [UP, 50],
];

// replay3's lawnmower: full-width horizontal legs separated by 30 u vertical
// steps. 30 u is deliberately under the 32 u band in which a 16 u tank overlaps a
// 16 u power-up, so consecutive passes leave no gap and the sweep covers the whole
// field — collecting a drop is then a property of the route, not of luck.
const MOW: readonly Segment[] = [
  [UP, 40],
  [RIGHT, 270],
  [UP, 40],
  [LEFT, 270],
  [UP, 40],
  [RIGHT, 270],
  [UP, 40],
  [LEFT, 270],
  [UP, 40],
  [RIGHT, 270],
  [UP, 40],
  [LEFT, 270],
  [DOWN, 40],
  [RIGHT, 270],
  [DOWN, 40],
  [LEFT, 270],
  [DOWN, 40],
  [RIGHT, 270],
  [DOWN, 40],
  [LEFT, 270],
  [DOWN, 40],
  [RIGHT, 270],
  [DOWN, 40],
  [LEFT, 270],
];

// The seeds and stage numbers below are chosen, not arbitrary: they were picked by
// sweeping seed × stage × route and keeping runs that stay inside live play for
// the whole recording while producing kills, drops and terrain damage. The three
// stage numbers differ on purpose — the spawn cadence formula (P-25) is a function
// of stage and player count, so the set covers three different cadences.
//
// The seeds were re-swept in T10 after the ROM calibration (fidelity §16) moved
// the spawn cycle's starting point, the spawn animation length, the blocked-spawn
// retry, the power-up drop table and the drop grid. The routes are unchanged —
// the same three scripts, re-seeded — because the runs they describe are still
// the runs worth recording; only which seed produces one survived the change.
const SCENARIOS: readonly Scenario[] = [
  // replay1 — one player patrolling level-basic around the brick diamond and
  // firing throughout. Shooting into blocked lanes is deliberate: the sustained
  // terrain damage is half the point, and chewing through a wall is what lets the
  // patrol keep its shape. The player dies once here and comes back, so the run
  // also covers the death → life → respawn path end to end.
  {
    name: 'replay1',
    levelFile: 'level-basic.json',
    seed: 17,
    players: 1,
    stageNumber: 16,
    ticks: 1800,
    script: (call) => [
      pad(
        patrol(call, CONTROL_FROM, [
          [UP, 60],
          [RIGHT, 130],
          [UP, 40],
          [LEFT, 130],
          [DOWN, 30],
          [RIGHT, 100],
          [UP, 30],
          [LEFT, 100],
        ]),
        firePulse(call, CONTROL_FROM, TURBO),
      ),
      IDLE,
    ],
  },

  // replay2 — two players on level-mixed (all six terrain kinds, partial tiles, a
  // queue carrying armor and power enemies). Both drive up the clear columns
  // either side of the base until the water band stops them on the same row, then
  // P1 turns and shoots P2 down the open lane between them: friendly fire (P-08),
  // which the patrol that follows keeps producing. A pause press mid-run freezes
  // the whole simulation for 61 calls (P-26) — the fixture's final `state.tick`
  // falls exactly that far short of its call count.
  {
    name: 'replay2',
    levelFile: 'level-mixed.json',
    seed: 253,
    players: 2,
    stageNumber: 3,
    ticks: 1800,
    script: (call) => {
      // Beat 1 (121–220): both climb to the water band and stop on the same row.
      if (call < 221) {
        const dir = call >= CONTROL_FROM ? UP : null;
        return [pad(dir), pad(dir)];
      }
      // Beat 2 (221–330): P1 turns right and fires down the lane; P2 holds still
      // and takes the stun.
      if (call < 331) {
        return [pad(RIGHT, firePulse(call, 221, TURBO)), IDLE];
      }
      // Beat 3 (331–end): both patrol and fire; P1 also presses pause twice.
      return [
        pad(
          patrol(call, 331, P1_LEGS),
          firePulse(call, 331, TURBO),
          pausePress(call, 700, 761),
        ),
        pad(patrol(call, 331, P2_LEGS), firePulse(call, 337, TURBO)),
      ];
    },
  },

  // replay3 — the long one: a lawnmower sweep of the near-empty level-open at the
  // turbo cadence, so enemies keep dying, the spawner keeps feeding (carrier
  // ordinals 4 and 11 both land inside the run), power-ups drop, and the sweep
  // walks over both of them.
  {
    name: 'replay3',
    levelFile: 'level-open.json',
    seed: 55,
    players: 1,
    stageNumber: 8,
    ticks: 2700,
    script: (call) => [
      pad(
        patrol(call, CONTROL_FROM, MOW),
        firePulse(call, CONTROL_FROM, TURBO),
      ),
      IDLE,
    ],
  },
];

// --- Recording -------------------------------------------------------------

interface Recording {
  rows: IntentRow[];
  hash: number;
  eventCount: number;
  firstEvents: string[];
  // Summary only — not part of the fixture, printed so a re-record that quietly
  // stops exercising the game is visible immediately.
  tick: number;
  phase: string;
  kinds: number;
  enemiesDestroyed: number;
  powerupsSpawned: number;
  powerupsCollected: number;
  terrainHits: number;
}

const FIXTURES_DIR = new URL('../tests/fixtures/', import.meta.url);
const REPLAYS_DIR = new URL('../tests/replays/', import.meta.url);

function loadLevel(file: string): LevelData {
  const url = new URL(file, FIXTURES_DIR);
  return JSON.parse(readFileSync(url, 'utf8')) as LevelData;
}

// Encode the scenario's script to the sparse row list, then record by REPLAYING
// those rows through the shared runner — never by stepping the script directly.
// The `expected` block a fixture carries therefore describes what the decoder
// does with the rows that were written, which is exactly what replay.test.ts will
// do with them; an encoder/decoder mismatch cannot hide inside a recording.
function record(scenario: Scenario, level: LevelData): Recording {
  const rows = encodeIntents(scenario.script, scenario.ticks);
  const { state, events } = runReplay(
    level,
    {
      players: scenario.players,
      seed: scenario.seed,
      stageNumber: scenario.stageNumber,
    },
    scenario.ticks,
    rows,
  );

  const kinds = new Set<string>();
  let enemiesDestroyed = 0;
  let powerupsSpawned = 0;
  let powerupsCollected = 0;
  let terrainHits = 0;
  for (const e of events) {
    kinds.add(e.t);
    if (e.t === 'tankDestroyed' && e.kind === 'enemy') enemiesDestroyed += 1;
    if (e.t === 'powerupSpawned') powerupsSpawned += 1;
    if (e.t === 'powerupCollected') powerupsCollected += 1;
    if (e.t === 'brickHit' || e.t === 'steelHit') terrainHits += 1;
  }

  return {
    rows,
    hash: hashState(state),
    eventCount: events.length,
    firstEvents: events.slice(0, 50).map((e) => e.t),
    tick: state.tick,
    phase: state.phase,
    kinds: kinds.size,
    enemiesDestroyed,
    powerupsSpawned,
    powerupsCollected,
    terrainHits,
  };
}

async function writeFixture(
  scenario: Scenario,
  rec: Recording,
  level: LevelData,
): Promise<void> {
  const url = new URL(`${scenario.name}.json`, REPLAYS_DIR);
  const path = fileURLToPath(url);
  // Typed as the shared ReplayFixture so the writer and the runner cannot drift:
  // a field renamed in tests/replays/format.ts breaks compilation here.
  const fixture: ReplayFixture = {
    version: 1,
    levelId: level.id,
    seed: scenario.seed,
    players: scenario.players,
    stageNumber: scenario.stageNumber,
    ticks: scenario.ticks,
    intents: rec.rows,
    expected: {
      hash: rec.hash,
      eventCount: rec.eventCount,
      firstEvents: rec.firstEvents,
    },
  };
  const config = await resolveConfig(path);
  const text = await format(JSON.stringify(fixture), {
    ...config,
    filepath: path,
  });
  writeFileSync(url, text);
}

async function main(): Promise<void> {
  for (const scenario of SCENARIOS) {
    const level = loadLevel(scenario.levelFile);
    const rec = record(scenario, level);
    await writeFixture(scenario, rec, level);
    console.log(
      `${scenario.name}: level=${level.id} seed=${scenario.seed} ` +
        `players=${scenario.players} stage=${scenario.stageNumber}\n` +
        `  calls=${scenario.ticks} tick=${rec.tick} phase=${rec.phase} ` +
        `intentRows=${rec.rows.length}\n` +
        `  events=${rec.eventCount} kinds=${rec.kinds} ` +
        `enemiesDestroyed=${rec.enemiesDestroyed} ` +
        `terrainHits=${rec.terrainHits}\n` +
        `  powerups spawned=${rec.powerupsSpawned} collected=${rec.powerupsCollected} ` +
        `hash=${rec.hash}`,
    );
  }
}

await main();
