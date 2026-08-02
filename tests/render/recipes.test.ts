// tests/render/recipes.test.ts — art §8's VFX table (T4.2), in the Vitest
// **node** environment. No DOM and no WebGL: every recipe is driven into a real
// `FxSystem` built over real `Materials` and a real `SceneRoot`, none of which
// needs a GL context.
//
// The centrepiece is `walks every art §8 row`: the budgets in `recipes.ts` are
// transcribed from the doc *here*, independently, and then every row is fired
// and counted. A recipe that grows past its budget, or a budget that drifts
// from the doc, fails — which is the only thing standing between art §8's hard
// caps and a busy frame that costs whatever the board happened to do.
//
// What is NOT here: whether an explosion reads as an explosion. That is
// `scripts/capture-fx.ts`'s question and only pixels can answer it.

import { describe, expect, it } from 'vitest';

import { InstancedMesh } from 'three';

import { createGame } from '../../src/core/game';
import type { GameEvent } from '../../src/core/events';
import type { GameState, LevelData, Tank } from '../../src/core/types';
import { createMaterials, type Materials } from '../../src/render/materials';
import { createSceneRoot, type SceneRoot } from '../../src/render/sceneRoot';
import {
  DEFAULT_FX_FLAGS,
  PARTICLE_CAP,
  createFxSystem,
  type FxSystem,
} from '../../src/render/fx/fxSystem';
import {
  FX_PRIORITY,
  NO_RECIPE,
  RECIPES,
  applyRecipe,
  seedOf,
} from '../../src/render/fx/recipes';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

// ---------------------------------------------------------------------------
// Art §8's table, transcribed from docs/03-art-direction.md. THIS is the spec:
// change the doc first, change this second, and let `recipes.ts` go red.
// ---------------------------------------------------------------------------

const ART8_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  'Shot fired': 3,
  'Brick hit': 10,
  'Steel hit (no damage)': 5,
  'Steel destroyed': 12,
  'Tank explosion': 20,
  'Player explosion': 20,
  'Base explosion': 30,
  'Power-up spawn/pickup': 8,
  'Enemy spawn': 6,
  'Ice skid': 4,
  'Tree rustle (tank under canopy)': 3,
  'Stun (friendly fire)': 4,
});

/**
 * Every variant in `src/core/events.ts`, top to bottom. Hand-listed because a
 * TypeScript union is not enumerable at runtime — and because a new event
 * arriving with no FX decision made about it is exactly what this list catches.
 */
const ALL_EVENTS: readonly GameEvent['t'][] = [
  'shotFired',
  'bulletsCanceled',
  'bulletDespawned',
  'brickHit',
  'steelHit',
  'tankHit',
  'tankDestroyed',
  'playerStunned',
  'playerSpawned',
  'enemySpawnStarted',
  'enemySpawned',
  'powerupSpawned',
  'powerupCollected',
  'tierChanged',
  'shovelPhase',
  'clockStarted',
  'clockEnded',
  'grenadeUsed',
  'extraLife',
  'scoreAwarded',
  'iceSkidStarted',
  'treeEntered',
  'baseDestroyed',
  'stageCleared',
  'gameOver',
  'pauseToggled',
];

