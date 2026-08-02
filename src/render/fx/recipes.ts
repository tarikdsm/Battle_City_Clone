// src/render/fx/recipes.ts — art §8's VFX event table, as a table.
//
// One entry per `GameEvent` that art §8 gives a row to, carrying §8's own
// Budget column next to the code that has to respect it. That pairing is the
// point: `tests/render/recipes.test.ts` walks this object, fires a synthetic
// event of every variant into a real `FxSystem`, and asserts the live particle
// count never exceeds the number written beside it. A recipe that grows past
// its budget fails a test rather than quietly eating the global cap.
//
// ## Two rules this file lives by
//
// **Events carry the effect; state never does.** Every position, direction and
// payload below is read off the `GameEvent` (arch §3.3). The three exceptions
// are art §8's own: the ice-skid, tree-rustle and stun rows are driven by
// events that carry a `tankId` and *no position* (`core/events.ts`), so the
// sink offers a tank-position lookup. That is a lookup of where to draw
// something that has already happened, not a re-derivation of whether it did.
//
// **Nothing here allocates.** `sink.begin()` returns a shared spawn record that
// `sink.emit()` copies into the pool, so a recipe reads like a description of a
// particle and still costs nothing per frame. The colour tables below are
// resolved once, at module load.
//
// ## Colour
//
// Every colour is an art §3.1 token, converted to the renderer's **linear**
// working space once (`new Color(hex)` does the sRGB→linear step). Recipes
// multiply by a scalar to brighten — a white-hot spark is `steelRivet × 2.4`,
// not an unauthored `#ffffff` — which keeps the palette the single source of
// what this game is coloured with, exactly as `faceTint` does for tank trim.
// The one token added for this task is `smoke`; see materials.ts.

import { Color } from 'three';

import type { GameEvent } from '../../core/events';
import { PALETTE } from '../materials';
import type { FxSink, FxSpawn } from './fxSystem';

// ---------------------------------------------------------------------------
// --- Priorities ------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Which effect survives when the pool is full. Art §8 does not rank its rows,
 * so this is the ranking, and it is written as one table so the order is
 * arguable in one place rather than scattered across twelve call sites.
 *
 * The scale is **how much the player needs to see it**: the base falling is the
 * loudest thing that can happen in this game, a tree rustling is decoration,
 * and everything in between is sorted by whether ignoring it costs a life.
 */
export const FX_PRIORITY = Object.freeze({
  baseExplosion: 100,
  playerExplosion: 90,
  tankExplosion: 80,
  steelDestroyed: 60,
  brickHit: 50,
  steelHit: 45,
  powerup: 40,
  enemySpawn: 38,
  stun: 35,
  muzzle: 30,
  iceSkid: 20,
  treeRustle: 10,
});

// ---------------------------------------------------------------------------
// --- Colour ----------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Linear RGB of an art §3.1 token, resolved once. */
function rgb(hex: number): readonly number[] {
  const c = new Color(hex);
  return Object.freeze([c.r, c.g, c.b]);
}

const C = Object.freeze({
  brick: rgb(PALETTE.brickTop),
  brickDeep: rgb(PALETTE.brickSide),
  mortar: rgb(PALETTE.brickMortar),
  steel: rgb(PALETTE.steelTop),
  /** The steel's own highlight token — what "white-hot" is made of here. */
  rivet: rgb(PALETTE.steelRivet),
  gold: rgb(PALETTE.powerupGold),
  spawn: rgb(PALETTE.spawnAccent),
  leaf: rgb(PALETTE.treesCanopy),
  leafDeep: rgb(PALETTE.treesDepth),
  ice: rgb(PALETTE.ice),
  frost: rgb(PALETTE.iceSheen),
  smoke: rgb(PALETTE.smoke),
  stone: rgb(PALETTE.eagleStone),
  player1: rgb(PALETTE.player1),
  player2: rgb(PALETTE.player2),
  enemyBasic: rgb(PALETTE.enemyBasic),
  enemyFast: rgb(PALETTE.enemyFast),
  enemyPower: rgb(PALETTE.enemyPower),
  enemyArmor: rgb(PALETTE.enemyArmor),
  /** Art §3.1's "yellow" for the stun ring — P1's own accent. */
  accent: rgb(PALETTE.player1Accent),
});

/** Writes a token into the spawn record, brightened by `k`. */
function tint(p: FxSpawn, c: readonly number[], k = 1): void {
  p.r = c[0] * k;
  p.g = c[1] * k;
  p.b = c[2] * k;
}

// ---------------------------------------------------------------------------
// --- Geometry helpers ------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * `Dir` 0…3 (Up/Right/Down/Left) as a **world** direction. The core's +y is
 * south, and `sceneRoot.ts` maps core y onto world z with no sign flip, so Up
 * is −z. Same convention as `DIR_YAW` in models.ts, derived independently here
 * because this file may not import a tank's yaw table to move a spark.
 */
