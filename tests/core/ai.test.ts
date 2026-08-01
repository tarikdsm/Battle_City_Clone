// tests/core/ai.test.ts — deterministic enemy AI (T1.6, fidelity §9 + §3.2).
// Parity coverage tagged in the test names: P-23 (same seed ⇒ identical state
// hash — the AI is the biggest RNG consumer in the tick, so its draw ORDER is
// what the golden replays of T1.8 will bake in) and P-17 (a Clock-frozen enemy
// makes no decisions at all: no timer, no rng, no move, no shot).
//
// Everything that can be is driven through `stepGame`, so the tests exercise the
// real pipeline position (system #3, before movement). The two internal helpers
// the AI exports — `decide` and `towardDir` — are called directly where the test
// is about the decision procedure itself rather than about a tick.
import { describe, expect, it } from 'vitest';
import { createGame, hashState, stepGame } from '../../src/core/game';
import { aiSystem, decide, towardDir } from '../../src/core/systems/ai';
import { makeTank, moveTank, probeMove } from '../../src/core/systems/movement';
import {
  AI_ALIGN_TOLERANCE,
  AI_FIRE_ALIGNED_PS,
  AI_FIRE_RANDOM_PS,
  AI_LATTICE_RECONSIDER,
  AI_TIMER_MIN,
  AI_TIMER_SPAN,
  AI_W_BASE_BASE,
  AI_W_BASE_MAX,
  AI_W_BASE_PER_STAGE,
  AI_W_KEEP,
  AI_W_PLAYER,
  EAGLE_TILE,
  ENEMY_SPEED,
  STAGE_CAP,
  TICK_S,
  TILE,
} from '../../src/core/constants';
import { createRng, nextFloat } from '../../src/core/rng';
import { NULL_INTENT } from '../../src/core/types';
import type { GameEvent } from '../../src/core/events';
import type {
  Dir,
  EnemyType,
  GameState,
  LevelData,
  PlayerIntent,
  Tank,
} from '../../src/core/types';

// Dir literals (types.ts: 0 Up, 1 Right, 2 Down, 3 Left).
const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const NO_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  NULL_INTENT,
  NULL_INTENT,
];

// mulberry32 advances its state by exactly this much per draw (rng.ts), which is
// what lets a test count the draws a call consumed without instrumenting the rng.
const RNG_STEP = 0x6d2b79f5;

const BASIC_STEP = ENEMY_SPEED.basic * TICK_S; // 0.5 u per tick

// --- Fixtures --------------------------------------------------------------

function level(rows: string[], enemies: EnemyType[] = []): LevelData {
  return {
    version: 1,
    id: 'ai',
    name: 'AI Test',
    terrain: rows,
    enemies,
    noAutoBase: true,
  };
}

function emptyRows(): string[] {
  return Array.from({ length: 13 }, () => '.'.repeat(13));
}

function openField(enemies: EnemyType[] = []): LevelData {
  return level(emptyRows(), enemies);
}

// A stage-shaped field (bricks, steel, water) with the real base ring, used by
// the determinism / golden-replay runs so the AI meets every kind of blocker.
function stageLikeLevel(): LevelData {
  const rows = [
    '.....B.B.....',
    '.BB.BB.BB.BB.',
    '.BB.BB.BB.BB.',
    '.B.........B.',
    '.B.SS...SS.B.',
    '...S.....S...',
    'BB.S..W..S.BB',
    '...S.....S...',
    '.B.SS...SS.B.',
    '.B.........B.',
    '.BB.BB.BB.BB.',
    '.BB.B...B.BB.',
    '....B...B....',
  ];
  return {
    version: 1,
    id: 'ai-stage',
    name: 'AI Stage',
    terrain: rows,
    enemies: Array.from({ length: 20 }, (): EnemyType => 'basic'),
  };
}

// Field of steel with a 1-tile-wide vertical corridor at column 6 (the eagle's
// column) spanning `openRows`. Everything else is solid, so an enemy inside can
// only ever face Up or Down.
function corridorRows(openRows: readonly number[]): string[] {
  return Array.from({ length: 13 }, (_, ty) =>
    Array.from({ length: 13 }, (_, tx) =>
      tx === 6 && openRows.includes(ty) ? '.' : 'S',
    ).join(''),
  );
}