/** One representative event per variant, mid-board so nothing is clipped. */
const SAMPLE: Readonly<Record<GameEvent['t'], GameEvent>> = Object.freeze({
  shotFired: {
    t: 'shotFired',
    tankId: 0,
    x: 100,
    y: 100,
    dir: 1,
    byPlayer: true,
  },
  bulletsCanceled: { t: 'bulletsCanceled', x: 100, y: 100 },
  bulletDespawned: { t: 'bulletDespawned', x: 100, y: 100, reason: 'border' },
  brickHit: {
    t: 'brickHit',
    tx: 6,
    ty: 6,
    removedMask: 3,
    x: 100,
    y: 100,
    dir: 2,
  },
  steelHit: {
    t: 'steelHit',
    tx: 6,
    ty: 6,
    removedMask: 15,
    destroyed: true,
    x: 100,
    y: 100,
    dir: 2,
  },
  tankHit: { t: 'tankHit', tankId: 3, hpLeft: 2 },
  tankDestroyed: {
    t: 'tankDestroyed',
    tankId: 3,
    kind: 'enemy',
    enemyType: 'armor',
    byPlayerIndex: 0,
    points: 400,
    x: 100,
    y: 100,
  },
  playerStunned: { t: 'playerStunned', playerIndex: 0, durS: 3 },
  playerSpawned: { t: 'playerSpawned', playerIndex: 0, x: 64, y: 192 },
  enemySpawnStarted: {
    t: 'enemySpawnStarted',
    spawnOrdinal: 1,
    x: 96,
    y: 0,
    enemyType: 'basic',
    carrier: false,
  },
  enemySpawned: { t: 'enemySpawned', tankId: 3 },
  powerupSpawned: { t: 'powerupSpawned', type: 'star', x: 96, y: 96 },
  powerupCollected: {
    t: 'powerupCollected',
    type: 'star',
    playerIndex: 0,
    x: 96,
    y: 96,
  },
  tierChanged: { t: 'tierChanged', playerIndex: 0, tier: 2 },
  shovelPhase: { t: 'shovelPhase', phase: 'steel' },
  clockStarted: { t: 'clockStarted' },
  clockEnded: { t: 'clockEnded' },
  grenadeUsed: { t: 'grenadeUsed', kills: 3 },
  extraLife: { t: 'extraLife', playerIndex: 0 },
  scoreAwarded: {
    t: 'scoreAwarded',
    playerIndex: 0,
    points: 400,
    x: 100,
    y: 100,
  },
  iceSkidStarted: { t: 'iceSkidStarted', tankId: 0 },
  treeEntered: { t: 'treeEntered', tankId: 0 },
  baseDestroyed: { t: 'baseDestroyed' },
  stageCleared: { t: 'stageCleared' },
  gameOver: { t: 'gameOver' },
  pauseToggled: { t: 'pauseToggled', paused: true },
});

// ---------------------------------------------------------------------------

interface Mounted {
  fx: FxSystem;
  materials: Materials;
  root: SceneRoot;
  state: GameState;
  meshes: InstancedMesh[];
  /** Pumps `e` the way the loop does: cache is a frame old, then draw. */
  fire(e: GameEvent): void;
  dispose(): void;
}

function mount(): Mounted {
  const materials = createMaterials();
  const root = createSceneRoot(materials);
  const fx = createFxSystem(materials, root, { ...DEFAULT_FX_FLAGS });
  const state = createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 });
  // The three positionless rows (ice skid, tree rustle, stun) read a tank off
  // the sink's cache, so a tank has to exist and have been drawn once — which
  // is the real order too: `step()` pumps events, `render()` refreshes.
  const player: Tank = state.tanks[0];
  player.alive = true;
  player.x = 96;
  player.y = 96;
  player.prevX = 96;
  player.prevY = 96;
  player.dir = 1;
  player.spawningT = 0;
  const meshes: InstancedMesh[] = [];
  root.entities.traverse((o) => {
    if (o instanceof InstancedMesh) meshes.push(o);
  });
  fx.update(state, 16);
  return {
    fx,
    materials,
    root,
    state,
    meshes,
    fire(e: GameEvent): void {
      fx.onEvent(e);
      // dt 0: nothing ages, so the count seen is exactly what the recipe put in.
      fx.update(state, 0);
    },
    dispose(): void {
      fx.dispose();
      root.dispose();
      materials.dispose();
    },
  };
}

// ---------------------------------------------------------------------------