const DIR_DX: readonly number[] = Object.freeze([0, 1, 0, -1]);
const DIR_DZ: readonly number[] = Object.freeze([-1, 0, 1, 0]);

/** Half a tank / half a spawn box / half a power-up slot: every event's centre. */
const HALF_TILE = 8;
/** Half a bullet — every bullet-carried position is the 4×4's top-left corner. */
const HALF_BULLET = 2;

/**
 * Aims the spawn record's horizontal velocity into a cone about `(dx, dz)`.
 *
 * `spread` is the half-angle in radians; `1` is a 57° fan either side, `Math.PI`
 * is fully omnidirectional. The vertical component is the caller's — a ricochet
 * and a fountain differ in `vy`, not in their fan.
 */
function fan(
  p: FxSpawn,
  sink: FxSink,
  i: number,
  dx: number,
  dz: number,
  spread: number,
  speed: number,
): void {
  const base = Math.atan2(dz, dx);
  const a = base + (sink.rand(i * 4) - 0.5) * 2 * spread;
  p.vx = Math.cos(a) * speed;
  p.vz = Math.sin(a) * speed;
}

/** A value in `[lo, hi)` from the sink's deterministic stream. */
function between(sink: FxSink, i: number, lo: number, hi: number): number {
  return lo + sink.rand(i) * (hi - lo);
}

// ---------------------------------------------------------------------------
// --- The table -------------------------------------------------------------
// ---------------------------------------------------------------------------

type EventOf<K extends GameEvent['t']> = Extract<GameEvent, { t: K }>;

export interface RecipeSpec {
  /** Art §8's row, verbatim, so the table can be read against the doc. */
  readonly row: string;
  /** Art §8's Budget column — a **hard cap** on particles per occurrence. */
  readonly budget: number;
  /** Art §6 dynamic lights this recipe may request. */
  readonly lights: number;
  /**
   * Art §8 sometimes splits one event across two rows with different budgets
   * (steel hit vs steel destroyed). This is the *tighter* row's cap, and
   * `tests/render/recipes.test.ts` holds the quiet branch to it.
   */
  readonly minorBudget?: number;
}

export type RecipeTable = {
  readonly [K in GameEvent['t']]?: RecipeSpec & {
    readonly emit: (sink: FxSink, e: EventOf<K>) => void;
  };
};

/**
 * Art §8's table. Every row is here; {@link NO_RECIPE} lists the events §8
 * gives no row to, with the reason, so "did we forget one" is answerable.
 */