function addEnemy(s: GameState, init: Partial<Tank> = {}): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'enemy',
    enemyType: 'basic',
    x: 0,
    y: 0,
    dir: DOWN,
    ...init,
  });
  s.tanks.push(t);
  return t;
}

function addPlayer(s: GameState, x: number, y: number, dir: Dir = UP): Tank {
  const t = makeTank({
    id: s.tanks.length,
    kind: 'player',
    playerIndex: 0,
    x,
    y,
    dir,
  });
  s.tanks.push(t);
  return t;
}

// --- Drivers ---------------------------------------------------------------

function stepN(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) stepGame(s, NO_INTENTS);
}

function only<K extends GameEvent['t']>(
  evs: readonly GameEvent[],
  t: K,
): Extract<GameEvent, { t: K }>[] {
  return evs.filter((e): e is Extract<GameEvent, { t: K }> => e.t === t);
}

// How many rng draws moved the state from `before` to `after` (-1 = not reachable
// within a sane budget, which means something other than the rng touched it).
function drawsBetween(before: number, after: number): number {
  let s = before | 0;
  for (let n = 0; n <= 8; n++) {
    if (s === (after | 0)) return n;
    s = (s + RNG_STEP) | 0;
  }
  return -1;
}

// The first `n` floats a stream seeded with `seed` produces — the independent
// reference a draw-ORDER assertion compares the implementation against.
function streamOf(seed: number, n: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => nextFloat(rng));
}

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

// --- 1, 2 · determinism (P-23) ---------------------------------------------

describe('ai — determinism (P-23)', () => {
  it('P-23: two runs of the same seed hash identically at ticks 200/400/600', () => {
    const opts = { players: 1 as const, seed: 777, stageNumber: 5 };
    const a = createGame(stageLikeLevel(), opts);
    const b = createGame(stageLikeLevel(), opts);
    const marks = [200, 400, 600];

    let tick = 0;
    for (const mark of marks) {
      stepN(a, mark - tick);
      stepN(b, mark - tick);
      tick = mark;
      expect(hashState(a)).toBe(hashState(b));
    }
    // The run must actually have been busy — otherwise the equality is vacuous.
    expect(a.tanks.length).toBeGreaterThan(0);
    expect(a.rng.s).not.toBe(createGame(stageLikeLevel(), opts).rng.s);
  });

  it('P-23: golden mini-replay — 300 ticks of seed 777 hash to a recorded value', () => {
    const s = createGame(stageLikeLevel(), {
      players: 1,
      seed: 777,
      stageNumber: 5,
    });
    stepN(s, 300);
    // Recorded from the first green run of this implementation. It is a
    // regression guard on the whole stream — any change to the AI's draw order
    // (or to any earlier system's) moves it, so a diff here is a decision, not a
    // nuisance: re-record it only with the reason written down.
    expect(hashState(s)).toBe(0x6ad8e8b2);
  });

  it('P-23: pins the rng draw order lattice → weight → uniform → timer → fire', () => {
    // A dead-end corridor cell: Left/Right/Down are solid, so `open` is [Up] and
    // every weight is zero — the decision therefore always spends r on the
    // weighted roll and then a second draw on the uniform pick. The tank is
    // staged mid-crossing (prev in the tile above) with an expired timer, so the
    // lattice roll happens too. Expected stream positions:
    //   r0 lattice · r1 weights · r2 uniform · r3 timer · r4 fire
    //
    // Limit worth knowing: this cannot separate draw 0 from draw 1. Swapping the
    // lattice roll with the weighted roll leaves the timer's position, the total
    // count and the chosen direction identical, so only the golden hash above
    // guards that particular pair.
    const seed = 20260801;
    const s = createGame(level(corridorRows([9, 10])), {
      players: 1,
      seed,
      stageNumber: 1,
    });
    const e = addEnemy(s, { x: 96, y: 160, dir: DOWN, aiTimerT: 0 });
    e.prevY = 160 - TILE; // crossed a tile line during the previous tick

    const r = streamOf(seed, 5);
    aiSystem(s, NO_INTENTS);

    expect(e.dir).toBe(UP); // the only open direction
    // The timer must be built from the FOURTH draw: any reordering (dropping the
    // lattice roll when the timer already expired, resetting the timer before the
    // decision, or skipping the uniform pick) lands on a different value.
    near(e.aiTimerT, AI_TIMER_MIN + r[3] * AI_TIMER_SPAN);
    expect(drawsBetween(seed, s.rng.s)).toBe(5); // …and exactly five were spent
    // The fifth draw is the fire roll, and nothing is aligned down here.
    expect(only(s.events, 'shotFired').length).toBe(
      r[4] < AI_FIRE_RANDOM_PS * TICK_S ? 1 : 0,
    );
  });

  it('spends no rng on a tank with no trigger: only the fire roll', () => {
    const s = createGame(openField(), { players: 1, seed: 5, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP, aiTimerT: 1 });
    const before = s.rng.s;
    aiSystem(s, NO_INTENTS);
    expect(drawsBetween(before, s.rng.s)).toBe(1);
    near(e.aiTimerT, 1 - TICK_S); // timer stepped, not reset
  });
});