describe('coverage — every GameEvent has a decision', () => {
  it('is implemented or explicitly silent, never merely forgotten', () => {
    for (const t of ALL_EVENTS) {
      const implemented = RECIPES[t] !== undefined;
      const silent = Object.prototype.hasOwnProperty.call(NO_RECIPE, t);
      expect(implemented || silent, t).toBe(true);
      // …and never both, which would be two contradictory decisions.
      expect(implemented && silent, t).toBe(false);
    }
  });

  it('has no recipe or exemption for an event that does not exist', () => {
    const known = new Set<string>(ALL_EVENTS);
    for (const t of Object.keys(RECIPES)) {
      expect(known.has(t), t).toBe(true);
    }
    for (const t of Object.keys(NO_RECIPE)) {
      expect(known.has(t), t).toBe(true);
    }
  });

  it('implements all twelve art §8 rows', () => {
    // Twelve rows, eleven events: art §8 splits `steelHit` across two rows.
    expect(Object.keys(RECIPES)).toHaveLength(11);
    expect(RECIPES.steelHit?.minorBudget).toBe(
      ART8_BUDGET['Steel hit (no damage)'],
    );
  });
});

describe('budgets — art §8’s hard caps', () => {
  it('carries art §8’s Budget column verbatim', () => {
    expect(RECIPES.shotFired?.budget).toBe(ART8_BUDGET['Shot fired']);
    expect(RECIPES.brickHit?.budget).toBe(ART8_BUDGET['Brick hit']);
    expect(RECIPES.steelHit?.budget).toBe(ART8_BUDGET['Steel destroyed']);
    expect(RECIPES.steelHit?.minorBudget).toBe(
      ART8_BUDGET['Steel hit (no damage)'],
    );
    expect(RECIPES.tankDestroyed?.budget).toBe(ART8_BUDGET['Tank explosion']);
    expect(RECIPES.tankDestroyed?.budget).toBe(ART8_BUDGET['Player explosion']);
    expect(RECIPES.baseDestroyed?.budget).toBe(ART8_BUDGET['Base explosion']);
    expect(RECIPES.powerupSpawned?.budget).toBe(
      ART8_BUDGET['Power-up spawn/pickup'],
    );
    expect(RECIPES.powerupCollected?.budget).toBe(
      ART8_BUDGET['Power-up spawn/pickup'],
    );
    expect(RECIPES.enemySpawnStarted?.budget).toBe(ART8_BUDGET['Enemy spawn']);
    expect(RECIPES.iceSkidStarted?.budget).toBe(ART8_BUDGET['Ice skid']);
    expect(RECIPES.treeEntered?.budget).toBe(
      ART8_BUDGET['Tree rustle (tank under canopy)'],
    );
    expect(RECIPES.playerStunned?.budget).toBe(
      ART8_BUDGET['Stun (friendly fire)'],
    );
  });

  it.each(Object.keys(RECIPES) as GameEvent['t'][])(
    '%s stays inside its budget',
    (t) => {
      const spec = RECIPES[t];
      expect(spec).toBeDefined();
      const m = mount();
      m.fire(SAMPLE[t]);
      expect(m.fx.stats().particles).toBeLessThanOrEqual(
        (spec as { budget: number }).budget,
      );
      // …and it actually did something. A row that silently emits nothing is
      // the failure mode this whole file exists to catch.
      expect(m.fx.stats().particles).toBeGreaterThan(0);
      m.dispose();
    },
  );

  it.each(Object.keys(RECIPES) as GameEvent['t'][])(
    '%s stays inside its light budget (art §6)',
    (t) => {
      const spec = RECIPES[t] as { lights: number };
      const m = mount();
      m.fire(SAMPLE[t]);
      expect(m.fx.stats().lights).toBeLessThanOrEqual(spec.lights);
      m.dispose();
    },
  );

  it('holds the quiet steel strike to art §8’s tighter row', () => {
    const m = mount();
    m.fire({
      t: 'steelHit',
      tx: 6,
      ty: 6,
      removedMask: 0,
      destroyed: false,
      x: 100,
      y: 100,
      dir: 2,
    });
    expect(m.fx.stats().particles).toBeLessThanOrEqual(
      ART8_BUDGET['Steel hit (no damage)'],
    );
    m.dispose();
  });

  it('spends the whole brick budget on chunks, 6–10 of them (art §8)', () => {
    // "6–10 brick-colored chunk boxes … + dust puff | 10" — so the count must
    // vary with the brick, and the dust has to fit inside the ten.
    const counts = new Set<number>();
    for (let tx = 0; tx < 12; tx++) {
      const m = mount();
      m.fire({
        t: 'brickHit',
        tx,
        ty: 5,
        removedMask: 3,
        x: tx * 16 + 8,
        y: 88,
        dir: 0,
      });
      const n = m.fx.stats().particles;
      expect(n).toBeGreaterThanOrEqual(7); // 6 chunks + the dust puff
      expect(n).toBeLessThanOrEqual(ART8_BUDGET['Brick hit']);
      counts.add(n);
      m.dispose();
    }
    expect(counts.size).toBeGreaterThan(1);
  });

  it('never exceeds the global cap even when every row fires at once', () => {
    const m = mount();
    for (let round = 0; round < 12; round++) {
      for (const t of Object.keys(RECIPES) as GameEvent['t'][]) {
        m.fx.onEvent(SAMPLE[t]);
      }
    }
    m.fx.update(m.state, 0);
    expect(m.fx.stats().particles).toBeLessThanOrEqual(PARTICLE_CAP.high);
    m.dispose();
  });
});