export const RECIPES: RecipeTable = {
  // -------------------------------------------------------------------------
  // "Shot fired | muzzle star sprite 60 ms + point light + barrel recoil +
  //  3 spark motes | 3 particles"
  //
  // The barrel recoil is `tankView.ts`'s (art §9, shipped at T2.4). The row
  // describes a sprite *plus* three motes but budgets three particles, and the
  // budget is the hard cap — so the star is one of the three and two motes
  // follow it. Reported for a doc amendment; see the T4.1/T4.2 report.
  // -------------------------------------------------------------------------
  shotFired: {
    row: 'Shot fired',
    budget: 3,
    lights: 1,
    emit(sink, e): void {
      // The event carries the *bullet's* top-left corner, i.e. the midpoint of
      // the tank's leading edge — which is exactly the muzzle.
      const x = e.x + HALF_BULLET;
      const z = e.y + HALF_BULLET;
      const dx = DIR_DX[e.dir];
      const dz = DIR_DZ[e.dir];

      const star = sink.begin('flash', FX_PRIORITY.muzzle);
      star.x = x + dx * 2;
      star.y = MUZZLE_Y;
      star.z = z + dz * 2;
      star.lifeMs = 60;
      star.size0 = 9;
      star.size1 = 3.5;
      tint(star, C.gold, 1.5);
      sink.emit();

      for (let i = 0; i < 2; i++) {
        const p = sink.begin('spark', FX_PRIORITY.muzzle);
        p.x = x + dx * 4;
        p.y = MUZZLE_Y;
        p.z = z + dz * 4;
        fan(p, sink, i, dx, dz, 0.5, between(sink, i * 4 + 1, 70, 130));
        p.vy = between(sink, i * 4 + 2, 5, 30);
        p.gravity = 220;
        p.lifeMs = 190;
        p.size0 = 1.3;
        p.size1 = 0.8;
        p.stretch = 0.014;
        tint(p, C.gold, 1.9);
        sink.emit();
      }

      sink.light('muzzle', x, MUZZLE_Y, z, C.gold[0], C.gold[1], C.gold[2]);
    },
  },

  // -------------------------------------------------------------------------
  // "Brick hit | 6–10 brick-colored chunk boxes, gravity 600 u/s², 1 bounce,
  //  0.7 s life + dust puff | 10"
  // -------------------------------------------------------------------------
  brickHit: {
    row: 'Brick hit',
    budget: 10,
    lights: 0,
    emit(sink, e): void {
      const x = e.x + HALF_BULLET;
      const z = e.y + HALF_BULLET;
      // Back along the bullet's travel: the wall throws its rubble at you.
      const dx = -DIR_DX[e.dir];
      const dz = -DIR_DZ[e.dir];
      // Art §8's "6–10", minus the dust puff that shares the budget.
      const n = 6 + Math.floor(sink.rand(0) * 4);
      for (let i = 0; i < n; i++) {
        const p = sink.begin('debris', FX_PRIORITY.brickHit);
        p.x = x + (sink.rand(i * 5 + 1) - 0.5) * 6;
        p.y = between(sink, i * 5 + 2, 3, 9);
        p.z = z + (sink.rand(i * 5 + 3) - 0.5) * 6;
        fan(p, sink, i + 1, dx, dz, 1.0, between(sink, i * 5 + 4, 30, 85));
        p.vy = between(sink, i * 5 + 5, 55, 135);
        p.gravity = BRICK_GRAVITY;
        p.bounce = true;
        p.lifeMs = 700;
        p.size0 = between(sink, i * 5 + 6, 1.8, 3.2);
        p.size1 = p.size0;
        p.spin = between(sink, i * 5 + 7, -14, 14);
        p.roll = sink.rand(i * 5 + 8) * Math.PI;
        // Half the rubble is the shaded interior of the wall, which is what
        // makes a broken wall read as broken rather than as a spray of tiles.
        tint(p, i % 2 === 0 ? C.brick : C.brickDeep, 1);
        sink.emit();
      }

      const dust = sink.begin('smoke', FX_PRIORITY.brickHit);
      dust.x = x;
      dust.y = 6;
      dust.z = z;
      dust.vy = 12;
      dust.lifeMs = 430;
      dust.size0 = 5;
      dust.size1 = 12;
      tint(dust, C.mortar, 1.2);
      sink.emit();
    },
  },

  // -------------------------------------------------------------------------
  // "Steel hit (no damage) | 5 white-hot sparks, ricochet cone opposite bullet
  //  + *clink* light 40 ms | 5"
  // "Steel destroyed | 8 metal shards + sparks | 12"
  //
  // One event, two rows: `destroyed` is the tier-3 branch (`bullets.ts`).
  // -------------------------------------------------------------------------
  steelHit: {
    row: 'Steel hit (no damage) / Steel destroyed',
    budget: 12,
    minorBudget: 5,
    lights: 1,
    emit(sink, e): void {
      const x = e.x + HALF_BULLET;
      const z = e.y + HALF_BULLET;
      const dx = -DIR_DX[e.dir];
      const dz = -DIR_DZ[e.dir];
      const priority = e.destroyed
        ? FX_PRIORITY.steelDestroyed
        : FX_PRIORITY.steelHit;

      if (e.destroyed) {
        for (let i = 0; i < 8; i++) {
          const p = sink.begin('debris', priority);
          p.x = x + (sink.rand(i * 5 + 1) - 0.5) * 7;
          p.y = between(sink, i * 5 + 2, 3, 10);
          p.z = z + (sink.rand(i * 5 + 3) - 0.5) * 7;
          fan(p, sink, i + 1, dx, dz, 1.3, between(sink, i * 5 + 4, 35, 95));
          p.vy = between(sink, i * 5 + 5, 70, 160);
          p.gravity = BRICK_GRAVITY;
          p.bounce = true;
          p.lifeMs = 820;
          // Shards, not cubes: a plate that has been blown apart reads as flat
          // pieces, and the flat piece is what the tumble shows off.
          p.size0 = between(sink, i * 5 + 6, 2.2, 3.6);
          p.size1 = p.size0;
          p.spin = between(sink, i * 5 + 7, -16, 16);
          p.roll = sink.rand(i * 5 + 8) * Math.PI;
          tint(p, C.steel, 1);
          sink.emit();
        }
      }

      // Art §8's "5 white-hot sparks" on the intact row; the destroyed row's
      // "+ sparks" is what the remaining 4 of its 12 are.
      const sparks = e.destroyed ? 4 : 5;
      for (let i = 0; i < sparks; i++) {
        const p = sink.begin('spark', priority);
        p.x = x;
        p.y = between(sink, i * 3 + 40, 4, 9);
        p.z = z;
        fan(p, sink, i + 20, dx, dz, 0.75, between(sink, i * 3 + 41, 95, 175));
        p.vy = between(sink, i * 3 + 42, 20, 80);
        p.gravity = 340;
        p.lifeMs = 270;
        p.size0 = 1.4;
        p.size1 = 0.7;
        p.stretch = 0.02;
        tint(p, C.rivet, 2.4);
        sink.emit();
      }

      sink.light('clink', x, 6, z, C.rivet[0], C.rivet[1], C.rivet[2]);
    },
  },

  // -------------------------------------------------------------------------
  // "Tank explosion | flash sphere scale 1→2.2 over 120 ms, 12 debris chunks
  //  (hull-colored), 4 smoke puffs 1.2 s, expanding ground ring, point light | 20"
  // "Player explosion | tank explosion + 200 ms white screen-edge flash
  //  (respect flash-reduction) | 20"
  // -------------------------------------------------------------------------
  tankDestroyed: {
    row: 'Tank explosion / Player explosion',
    budget: 20,
    lights: 1,
    emit(sink, e): void {
      const x = e.x + HALF_BULLET;
      const z = e.y + HALF_BULLET;
      const player = e.kind === 'player';
      const priority = player
        ? FX_PRIORITY.playerExplosion
        : FX_PRIORITY.tankExplosion;
      const hull = hullColourOf(e);

      // "flash sphere scale 1→2.2 over 120 ms" — the ratio is §8's; the base
      // size is a tank's own 16 u, so the sphere ends at 35 u, a little over
      // two tiles. That is the whole readability budget of this effect: it is
      // gone in 120 ms, well inside §11's 100 ms rule for a *sustained* cover.
      const flash = sink.begin('flash', priority);
      flash.x = x;
      flash.y = 7;
      flash.z = z;
      flash.lifeMs = 120;
      flash.size0 = 16;
      flash.size1 = 16 * 2.2;
      tint(flash, C.gold, 1.7);
      sink.emit();

      for (let i = 0; i < 12; i++) {
        const p = sink.begin('debris', priority);
        p.x = x + (sink.rand(i * 6 + 1) - 0.5) * 9;
        p.y = between(sink, i * 6 + 2, 3, 11);
        p.z = z + (sink.rand(i * 6 + 3) - 0.5) * 9;
        fan(p, sink, i + 1, 1, 0, Math.PI, between(sink, i * 6 + 4, 35, 120));
        p.vy = between(sink, i * 6 + 5, 70, 175);
        p.gravity = BRICK_GRAVITY;
        p.bounce = true;
        p.lifeMs = 900;
        p.size0 = between(sink, i * 6 + 6, 1.9, 3.4);
        p.size1 = p.size0;
        p.spin = between(sink, i * 6 + 7, -18, 18);
        p.roll = sink.rand(i * 6 + 8) * Math.PI;
        tint(p, hull, 1);
        sink.emit();
      }

      for (let i = 0; i < 4; i++) {
        const p = sink.begin('smoke', priority);
        p.x = x + (sink.rand(i * 4 + 60) - 0.5) * 12;
        p.y = between(sink, i * 4 + 61, 4, 10);
        p.z = z + (sink.rand(i * 4 + 62) - 0.5) * 12;
        p.vy = between(sink, i * 4 + 63, 10, 24);
        p.lifeMs = 1200;
        p.size0 = 7;
        p.size1 = 19;
        tint(p, C.smoke, 1);
        sink.emit();
      }

      const ring = sink.begin('ring', priority);
      ring.x = x;
      ring.y = RING_Y;
      ring.z = z;
      ring.flat = true;
      ring.lifeMs = 420;
      ring.size0 = 8;
      ring.size1 = 62;
      tint(ring, C.gold, 1.6);
      sink.emit();

      sink.light('explosion', x, 8, z, C.gold[0], C.gold[1], C.gold[2]);

      if (player) {
        // The one row art §11 gates. The sink drops it under either
        // accessibility flag; every particle above still spawns.
        sink.screenFlash(200, 0.55);
      }
    },
  },

  // -------------------------------------------------------------------------
  // "Base explosion | slow-mo beat + double ring shockwave + 5 gold emblem
  //  shards + tall smoke column + long light | 30"
  //
  // The slow-mo beat is T4.3's (`cameraFx.ts`, art §2's base-destruction
  // moment); nothing here asks for it. The eagle's *continuing* smoke wisps
  // (art §4) are not a one-shot and live in `fxSystem.ts`, armed by this same
  // event — that is the seam `propView.ts` documented and left open.
  // -------------------------------------------------------------------------
  baseDestroyed: {
    row: 'Base explosion',
    budget: 30,
    lights: 1,
    emit(sink): void {
      const x = EAGLE_X;
      const z = EAGLE_Z;
      const priority = FX_PRIORITY.baseExplosion;

      // "double ring shockwave" — two rings with different speeds rather than
      // two spawned apart, because a pool has no timers: the slower one is
      // still expanding when the fast one has gone, which is what reads as two
      // waves. The second is deliberately wider than the base's brick nest.
      for (let i = 0; i < 2; i++) {
        const ring = sink.begin('ring', priority);
        ring.x = x;
        ring.y = RING_Y;
        ring.z = z;
        ring.flat = true;
        ring.lifeMs = i === 0 ? 620 : 1050;
        ring.size0 = 10;
        // 130 u, not the 168 the first cut used. The eagle sits half a tile
        // from the south edge (fidelity §2), so *any* shockwave wider than a
        // tile crosses the frame wall and keeps going — measured in
        // `.superpowers/sdd/screens-T4/3-base-explosion.png`, where a 168 u
        // ring drew a gold arc across the black letterbox outside the board.
        // This keeps most of the wave over the diorama it belongs to.
        ring.size1 = i === 0 ? 96 : 130;
        tint(ring, C.gold, i === 0 ? 2 : 1.3);
        sink.emit();
      }

      const flash = sink.begin('flash', priority);
      flash.x = x;
      flash.y = 8;
      flash.z = z;
      flash.lifeMs = 220;
      flash.size0 = 20;
      flash.size1 = 60;
      tint(flash, C.gold, 1.9);
      sink.emit();

      // "5 gold emblem shards" — the shield off the pedestal, thrown.
      for (let i = 0; i < 5; i++) {
        const p = sink.begin('debris', priority);
        p.x = x + (sink.rand(i * 6 + 1) - 0.5) * 8;
        p.y = between(sink, i * 6 + 2, 6, 13);
        p.z = z + (sink.rand(i * 6 + 3) - 0.5) * 8;
        fan(p, sink, i + 1, 1, 0, Math.PI, between(sink, i * 6 + 4, 45, 120));
        p.vy = between(sink, i * 6 + 5, 110, 210);
        p.gravity = BRICK_GRAVITY;
        p.bounce = true;
        p.lifeMs = 1400;
        p.size0 = between(sink, i * 6 + 6, 2.6, 4.2);
        p.size1 = p.size0;
        p.spin = between(sink, i * 6 + 7, -12, 12);
        p.roll = sink.rand(i * 6 + 8) * Math.PI;
        tint(p, C.gold, 1.15);
        sink.emit();
      }

      // "tall smoke column" — one draw of 12 puffs whose *rise* is staggered by
      // speed rather than by time, so the column is a column on the very first
      // frame instead of building over a second nobody is looking at.
      for (let i = 0; i < 12; i++) {
        const p = sink.begin('smoke', priority);
        const up = i / 11;
        p.x = x + (sink.rand(i * 4 + 60) - 0.5) * (7 + up * 12);
        p.y = 4 + up * 26;
        p.z = z + (sink.rand(i * 4 + 61) - 0.5) * (7 + up * 12);
        p.vy = between(sink, i * 4 + 62, 14, 34);
        p.vx = (sink.rand(i * 4 + 63) - 0.5) * 10;
        p.lifeMs = 1500 + up * 500;
        p.size0 = 8 + up * 4;
        p.size1 = 20 + up * 12;
        tint(p, C.smoke, 1 - up * 0.25);
        sink.emit();
      }

      for (let i = 0; i < 5; i++) {
        const p = sink.begin('spark', priority);
        p.x = x;
        p.y = 8;
        p.z = z;
        fan(p, sink, i + 30, 1, 0, Math.PI, between(sink, i * 3 + 90, 90, 190));
        p.vy = between(sink, i * 3 + 91, 60, 190);
        p.gravity = 300;
        p.lifeMs = 520;
        p.size0 = 2;
        p.size1 = 0.8;
        p.stretch = 0.016;
        tint(p, C.gold, 2.2);
        sink.emit();
      }

      sink.light('baseExplosion', x, 14, z, C.gold[0], C.gold[1], C.gold[2]);
    },
  },

  // -------------------------------------------------------------------------
  // "Power-up spawn/pickup | gold burst 8 motes / ring + rising sparkles | 8"
  //
  // The item's own **idle** point light (art §6, "range 24 u, 1.2 s sine") is
  // continuous, not event-shaped, so it lives in `fxSystem.ts` next to the bob
  // phase it shares — the second seam `propView.ts` left open.
  // -------------------------------------------------------------------------
  powerupSpawned: {
    row: 'Power-up spawn',
    budget: 8,
    lights: 0,
    emit(sink, e): void {
      const x = e.x + HALF_TILE;
      const z = e.y + HALF_TILE;
      const ring = sink.begin('ring', FX_PRIORITY.powerup);
      ring.x = x;
      ring.y = RING_Y;
      ring.z = z;
      ring.flat = true;
      ring.lifeMs = 520;
      ring.size0 = 5;
      ring.size1 = 38;
      tint(ring, C.gold, 1.5);
      sink.emit();

      for (let i = 0; i < 7; i++) {
        const p = sink.begin('spark', FX_PRIORITY.powerup);
        p.x = x + (sink.rand(i * 4 + 1) - 0.5) * 14;
        p.y = 1;
        p.z = z + (sink.rand(i * 4 + 2) - 0.5) * 14;
        p.vy = between(sink, i * 4 + 3, 26, 58);
        p.gravity = 55;
        p.lifeMs = 720;
        p.size0 = 1.5;
        p.size1 = 0.7;
        tint(p, C.gold, 1.8);
        sink.emit();
      }
    },
  },

  powerupCollected: {
    row: 'Power-up pickup',
    budget: 8,
    lights: 0,
    emit(sink, e): void {
      const x = e.x + HALF_TILE;
      const z = e.y + HALF_TILE;
      for (let i = 0; i < 8; i++) {
        const p = sink.begin('spark', FX_PRIORITY.powerup);
        p.x = x;
        p.y = 8;
        p.z = z;
        fan(p, sink, i, 1, 0, Math.PI, between(sink, i * 3 + 1, 40, 95));
        p.vy = between(sink, i * 3 + 2, 40, 110);
        p.gravity = 190;
        p.lifeMs = 520;
        p.size0 = 1.8;
        p.size1 = 0.6;
        p.stretch = 0.01;
        tint(p, C.gold, 2);
        sink.emit();
      }
    },
  },

  // -------------------------------------------------------------------------
  // "Enemy spawn | star twinkle + 2 rising rings | 6"
  //
  // The twinkling star itself is `tankView.ts`'s (art §4's billboard, shipped
  // at T2.4 and on the bloom layer since T2.5); this adds §8's rings and the
  // §6 light that makes the star throw something onto the board.
  // -------------------------------------------------------------------------
  enemySpawnStarted: {
    row: 'Enemy spawn',
    budget: 6,
    lights: 1,
    emit(sink, e): void {
      const x = e.x + HALF_TILE;
      const z = e.y + HALF_TILE;
      for (let i = 0; i < 2; i++) {
        const ring = sink.begin('ring', FX_PRIORITY.enemySpawn);
        ring.x = x;
        ring.y = RING_Y + i * 4;
        ring.z = z;
        ring.flat = true;
        ring.vy = 7; // "rising"
        ring.lifeMs = i === 0 ? 900 : 1300;
        ring.size0 = 7;
        ring.size1 = i === 0 ? 26 : 36;
        tint(ring, C.spawn, 1.6);
        sink.emit();
      }
      for (let i = 0; i < 4; i++) {
        const p = sink.begin('spark', FX_PRIORITY.enemySpawn);
        p.x = x + (sink.rand(i * 3 + 1) - 0.5) * 12;
        p.y = between(sink, i * 3 + 2, 1, 6);
        p.z = z + (sink.rand(i * 3 + 3) - 0.5) * 12;
        p.vy = between(sink, i * 3 + 4, 14, 34);
        p.lifeMs = 900;
        p.size0 = 1.3;
        p.size1 = 0.5;
        tint(p, C.spawn, 1.7);
        sink.emit();
      }
      sink.light('spawnStar', x, 8, z, C.spawn[0], C.spawn[1], C.spawn[2]);
    },
  },

  // -------------------------------------------------------------------------
  // "Ice skid | 2 skid-mark decals + frost motes | 4"
  //
  // `iceSkidStarted` carries a `tankId` and no position, so the tank's board
  // centre comes off the sink's per-frame lookup (see the file header).
  // -------------------------------------------------------------------------
  iceSkidStarted: {
    row: 'Ice skid',
    budget: 4,
    lights: 0,
    emit(sink, e): void {
      if (!sink.hasTank(e.tankId)) return;
      const x = sink.tankX(e.tankId);
      const z = sink.tankZ(e.tankId);
      const dir = sink.tankDir(e.tankId);
      const dx = DIR_DX[dir];
      const dz = DIR_DZ[dir];
      // Perpendicular to travel: the two track marks, one per track.
      const px = -dz;
      const pz = dx;
      // Local −z is forward for every oriented piece in this layer, so a mark
      // laid along the tank's heading is a yaw of `atan2` on (−dx, −dz).
      const yaw = Math.atan2(-dx, -dz);
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? -1 : 1;
        const p = sink.begin('debris', FX_PRIORITY.iceSkid);
        p.x = x + px * side * SKID_TRACK_OFFSET;
        p.y = SKID_Y;
        p.z = z + pz * side * SKID_TRACK_OFFSET;
        p.yaw = yaw;
        p.flat = true;
        // A **track mark**, not a block: 3.4 u wide, a slab thin, and 4×
        // that long down the lane the tank is sliding along.
        p.lengthK = 4;
        // Art §5: "skid marks fade in 2 s". The debris envelope spends the
        // last 30% of a life shrinking, so a 2 s mark thins for 600 ms.
        p.lifeMs = 2000;
        p.size0 = 3.4;
        p.size1 = 3.4;
        // `iceSheen`, not `ice`, and over 1: ice is a **gameplay** surface and
        // the player has to know they are sliding without inferring it from
        // drift. At `ice × 0.9` on a 25%-alpha decal this row was a whisper
        // (T4.2 report §6.2); the coordinator's ruling was to make it loud.
        tint(p, C.frost, 1.4);
        sink.emit();
      }
      for (let i = 0; i < 2; i++) {
        const p = sink.begin('spark', FX_PRIORITY.iceSkid);
        p.x = x + (sink.rand(i * 3 + 1) - 0.5) * 12;
        p.y = between(sink, i * 3 + 2, 1, 5);
        p.z = z + (sink.rand(i * 3 + 3) - 0.5) * 12;
        p.vx = -dx * between(sink, i * 3 + 4, 14, 42);
        p.vz = -dz * between(sink, i * 3 + 4, 14, 42);
        p.vy = between(sink, i * 3 + 5, 10, 28);
        p.gravity = 90;
        p.lifeMs = 780;
        p.size0 = 1.9;
        p.size1 = 0.6;
        p.stretch = 0.012;
        tint(p, C.frost, 2.3);
        sink.emit();
      }
    },
  },

  // -------------------------------------------------------------------------
  // "Tree rustle (tank under canopy) | 3 leaf motes + canopy jiggle 150 ms | 3"
  //
  // The **canopy jiggle is not implemented**, deliberately. The canopies are
  // instanced statics written once by `terrainView.build` (that file's whole
  // design is "no per-frame rebuilds", arch §5), so jiggling one would mean
  // re-opening a 1 200-line tested view to animate a 150 ms decoration. Called
  // out in the T4.1/T4.2 report rather than done quietly; the motes ship.
  // -------------------------------------------------------------------------
  treeEntered: {
    row: 'Tree rustle',
    budget: 3,
    lights: 0,
    emit(sink, e): void {
      if (!sink.hasTank(e.tankId)) return;
      const x = sink.tankX(e.tankId);
      const z = sink.tankZ(e.tankId);
      for (let i = 0; i < 3; i++) {
        const p = sink.begin('debris', FX_PRIORITY.treeRustle);
        p.x = x + (sink.rand(i * 4 + 1) - 0.5) * 16;
        // Art §5 floats canopies at h = 14 u; a leaf falls out of one.
        p.y = between(sink, i * 4 + 2, 10, 14);
        p.z = z + (sink.rand(i * 4 + 3) - 0.5) * 16;
        p.vx = (sink.rand(i * 4 + 4) - 0.5) * 26;
        p.vz = (sink.rand(i * 4 + 5) - 0.5) * 26;
        p.vy = -4;
        p.gravity = 60; // a leaf, not a brick
        p.lifeMs = 1250;
        // The whole row rides on three motes now: the coordinator amended §8
        // to drop the canopy jiggle rather than open a per-frame write path
        // into `terrainView`'s instanced statics, so these have to carry the
        // tell on their own. Concealment is a mechanic and the counter-play is
        // *noticing* it, which a 1.9 u speck at 1.2× did not deliver — bigger,
        // brighter, wider-thrown, and one of the three is the light highlight
        // so the flutter separates against the canopy it fell out of.
        p.size0 = 2.7;
        p.size1 = 2.7;
        p.lengthK = 0.45; // a leaf is a flake, not a cube
        p.spin = between(sink, i * 4 + 6, -9, 9);
        p.roll = sink.rand(i * 4 + 7) * Math.PI;
        tint(p, i === 1 ? C.leafDeep : C.leaf, i === 2 ? 2.1 : 1.7);
        sink.emit();
      }
    },
  },

  // -------------------------------------------------------------------------
  // "Stun (friendly fire) | yellow ring + orbiting stars over stunned tank | 4"
  //
  // The orbiting stars are `tankView.ts`'s `stun` overlay role, already on the
  // field for the whole `stunT`. This is §8's ring, plus three motes.
  // -------------------------------------------------------------------------
  playerStunned: {
    row: 'Stun (friendly fire)',
    budget: 4,
    lights: 0,
    emit(sink, e): void {
      const id = e.playerIndex; // a player tank's id IS its player index
      if (!sink.hasTank(id)) return;
      const x = sink.tankX(id);
      const z = sink.tankZ(id);
      const ring = sink.begin('ring', FX_PRIORITY.stun);
      ring.x = x;
      ring.y = RING_Y;
      ring.z = z;
      ring.flat = true;
      ring.lifeMs = 750;
      ring.size0 = 14;
      ring.size1 = 34;
      tint(ring, C.accent, 2.6);
      sink.emit();
      for (let i = 0; i < 3; i++) {
        const p = sink.begin('spark', FX_PRIORITY.stun);
        p.x = x + (sink.rand(i * 3 + 1) - 0.5) * 10;
        p.y = 11;
        p.z = z + (sink.rand(i * 3 + 2) - 0.5) * 10;
        p.vy = between(sink, i * 3 + 3, 12, 28);
        p.gravity = 40;
        p.lifeMs = 720;
        p.size0 = 1.4;
        p.size1 = 0.6;
        tint(p, C.accent, 1.6);
        sink.emit();
      }
    },
  },
};