// --- 3 · towardDir ---------------------------------------------------------

describe('ai — towardDir', () => {
  it('picks the axis with the larger |delta|', () => {
    expect(towardDir(0, 0, 100, 40)).toBe(RIGHT);
    expect(towardDir(0, 0, 40, 100)).toBe(DOWN);
    expect(towardDir(0, 0, -100, 40)).toBe(LEFT);
    expect(towardDir(0, 0, -100, -40)).toBe(LEFT);
    expect(towardDir(0, 0, 40, -100)).toBe(UP);
    expect(towardDir(0, 0, -40, -100)).toBe(UP);
    expect(towardDir(100, 100, 0, 90)).toBe(LEFT);
    expect(towardDir(100, 100, 110, 200)).toBe(DOWN);
  });

  it('breaks an exact tie toward the vertical axis', () => {
    expect(towardDir(0, 0, 40, 40)).toBe(DOWN);
    expect(towardDir(0, 0, -40, 40)).toBe(DOWN);
    expect(towardDir(0, 0, 40, -40)).toBe(UP);
    expect(towardDir(0, 0, -40, -40)).toBe(UP);
  });
});

// --- 4 · blocked tanks never ram -------------------------------------------

describe('ai — blocked directions', () => {
  it('a dead-end corridor is left within one decision, never rammed', () => {
    // Corridor rows 1..10 at column 6; the enemy starts at the bottom facing the
    // dead end, so Down/Left/Right are all solid on its very first tick.
    const openRows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = createGame(level(corridorRows(openRows)), {
      players: 1,
      seed: 99,
      stageNumber: 1,
    });
    const e = addEnemy(s, { x: 96, y: 160, dir: DOWN });

    stepGame(s, NO_INTENTS);
    expect(e.dir).toBe(UP); // reversed on the first decision

    for (let i = 0; i < 119; i++) {
      stepGame(s, NO_INTENTS);
      expect(e.x).toBe(96); // never leaves (or overlaps the walls of) the lane
      expect(e.y).toBeGreaterThanOrEqual(16);
      expect(e.y).toBeLessThanOrEqual(160);
    }
    expect(160 - e.y).toBeGreaterThan(0); // net displacement: it kept moving
  });

  it('a fully enclosed tank reverses without drawing for a direction', () => {
    const rows = Array.from({ length: 13 }, (_, ty) =>
      Array.from({ length: 13 }, (_, tx) =>
        tx === 6 && ty === 6 ? '.' : 'S',
      ).join(''),
    );
    const s = createGame(level(rows), { players: 1, seed: 7, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: DOWN });

    const before = s.rng.s;
    stepGame(s, NO_INTENTS);
    expect(e.dir).toBe(UP);
    expect(e.x).toBe(96);
    expect(e.y).toBe(96);
    // Only the timer reset and the fire roll — the reverse itself is not rolled.
    expect(drawsBetween(before, s.rng.s)).toBe(2);

    stepGame(s, NO_INTENTS);
    expect(e.dir).toBe(DOWN); // still blocked → reverses again
  });
});

// --- 5, 6 · firing ---------------------------------------------------------