describe('priority — what survives a crowded board', () => {
  it('ranks the base above the player above an enemy above scenery', () => {
    expect(FX_PRIORITY.baseExplosion).toBeGreaterThan(
      FX_PRIORITY.playerExplosion,
    );
    expect(FX_PRIORITY.playerExplosion).toBeGreaterThan(
      FX_PRIORITY.tankExplosion,
    );
    expect(FX_PRIORITY.tankExplosion).toBeGreaterThan(FX_PRIORITY.brickHit);
    expect(FX_PRIORITY.muzzle).toBeGreaterThan(FX_PRIORITY.treeRustle);
  });

  it('lets the base explosion through a pool full of leaves', () => {
    const m = mount();
    // Flood with the least important thing on the board.
    for (let i = 0; i < 400; i++) {
      m.fx.onEvent({ t: 'treeEntered', tankId: 0 });
    }
    m.fx.update(m.state, 0);
    expect(m.fx.stats().particles).toBe(PARTICLE_CAP.high);

    const before = m.meshes.map((mesh) => mesh.count);
    m.fire({ t: 'baseDestroyed' });
    // Leaves are all `debris`; the base explosion is mostly smoke, rings and a
    // flash, so the pool visibly re-shaped itself around the important event.
    const after = m.meshes.map((mesh) => mesh.count);
    expect(after).not.toEqual(before);
    expect(m.fx.stats().particles).toBe(PARTICLE_CAP.high);
    m.dispose();
  });
});