/**
 * The `GameEvent` variants art §8 gives **no** row to, with the reason. Kept as
 * data so `tests/render/recipes.test.ts` can assert that every variant in
 * `core/events.ts` is either implemented or deliberately silent — the check
 * that catches a new event slipping through with no decision made about it.
 */
export const NO_RECIPE: Readonly<Record<string, string>> = Object.freeze({
  bulletsCanceled: 'art §8 has no row; two bullets meeting is a sim detail',
  bulletDespawned:
    'art §8 has no row; the border wall and shielded hits are silent',
  tankHit: "art §9's white hit-flash covers it, in tankView.ts",
  playerSpawned: "art §4's spawn star covers it, in tankView.ts",
  enemySpawned: 'the visible beat is `enemySpawnStarted`, 1.3 s earlier',
  tierChanged: 'art §4 shows tier as barrel rings, in tankView.ts',
  shovelPhase: "terrainView.ts owns the shovel's steel and its blink",
  clockStarted: 'HUD/audio, not VFX',
  clockEnded: 'HUD/audio, not VFX',
  grenadeUsed: 'every kill it causes emits its own `tankDestroyed`',
  extraLife: 'HUD/audio, not VFX',
  scoreAwarded: "art §10's world-space score popups are T4.3's",
  stageCleared: "art §10's curtain is T4.3's",
  gameOver: "art §10's curtain is T4.3's",
  pauseToggled: 'a paused frame freezes FX; it does not start one',
});