describe('ai — firing rolls', () => {
  // Corridor in the eagle's column with the top capped: the only open direction
  // is Down, so the tank stays lined up on the eagle for the whole window and the
  // aligned rate is what the run measures.
  function alignedRun(seed: number): boolean {
    const s = createGame(level(corridorRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), {
      players: 1,
      seed,
      stageNumber: 1,
    });
    addEnemy(s, { x: 96, y: 32, dir: DOWN });
    for (let i = 0; i < 120; i++) {
      stepGame(s, NO_INTENTS);
      if (only(s.events, 'shotFired').length > 0) return true;
    }
    return false;
  }

  function idleRun(seed: number): boolean {
    const s = createGame(openField(), { players: 1, seed, stageNumber: 1 });
    s.eagleAlive = false; // nothing on the field to line up on at all
    addEnemy(s, { x: 96, y: 96, dir: UP });
    for (let i = 0; i < 120; i++) {
      stepGame(s, NO_INTENTS);
      if (only(s.events, 'shotFired').length > 0) return true;
    }
    return false;
  }

  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

  it('lined up on the eagle: fires within 2 s in nearly every seed', () => {
    // p = AI_FIRE_ALIGNED_PS/60 per tick ⇒ P(fire within 120 ticks) = 0.837 in
    // theory, 0.822 measured over 500 seeds. Seeds 1..20 score 17.
    //
    // The SPEC's acceptance criterion is 16 of 20 (80%), which sits just 0.25 sd
    // below the mean of 16.44 (sd 1.71): an arbitrary seed set fails it 28% of
    // the time. It is deterministic here only because the seeds are fixed, and
    // any upstream rng draw added later reshuffles which of them hit — a red
    // build for no behavioural reason. 13 is therefore the OPERATING bound:
    // 2.0 sd of headroom, P(false failure) = 1.7%. The rate itself is guarded
    // sharply by the shots/s tests below, not by this one.
    const hits = SEEDS.filter(alignedRun).length;
    expect(hits).toBeGreaterThanOrEqual(13);
  });

  it('lined up on nothing: the 0.4/s baseline fires in 25%–90% of runs', () => {
    // p = AI_FIRE_RANDOM_PS/60 per tick ⇒ P(fire within 120 ticks) ≈ 0.55.
    const hits = SEEDS.filter(idleRun).length;
    expect(hits).toBeGreaterThanOrEqual(5);
    expect(hits).toBeLessThanOrEqual(18);
  });

  // Shots/s measured over `rolls` held ticks in a fixed pose (the tank is put
  // back after every call, so the alignment under test never drifts).
  function shotRate(s: GameState, e: Tank, pose: Partial<Tank>, rolls: number) {
    let shots = 0;
    for (let i = 0; i < rolls; i++) {
      Object.assign(e, pose);
      e.aiTimerT = 10; // far from expiry: no decision, no extra draws
      e.bulletsAirborne = 0; // the 1-bullet cap is not what is being measured
      s.events.length = 0;
      aiSystem(s, NO_INTENTS);
      shots += only(s.events, 'shotFired').length;
    }
    return shots / rolls / TICK_S;
  }

  // Threshold midway between the two rates (0.65/s). At ROLLS = 8000 the aligned
  // arm has mean 120 shots, sd 10.87, threshold 86.7 → 3.07 sd; the random arm
  // has mean 53.3, sd 7.28 → 4.58 sd. (At 4000 those were only 2.17 and 3.23,
  // and no threshold at that n reaches 3 sd on BOTH arms: 0.4 + 3σ = 0.632 /s
  // already exceeds 0.9 − 3σ = 0.554 /s.) These are bare aiSystem calls, so the
  // extra 8000 iterations cost single-digit milliseconds.
  const MIDPOINT = (AI_FIRE_RANDOM_PS + AI_FIRE_ALIGNED_PS) / 2;
  const ROLLS = 8000;

  it('alignment needs the target AHEAD along the facing axis', () => {
    const s = createGame(openField(), { players: 1, seed: 3, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP });
    expect(e.x + TILE / 2).toBe(EAGLE_TILE[0] * TILE + TILE / 2); // eagle's column

    // Facing away from the eagle (it is below) → the 0.4/s baseline …
    expect(shotRate(s, e, { x: 96, y: 96, dir: UP }, ROLLS)).toBeLessThan(
      MIDPOINT,
    );
    // … and turning to face it → the 0.9/s aligned rate.
    expect(shotRate(s, e, { x: 96, y: 96, dir: DOWN }, ROLLS)).toBeGreaterThan(
      MIDPOINT,
    );
  });

  it('a player at exactly the lateral tolerance still counts as aligned', () => {
    const s = createGame(openField(), { players: 1, seed: 11, stageNumber: 1 });
    s.eagleAlive = false; // the player is the only possible target
    const e = addEnemy(s, { x: 96, y: 32, dir: DOWN });
    const p = addPlayer(s, 96 + AI_ALIGN_TOLERANCE, 160);
    const pose = { x: 96, y: 32, dir: DOWN };

    expect(shotRate(s, e, pose, ROLLS)).toBeGreaterThan(MIDPOINT);

    p.x = 96 + AI_ALIGN_TOLERANCE + 1; // one unit past → baseline again
    expect(shotRate(s, e, pose, ROLLS)).toBeLessThan(MIDPOINT);
  });
});