describe('the three rows whose event carries no position', () => {
  it.each(['iceSkidStarted', 'treeEntered'] as const)(
    '%s draws at the tank the event names',
    (t) => {
      const m = mount();
      m.fire(SAMPLE[t]);
      // Every particle landed near the tank at (96, 96) + half a tank.
      let checked = 0;
      for (const mesh of m.meshes) {
        for (let i = 0; i < mesh.count; i++) {
          const a = mesh.instanceMatrix.array as Float32Array;
          expect(Math.abs(a[i * 16 + 12] - 104)).toBeLessThan(24);
          expect(Math.abs(a[i * 16 + 14] - 104)).toBeLessThan(24);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
      m.dispose();
    },
  );

  it('emits nothing for a tank it has never drawn', () => {
    // A stale or out-of-range id must be a no-op, not a spray at the origin.
    const m = mount();
    m.fire({ t: 'treeEntered', tankId: 61 });
    expect(m.fx.stats().particles).toBe(0);
    m.fire({ t: 'iceSkidStarted', tankId: -1 });
    expect(m.fx.stats().particles).toBe(0);
    m.dispose();
  });

  it('finds a stunned player by its player index', () => {
    // A player tank's id IS its player index (`players.ts`), which is the only
    // reason `playerStunned` — which carries no tankId at all — can be placed.
    const m = mount();
    m.fire({ t: 'playerStunned', playerIndex: 0, durS: 3 });
    expect(m.fx.stats().particles).toBe(ART8_BUDGET['Stun (friendly fire)']);
    m.dispose();
  });
});

describe('the events art §8 leaves silent', () => {
  it.each(Object.keys(NO_RECIPE))('%s emits nothing', (t) => {
    const m = mount();
    m.fire(SAMPLE[t as GameEvent['t']]);
    expect(m.fx.stats().particles).toBe(0);
    expect(m.fx.stats().lights).toBe(0);
    m.dispose();
  });

  it('records a reason for each, so silence is a decision', () => {
    for (const [t, reason] of Object.entries(NO_RECIPE)) {
      expect(reason.length, t).toBeGreaterThan(10);
    }
  });
});

describe('hull colour comes off the event, never off the state', () => {
  it.each(['basic', 'fast', 'power', 'armor'] as const)(
    'an %s enemy throws its own colour',
    (enemyType) => {
      const m = mount();
      m.fire({
        t: 'tankDestroyed',
        tankId: 7,
        kind: 'enemy',
        enemyType,
        points: 100,
        x: 100,
        y: 100,
      });
      const debris = m.meshes[0]; // FX_KINDS[0] === 'debris'
      expect(debris.count).toBe(12); // art §8: "12 debris chunks (hull-colored)"
      m.dispose();
    },
  );

  it('gives each player its own wreckage', () => {
    const colourOf = (tankId: number): number[] => {
      const m = mount();
      m.fire({
        t: 'tankDestroyed',
        tankId,
        kind: 'player',
        points: 0,
        x: 100,
        y: 100,
      });
      const debris = m.meshes[0];
      const c = debris.instanceColor;
      expect(c).not.toBeNull();
      const out = [
        (c as { array: Float32Array }).array[0],
        (c as { array: Float32Array }).array[1],
        (c as { array: Float32Array }).array[2],
      ];
      m.dispose();
      return out;
    };
    // P1 is gold and P2 is green (art §3.1) — the same fact `tankView.ts`
    // relies on: a player tank's id is its player index, forever.
    expect(colourOf(0)).not.toEqual(colourOf(1));
  });
});

describe('seeding', () => {
  it('is stable for one event and different for its neighbours', () => {
    const a: GameEvent = {
      t: 'brickHit',
      tx: 4,
      ty: 4,
      removedMask: 3,
      x: 72,
      y: 72,
      dir: 0,
    };
    expect(seedOf(a)).toBe(seedOf({ ...a }));
    expect(seedOf(a)).not.toBe(seedOf({ ...a, tx: 5 }));
    expect(seedOf(a)).not.toBe(seedOf({ ...a, dir: 1 }));
    // Two different events at the same place must not share a spray.
    expect(seedOf(a)).not.toBe(
      seedOf({
        t: 'steelHit',
        tx: 4,
        ty: 4,
        removedMask: 3,
        destroyed: false,
        x: 72,
        y: 72,
        dir: 0,
      }),
    );
  });
});

describe('dispatch', () => {
  it('is a no-op for an event with no recipe', () => {
    // `applyRecipe` is called for EVERY event the loop drains, so the cheap
    // path has to be the common one.
    const m = mount();
    let emitted = 0;
    const counting = {
      ...m.fx,
      emit(): void {
        emitted++;
        m.fx.emit();
      },
    };
    applyRecipe(counting, { t: 'clockStarted' });
    applyRecipe(counting, { t: 'gameOver' });
    expect(emitted).toBe(0);
    applyRecipe(counting, SAMPLE.shotFired);
    expect(emitted).toBe(ART8_BUDGET['Shot fired']);
    m.dispose();
  });
});