// ---------------------------------------------------------------------------
// --- Dispatch --------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Runs `e`'s recipe, if it has one.
 *
 * The cast is the one place this file needs one, and it is sound by
 * construction: {@link RecipeTable} is keyed **by the discriminant**, so the
 * entry reached through `e.t` is by definition the entry declared for `e`'s own
 * variant. TypeScript cannot express "index a mapped type with a value's own
 * discriminant and get the matching member", so the correspondence is asserted
 * here once instead of being lost by typing every `emit` as `GameEvent`.
 */
export function applyRecipe(sink: FxSink, e: GameEvent): void {
  const recipe = RECIPES[e.t];
  if (recipe === undefined) return;
  (recipe.emit as (s: FxSink, ev: GameEvent) => void)(sink, e);
}

/**
 * Fields folded into a recipe's random seed. A fixed list rather than
 * `Object.keys`, which would allocate on the event path.
 */
const SEED_FIELDS: readonly string[] = Object.freeze([
  'tankId',
  'tx',
  'ty',
  'x',
  'y',
  'dir',
  'removedMask',
  'spawnOrdinal',
  'playerIndex',
  'points',
]);

/**
 * A seed derived from the event itself, so the same event always produces the
 * same spray.
 *
 * That is what makes `scripts/capture-fx.ts` reproducible — two runs of the
 * same scripted skirmish shatter the same brick the same way — while two
 * *different* bricks still shatter differently, because their `tx`/`ty` differ.
 */