// --- 7 · frozen enemies (P-17) ---------------------------------------------

describe('ai — frozen enemies (P-17)', () => {
  it('P-17: a frozen enemy draws nothing, moves nothing and pauses its timer', () => {
    const s = createGame(openField(), {
      players: 1,
      seed: 4242,
      stageNumber: 1,
    });
    const e = addEnemy(s, {
      x: 96,
      y: 96,
      dir: UP,
      frozenT: 1,
      aiTimerT: 0.75,
    });
    const rngBefore = s.rng.s;

    stepN(s, 59); // stageflow decays frozenT; 1 s − 59 ticks is still > 0

    expect(e.frozenT).toBeGreaterThan(0);
    expect(s.rng.s).toBe(rngBefore); // the ONLY tank consumed no randomness
    expect(e.x).toBe(96);
    expect(e.y).toBe(96);
    expect(e.aiTimerT).toBe(0.75); // paused, not stepped
    expect(e.dir).toBe(UP);

    stepGame(s, NO_INTENTS); // 60th tick: the freeze ends and the AI resumes
    expect(e.frozenT).toBe(0);
    expect(s.rng.s).not.toBe(rngBefore);
    near(e.aiTimerT, 0.75 - TICK_S);
    expect(e.y).toBeLessThan(96); // moving again, still facing Up
  });
});

// --- 8, 9 · direction weights ----------------------------------------------

// Sample `decide` with all four directions open and the three weighted
// candidates on distinct axes: keep = Up, base = Down (the eagle is below),
// player = Left. A weighted pick spends exactly one draw and a uniform pick two,
// so each sample is classified EXACTLY — no statistical unmixing.
function sampleDecisions(
  stageNumber: number,
  samples: number,
): Record<'keep' | 'base' | 'player' | 'uniform' | 'other', number> {
  const s = createGame(openField(), {
    players: 1,
    seed: 20260806,
    stageNumber,
  });
  const e = addEnemy(s, { x: 96, y: 96, dir: UP });
  addPlayer(s, 16, 96);

  const counts = { keep: 0, base: 0, player: 0, uniform: 0, other: 0 };
  for (let i = 0; i < samples; i++) {
    e.x = 96;
    e.y = 96;
    e.dir = UP;
    const before = s.rng.s;
    const d = decide(s, e);
    const draws = drawsBetween(before, s.rng.s);
    if (draws === 2) counts.uniform++;
    else if (draws === 1 && d === UP) counts.keep++;
    else if (draws === 1 && d === DOWN) counts.base++;
    else if (draws === 1 && d === LEFT) counts.player++;
    else counts.other++;
  }
  return counts;
}