export function seedOf(e: GameEvent): number {
  // A read-only view of a discriminated union's fields. No allocation: the
  // cast is erased, and the loop below reads properties that may be absent.
  const record = e as unknown as Record<string, unknown>;
  let h = 2166136261;
  for (let i = 0; i < e.t.length; i++) {
    h = Math.imul(h ^ e.t.charCodeAt(i), 16777619) >>> 0;
  }
  for (let i = 0; i < SEED_FIELDS.length; i++) {
    const v = record[SEED_FIELDS[i]];
    if (typeof v === 'number') {
      h = Math.imul(h ^ ((v * 8) | 0), 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// --- Shared placement constants --------------------------------------------
// ---------------------------------------------------------------------------

/** Art §8's brick chunks: "gravity 600 u/s²". Every heavy piece uses it. */
const BRICK_GRAVITY = 600;
/** The barrel's height on every tank model (models.ts's turret band). */
const MUZZLE_Y = 7;
/**
 * How high a ground ring floats. The lattice sits at 0.06 u (`sceneRoot.ts`);
 * 0.5 clears it and the ice decal without reading as a ring in the air.
 */
const RING_Y = 0.5;
/** Skid marks sit just above the ice decal they are laid on. */
const SKID_Y = 0.4;
/** Half the gap between a tank's two tracks (models.ts's `TRACK_X`). */
const SKID_TRACK_OFFSET = 6;

/** The eagle's tile centre — `EAGLE_TILE` (6, 12) is a constant of the board. */
const EAGLE_X = 6 * 16 + 8;
const EAGLE_Z = 12 * 16 + 8;

/**
 * Art §8's "12 debris chunks (**hull-colored**)".
 *
 * Read entirely off the event: `kind` and `enemyType` are on it, and a player
 * tank's `tankId` **is** its player index (`players.ts` allocates slots 0 and 1
 * up front and never moves them — the same fact `tankView.ts` relies on).
 */
function hullColourOf(e: EventOf<'tankDestroyed'>): readonly number[] {
  if (e.kind === 'player') {
    return e.tankId === 1 ? C.player2 : C.player1;
  }
  switch (e.enemyType) {
    case 'fast':
      return C.enemyFast;
    case 'power':
      return C.enemyPower;
    case 'armor':
      return C.enemyArmor;
    default:
      return C.enemyBasic;
  }
}