describe('ai — direction weights (fidelity §9)', () => {
  const SAMPLES = 5000;
  const TOL = 0.03;

  it('stage 1: keep 40%, base 20.5%, player 10%, uniform 29.5% (±3%)', () => {
    const c = sampleDecisions(1, SAMPLES);
    const wBase = AI_W_BASE_BASE + AI_W_BASE_PER_STAGE; // 0.205
    expect(c.other).toBe(0); // a weighted pick is always one of the three
    expect(Math.abs(c.keep / SAMPLES - AI_W_KEEP)).toBeLessThan(TOL);
    expect(Math.abs(c.base / SAMPLES - wBase)).toBeLessThan(TOL);
    expect(Math.abs(c.player / SAMPLES - AI_W_PLAYER)).toBeLessThan(TOL);
    expect(
      Math.abs(c.uniform / SAMPLES - (1 - AI_W_KEEP - wBase - AI_W_PLAYER)),
    ).toBeLessThan(TOL);
  });

  it('stage 35: the base weight has grown to 37.5% (±3%)', () => {
    const c = sampleDecisions(STAGE_CAP, SAMPLES);
    const wBase = Math.min(
      AI_W_BASE_MAX,
      AI_W_BASE_BASE + AI_W_BASE_PER_STAGE * STAGE_CAP,
    );
    expect(wBase).toBe(0.375);
    expect(Math.abs(c.base / SAMPLES - wBase)).toBeLessThan(TOL);
    expect(Math.abs(c.keep / SAMPLES - AI_W_KEEP)).toBeLessThan(TOL);
    expect(Math.abs(c.player / SAMPLES - AI_W_PLAYER)).toBeLessThan(TOL);
  });

  it('the stage TERM stops growing at STAGE_CAP: stage 200 behaves like 35', () => {
    // (The 40% ceiling on the weight itself is unreachable while
    // AI_W_BASE_BASE + AI_W_BASE_PER_STAGE * STAGE_CAP = 0.375, so it has no
    // coverage here — only the stage clamp does.)
    const c = sampleDecisions(200, SAMPLES);
    expect(Math.abs(c.base / SAMPLES - 0.375)).toBeLessThan(TOL);
  });

  it('maps each roll through the cumulative order keep → base → player', () => {
    // The marginals above are invariant under permuting the cumulative order, so
    // they cannot see a keep/base swap — but every seeded run can, because the
    // same roll would then pick a different direction. This pins the MAPPING:
    // r is read from a clone of the rng (which does not consume it) and checked
    // against the order fidelity §9 documents.
    const s = createGame(openField(), {
      players: 1,
      seed: 424242,
      stageNumber: 1,
    });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP });
    addPlayer(s, 16, 96);
    const wBase = AI_W_BASE_BASE + AI_W_BASE_PER_STAGE;

    let weighted = 0;
    for (let i = 0; i < 2000; i++) {
      e.x = 96;
      e.y = 96;
      e.dir = UP;
      const r = nextFloat(createRng(s.rng.s)); // the very draw decide is about to take
      const d = decide(s, e);
      if (r < AI_W_KEEP) {
        expect(d).toBe(UP); // keep
        weighted++;
      } else if (r < AI_W_KEEP + wBase) {
        expect(d).toBe(DOWN); // toward the eagle
        weighted++;
      } else if (r < AI_W_KEEP + wBase + AI_W_PLAYER) {
        expect(d).toBe(LEFT); // toward the player
        weighted++;
      }
    }
    expect(weighted).toBeGreaterThan(1200); // ~70.5% of the rolls are weighted
  });

  it('excludes blocked directions before rolling', () => {
    // Steel at tile (5,6), flush against the tank's left face: the player-ward
    // direction is blocked, so it can never be chosen — by weight or uniformly.
    const rows = emptyRows();
    rows[6] = '.....S.......';
    const s = createGame(level(rows), { players: 1, seed: 5, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP });
    addPlayer(s, 16, 96);
    expect(probeMove(s, e, LEFT, BASIC_STEP)).toBe(0);
    for (let i = 0; i < 500; i++) {
      e.x = 96;
      e.y = 96;
      e.dir = UP;
      expect(decide(s, e)).not.toBe(LEFT);
    }
  });

  it('the lattice roll fires through the REAL pipeline, not only staged prev', () => {
    // The unit test below stages prevX/prevY by hand and calls aiSystem
    // directly, so it cannot see whether the pipeline actually delivers a usable
    // prev to system #3. This one drives whole `stepGame` ticks: an enemy runs
    // up a clear lane with its timer pinned far from expiry, so a decision can
    // ONLY come from a lattice roll. Crossings are counted exactly as the AI
    // defines them, read at the tick boundary.
    const s = createGame(openField(), {
      players: 1,
      seed: 31337,
      stageNumber: 1,
    });
    const e = addEnemy(s, { x: 96, y: 176, dir: UP });
    let crossings = 0;
    let decisions = 0;
    for (let i = 0; i < 3000; i++) {
      e.aiTimerT = 10;
      e.dir = UP;
      e.x = 96;
      if (Math.floor(e.prevY / TILE) !== Math.floor(e.y / TILE)) crossings++;
      stepGame(s, NO_INTENTS);
      if (e.aiTimerT !== 10 - TICK_S) decisions++;
      if (e.y < 24) {
        e.y = 176; // another lap up the lane
        e.prevY = 176;
      }
    }
    expect(crossings).toBeGreaterThan(50);
    expect(decisions).toBeGreaterThan(0); // ≈ AI_LATTICE_RECONSIDER × crossings
    expect(decisions / crossings).toBeGreaterThan(0.1);
    expect(decisions / crossings).toBeLessThan(0.45);
  });

  it('a lattice crossing reconsiders with the documented probability', () => {
    // Straight, unobstructed lane: the ONLY decisions come from lattice rolls
    // (the timer is held far from expiry), so the roll's threshold is what the
    // reset count measures.
    const s = createGame(openField(), { players: 1, seed: 88, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP });
    let crossings = 0;
    let decisions = 0;
    for (let i = 0; i < 26000; i++) {
      e.x = 96;
      e.y = 8 + (i % 26) * 0.5; // sweeps across tile lines
      e.prevX = e.x;
      e.prevY = e.y + BASIC_STEP; // moved Up by one tick's worth
      e.dir = UP;
      e.aiTimerT = 10;
      if (Math.floor(e.prevY / TILE) !== Math.floor(e.y / TILE)) crossings++;
      aiSystem(s, NO_INTENTS);
      if (e.aiTimerT !== 10 - TICK_S) decisions++;
    }
    expect(crossings).toBeGreaterThan(100);
    expect(decisions / crossings).toBeCloseTo(AI_LATTICE_RECONSIDER, 1);
  });
});

// --- 10 · aiTimerT is hashed -----------------------------------------------

describe('ai — contract amendment', () => {
  it('P-23: aiTimerT participates in the state hash', () => {
    const opts = { players: 1 as const, seed: 1, stageNumber: 1 };
    const a = createGame(openField(), opts);
    const b = createGame(openField(), opts);
    addEnemy(a, { x: 96, y: 96 });
    addEnemy(b, { x: 96, y: 96 });
    expect(hashState(a)).toBe(hashState(b));

    b.tanks[0].aiTimerT = 0.5;
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it('makeTank defaults aiTimerT to 0', () => {
    expect(makeTank({ id: 0, kind: 'enemy', x: 0, y: 0 }).aiTimerT).toBe(0);
  });

  it('enemy prevX/prevY hold the START of the tick (interpolation contract)', () => {
    const s = createGame(openField(), { players: 1, seed: 6, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: UP, aiTimerT: 10 });
    stepGame(s, NO_INTENTS);
    expect(e.prevY).toBe(96); // where it was when the tick began
    expect(e.y).toBe(96 - BASIC_STEP); // where it ended up
  });
});

// --- 11 · probeMove --------------------------------------------------------

describe('movement — probeMove (shared clamp with moveTank)', () => {
  it('returns the full distance in the open field and never mutates', () => {
    const s = createGame(openField(), { players: 1, seed: 2, stageNumber: 1 });
    const e = addEnemy(s, { x: 96, y: 96, dir: RIGHT });
    const before = hashState(s);
    expect(probeMove(s, e, RIGHT, 5)).toBe(5);
    expect(probeMove(s, e, UP, 5)).toBe(5);
    expect(hashState(s)).toBe(before);
    expect(e.x).toBe(96);
    expect(e.y).toBe(96);
  });

  it('returns 0 flush against a wall and the partial gap short of one', () => {
    const rows = emptyRows();
    rows[5] = '.....S.......'; // tile (5,5) → x 80..96, y 80..96
    const s = createGame(level(rows), { players: 1, seed: 2, stageNumber: 1 });
    const flush = addEnemy(s, { x: 96, y: 80, dir: LEFT });
    expect(probeMove(s, flush, LEFT, 5)).toBe(0); // flush against the steel
    expect(probeMove(s, flush, RIGHT, 5)).toBe(5); // and free the other way

    const near2 = addEnemy(s, { x: 98, y: 80, dir: LEFT });
    expect(probeMove(s, near2, LEFT, 5)).toBe(2); // stops flush, never overlaps
    expect(probeMove(s, near2, LEFT, 1)).toBe(1); // shorter probe is untouched
  });

  it('agrees with what moveTank actually does', () => {
    const rows = emptyRows();
    rows[5] = '.....S.......';
    const s = createGame(level(rows), { players: 1, seed: 2, stageNumber: 1 });
    const e = addEnemy(s, { x: 98, y: 80, dir: LEFT });
    const allowed = probeMove(s, e, LEFT, 5);
    moveTank(s, e, LEFT, 5 / ENEMY_SPEED.basic); // dt chosen so speed*dt === 5
    expect(98 - e.x).toBe(allowed);
  });
});
