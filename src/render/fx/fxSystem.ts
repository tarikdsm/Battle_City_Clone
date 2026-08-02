// src/render/fx/fxSystem.ts — the pooled particle and dynamic-light machinery
// of art §8 and §6. Presentation only: it **reads** `GameState` and the event
// stream and writes to neither (arch §3.3).
//
// ## The two halves of this file
//
// Everything above `--- The view ---` is **pure**: the pools, the eviction rule,
// the per-kind curves and the light table. That is what `tests/render/
// fxSystem.test.ts` asserts in the Vitest node environment, where there is no
// DOM and no WebGL. Below it is the `InstancedMesh` / `PointLight` plumbing,
// verified by `scripts/capture-fx.ts`'s screenshot checklist.
//
// ## Five kinds, five draw calls — never 180
//
// Art §8 caps the field at ~180 live particles at High. Those 180 are **five**
// `InstancedMesh`es, one per particle *kind*, and a kind is chosen by what a
// particle physically is rather than by which event spawned it:
//
// | kind | surface | what it is |
// |---|---|---|
// | `debris` | lit, opaque | brick chunks, metal shards, hull debris, emblem shards, leaves, skid marks |
// | `spark` | additive, bloomed | white-hot sparks, gold motes, frost motes |
// | `smoke` | lit, α 0.35 | dust puffs, explosion smoke, the base's column, the eagle's wisps |
// | `ring` | additive | ground rings, shockwaves, spawn rings, the stun ring |
// | `flash` | additive, bloomed | muzzle flash, explosion flash sphere |
//
// A kind draws **nothing at all** while its count is 0 (`InstancedMesh` with
// `count === 0` issues no draw), so an idle board costs exactly what it did
// before this file existed. Measured before/after in `docs/calibration/fx.json`.
//
// ## Data-oriented on purpose
//
// Particles are a structure of arrays of typed arrays, allocated once at
// construction and never again — arch §11's "near-zero allocations in render".
// A spawn is a write into a preallocated slot; there is no per-particle object,
// no per-frame `Vector3`, and no `Object3D.add` after construction. The one
// concession to readability is {@link FxSink.begin}, which hands out a **shared**
// spawn record that `emit()` copies into the pool: the recipes read like prose
// and still allocate nothing.
//
// ## Eviction, not growth
//
// When a spawn would exceed the budget the pool **drops the lowest-priority live
// particle** and reuses its slot — it never grows and never refuses. That is the
// difference between a busy frame that costs a fixed amount and one that costs
// whatever the board happened to do; art §8's budgets are hard caps, and a cap
// enforced by growing the pool is not a cap.

import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  PlaneGeometry,
  PointLight,
  type Material,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three';

import type { GameEvent } from '../../core/events';
import type { GameState } from '../../core/types';
import { PALETTE, type Materials, type Quality } from '../materials';
import { BILLBOARD_X, animDtOf, writePartMatrix } from '../models';
import { BLOOM_LAYER } from '../post';
import type { SceneRoot } from '../sceneRoot';
import { applyRecipe, seedOf } from './recipes';

// ---------------------------------------------------------------------------
// --- Vocabulary (pure) -----------------------------------------------------
// ---------------------------------------------------------------------------

/** One `InstancedMesh` each — see the file header's table. */
export type FxKind = 'debris' | 'spark' | 'smoke' | 'ring' | 'flash';

export const FX_KINDS: readonly FxKind[] = Object.freeze([
  'debris',
  'spark',
  'smoke',
  'ring',
  'flash',
]);

const KIND_INDEX: Readonly<Record<FxKind, number>> = Object.freeze({
  debris: 0,
  spark: 1,
  smoke: 2,
  ring: 3,
  flash: 4,
});

/**
 * Art §8: "Global cap ~180 live particles (High)"; art §7's Low row: "particle
 * budgets halved". Medium is not halved — §7 only names Low.
 *
 * The **pool is always allocated for the High figure** and `cap` moves with the
 * preset, so a quality switch evicts rather than reallocating (and switching
 * back costs nothing).
 */
export const PARTICLE_CAP: Readonly<Record<Quality, number>> = Object.freeze({
  high: 180,
  medium: 180,
  low: 90,
});

/**
 * Art §6: "Dynamic point-light pool (**max 8**, priority by proximity/
 * importance)"; art §7's Low row: "lights pool halved".
 *
 * **Six, not eight — measured, and the one place this task ships under the
 * doc's allowance.** A resident point light costs every lit fragment a loop
 * iteration whether it is on or off, and on the reference machine (Intel UHD
 * ANGLE/D3D11, 1600×900, DPR 1) the eighth is not a linear step but a cliff.
 * From `docs/calibration/fx.json`, one played stage at High:
 *
 * | resident | mean ms | median | p95 | delivered fps |
 * |---|---|---|---|---|
 * | 0 (pre-FX, `play.json`) | 2.03 | 1.9 | 3.5 | 28.5 |
 * | 4 | 2.47 | 2.4 | 3.7 | 49.9 |
 * | **6 (shipped)** | **2.35** | **2.2** | **3.5** | **46.4** |
 * | 8 | 3.45 / 3.67 | 3.2 | 5.3 / 6.1 | 26.6 / 23.5 |
 *
 * Four and six are indistinguishable; eight costs **+1.1 ms of frame CPU and
 * roughly half the delivered frame rate** (reproduced across two runs). Six is
 * inside art §6's own word — "max 8" is a ceiling, not a requirement — and
 * arch §11's first budget row is "60 FPS sustained: desktop @High", which the
 * eighth light spends more of than every particle in this task combined.
 * Reported for a §6 amendment; raise it back only with a measurement.
 *
 * The **resident** count follows the preset, i.e. lights are removed from the
 * scene on Low rather than merely left dark: three compiles `NUM_POINT_LIGHTS`
 * into every program, so idle lights still cost the preset that can least
 * afford them. three notices the change through `lights.state.version` and
 * recompiles by itself, and a preset switch already pays for a recompile
 * (`renderer.ts`). Within a preset the count never moves — see `release`.
 */
export const LIGHT_CAP: Readonly<Record<Quality, number>> = Object.freeze({
  high: 6,
  medium: 6,
  low: 3,
});

/** Bullet glows are art §6's one "Low: off" light. */
const BULLET_GLOW_QUALITY: Readonly<Record<Quality, boolean>> = Object.freeze({
  high: true,
  medium: true,
  low: false,
});

/**
 * Size of one particle over its life, as a multiplier on the recipe's own
 * `size0 → size1` ramp. The kind owns the *envelope*; the recipe owns the
 * *scale*, so art §8's "flash sphere scale 1→2.2 over 120 ms" is expressed
 * where §8 puts it (in the recipe) rather than hidden in here.
 *
 * Every kind must reach **0** at `t = 1`, because none of these can fade by
 * alpha: `InstancedMesh` carries `instanceColor` (a *diffuse* colour) and there
 * is no per-instance alpha in three 0.185.1. Additive kinds could fade by
 * colour alone, but `smoke` and `debris` are ordinary blended surfaces whose
 * material opacity is shared by every instance — so shrinking out is the only
 * per-particle disappearance available, and it is the one all five use.
 */
export function sizeFactorAt(kind: FxKind, t: number): number {
  if (t <= 0) return kind === 'smoke' ? SMOKE_BIRTH : 1;
  if (t >= 1) return 0;
  switch (kind) {
    case 'debris':
      // Holds full size, then collapses over the last 30% — for a 0.7 s brick
      // chunk that is 210 ms of shrink, which reads as settling rather than as
      // popping. A 2 s ice skid mark gets 600 ms, i.e. art §5's "fade in 2 s".
      return t < 0.7 ? 1 : (1 - t) / 0.3;
    case 'spark':
      return 1 - 0.55 * t;
    case 'smoke':
      // Puff out fast, keep drifting wider, thin away over the last third.
      return (
        (SMOKE_BIRTH + (1 - SMOKE_BIRTH) * Math.min(1, t / 0.3)) *
        (t < 0.66 ? 1 : (1 - t) / 0.34)
      );
    case 'ring':
    case 'flash':
      return 1;
  }
}

/** A smoke puff is born at 45% of its ramp and inflates from there. */
const SMOKE_BIRTH = 0.45;

/**
 * Brightness of one particle over its life, as a multiplier on the recipe's
 * colour. Additive kinds fade to black (which *is* invisible for an additive
 * surface); the two blended kinds hold their colour and disappear by size.
 */
export function tintFactorAt(kind: FxKind, t: number): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  switch (kind) {
    case 'debris':
      return 1;
    case 'smoke':
      // Dims as it dissipates, but never to black: a lit surface going black
      // reads as a hole rather than as thinning smoke.
      return 1 - 0.4 * t;
    case 'spark':
    case 'flash':
      return (1 - t) ** 1.5;
    case 'ring':
      return (1 - t) ** 2;
  }
}

/**
 * A deterministic value in `[0, 1)` from a seed and an index — the render
 * layer's only source of randomness.
 *
 * `Math.random` is not banned here (that rule is core's, arch §2), but a
 * screenshot harness cannot reproduce a frame it cannot re-derive: with this,
 * the same event produces the same spray of chunks on every run, so
 * `scripts/capture-fx.ts` compares like with like. Seeds come from the event's
 * own payload (see `seedOf`), which is what makes two *different* bricks
 * shatter differently while one brick shatters the same way twice.
 *
 * Body is one round of the murmur3 finaliser over a Weyl-stepped seed.
 */
export function hash01(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// --- The particle pool (pure) ----------------------------------------------
// ---------------------------------------------------------------------------

/**
 * The **shared** spawn record. `FxSink.begin` resets every field and hands this
 * exact object back, so a recipe reads like a description of the particle and
 * still allocates nothing — and a field the recipe forgets holds a documented
 * default rather than the previous particle's value.
 */
export interface FxSpawn {
  kind: FxKind;
  /** Higher survives. Recipes take theirs from `FX_PRIORITY` (recipes.ts). */
  priority: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Downward acceleration, u/s². Art §8's brick chunks are 600. */
  gravity: number;
  lifeMs: number;
  /** Scale at birth and at death; the kind's envelope multiplies both. */
  size0: number;
  size1: number;
  /** **Linear** RGB, i.e. what `new Color(hex)` produces. See recipes.ts. */
  r: number;
  g: number;
  b: number;
  yaw: number;
  roll: number;
  /** rad/s about y; roll turns at 0.63× this, which is what makes it tumble. */
  spin: number;
  /**
   * Length added along the velocity axis, per u/s of speed. `0` leaves the
   * piece unstretched; `0.02` turns a 1 u spark at 150 u/s into a 4 u streak.
   */
  stretch: number;
  /**
   * Depth as a multiple of width, so a piece can be a **streak** rather than a
   * cube. 1 is square; art §5's ice skid marks are 5.5, which turns a 2.4 u
   * decal into a 13 u track mark. Multiplies with {@link FxSpawn.stretch}.
   */
  lengthK: number;
  /** Art §8's brick chunks: "gravity 600 u/s², **1 bounce**". */
  bounce: boolean;
  /** Lies in the board plane and ignores `roll` — rings and skid marks. */
  flat: boolean;
}

/** The typed arrays, exposed so the view can write matrices without copies. */
export interface ParticleData {
  readonly kind: Uint8Array;
  readonly priority: Float32Array;
  readonly seq: Float64Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly gravity: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly yaw: Float32Array;
  readonly roll: Float32Array;
  readonly spin: Float32Array;
  readonly stretch: Float32Array;
  readonly lengthK: Float32Array;
  readonly flags: Uint8Array;
  /** Dense list of occupied slots, `live[0 … count)`. */
  readonly live: Int32Array;
}

const FLAG_BOUNCE = 1;
const FLAG_FLAT = 2;
/** How thin a `flat` piece is, as a fraction of its width. */
const FLAT_THICKNESS = 0.14;
/** Cleared once a bouncing particle has spent its one bounce. */
const FLAG_BOUNCED = 4;

/** Restitution and tangential damping of art §8's single brick-chunk bounce. */
const BOUNCE_RESTITUTION = 0.42;
const BOUNCE_FRICTION = 0.65;

export interface ParticlePool {
  /** Slots allocated, once, for the High cap. Never changes. */
  readonly capacity: number;
  /** Live particles. */
  readonly count: number;
  /** The budget in force, ≤ `capacity`. Lowering it evicts immediately. */
  readonly cap: number;
  readonly data: ParticleData;
  setCap(cap: number): void;
  /** Resets the shared spawn record to its defaults and returns it. */
  begin(kind: FxKind, priority: number): FxSpawn;
  /** Commits the record — evicting the lowest-priority live particle if full. */
  emit(): number;
  /** Integrates and retires. `dtMs` is already zeroed on a paused frame. */
  advance(dtMs: number): void;
  /** How many live particles are of `kind` — the budget assertions read this. */
  countOf(kind: FxKind): number;
  clear(): void;
}

export function createParticlePool(capacity: number): ParticlePool {
  const n = Math.max(1, capacity);
  const f32 = (): Float32Array => new Float32Array(n);
  const data: ParticleData = {
    kind: new Uint8Array(n),
    priority: f32(),
    seq: new Float64Array(n),
    x: f32(),
    y: f32(),
    z: f32(),
    vx: f32(),
    vy: f32(),
    vz: f32(),
    gravity: f32(),
    age: f32(),
    life: f32(),
    size0: f32(),
    size1: f32(),
    r: f32(),
    g: f32(),
    b: f32(),
    yaw: f32(),
    roll: f32(),
    spin: f32(),
    stretch: f32(),
    lengthK: f32(),
    flags: new Uint8Array(n),
    live: new Int32Array(n),
  };

  const free = new Int32Array(n);
  let freeCount = n;
  for (let i = 0; i < n; i++) {
    free[i] = n - 1 - i;
  }
  /** Where each live slot sits in `data.live`, so removal is O(1). */
  const at = new Int32Array(n).fill(-1);
  let liveCount = 0;
  let cap = n;
  let seq = 0;

  const spawn: FxSpawn = {
    kind: 'debris',
    priority: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    lifeMs: 400,
    size0: 2,
    size1: 2,
    r: 1,
    g: 1,
    b: 1,
    yaw: 0,
    roll: 0,
    spin: 0,
    stretch: 0,
    lengthK: 1,
    bounce: false,
    flat: false,
  };

  /** Index into `data.live` of the live particle that loses a contested slot. */
  function worstLive(): number {
    let worst = 0;
    for (let i = 1; i < liveCount; i++) {
      const a = data.live[i];
      const b = data.live[worst];
      if (
        data.priority[a] < data.priority[b] ||
        // Same priority: the one that has been on screen longest goes. Using
        // the spawn sequence rather than `age` keeps the order total, so the
        // choice cannot depend on the order two same-frame spawns arrived in.
        (data.priority[a] === data.priority[b] && data.seq[a] < data.seq[b])
      ) {
        worst = i;
      }
    }
    return worst;
  }

  function removeAt(index: number): void {
    const slot = data.live[index];
    const last = liveCount - 1;
    const moved = data.live[last];
    data.live[index] = moved;
    at[moved] = index;
    at[slot] = -1;
    liveCount = last;
    free[freeCount++] = slot;
  }

  return {
    capacity: n,
    get count(): number {
      return liveCount;
    },
    get cap(): number {
      return cap;
    },
    data,

    setCap(next: number): void {
      cap = Math.max(0, Math.min(n, Math.floor(next)));
      // Evict down to the new budget immediately rather than waiting for the
      // living ones to expire: a preset drop is a request for less work *now*.
      while (liveCount > cap) {
        removeAt(worstLive());
      }
    },

    begin(kind: FxKind, priority: number): FxSpawn {
      spawn.kind = kind;
      spawn.priority = priority;
      spawn.x = 0;
      spawn.y = 0;
      spawn.z = 0;
      spawn.vx = 0;
      spawn.vy = 0;
      spawn.vz = 0;
      spawn.gravity = 0;
      spawn.lifeMs = 400;
      spawn.size0 = 2;
      spawn.size1 = 2;
      spawn.r = 1;
      spawn.g = 1;
      spawn.b = 1;
      spawn.yaw = 0;
      spawn.roll = 0;
      spawn.spin = 0;
      spawn.stretch = 0;
      spawn.lengthK = 1;
      spawn.bounce = false;
      spawn.flat = false;
      return spawn;
    },

    emit(): number {
      if (cap === 0) return -1;
      let slot: number;
      if (liveCount >= cap) {
        // Full: the lowest-priority live particle loses its slot **in place**,
        // so `live` and `at` are untouched and nothing is reallocated. This is
        // the whole eviction rule — the pool never grows and never refuses.
        slot = data.live[worstLive()];
      } else {
        slot = free[--freeCount];
        at[slot] = liveCount;
        data.live[liveCount++] = slot;
      }
      data.kind[slot] = KIND_INDEX[spawn.kind];
      data.priority[slot] = spawn.priority;
      data.seq[slot] = seq++;
      data.x[slot] = spawn.x;
      data.y[slot] = spawn.y;
      data.z[slot] = spawn.z;
      data.vx[slot] = spawn.vx;
      data.vy[slot] = spawn.vy;
      data.vz[slot] = spawn.vz;
      data.gravity[slot] = spawn.gravity;
      data.age[slot] = 0;
      // A zero-length life would divide by zero in `t`; one frame is the floor.
      data.life[slot] = Math.max(1, spawn.lifeMs);
      data.size0[slot] = spawn.size0;
      data.size1[slot] = spawn.size1;
      data.r[slot] = spawn.r;
      data.g[slot] = spawn.g;
      data.b[slot] = spawn.b;
      data.yaw[slot] = spawn.yaw;
      data.roll[slot] = spawn.roll;
      data.spin[slot] = spawn.spin;
      data.stretch[slot] = spawn.stretch;
      data.lengthK[slot] = spawn.lengthK;
      data.flags[slot] =
        (spawn.bounce ? FLAG_BOUNCE : 0) | (spawn.flat ? FLAG_FLAT : 0);
      return slot;
    },

    advance(dtMs: number): void {
      if (dtMs <= 0) return; // a paused frame advances nothing (art §9)
      const dt = dtMs / 1000;
      // Backwards, so a retirement's swap-with-last never skips a live slot.
      for (let i = liveCount - 1; i >= 0; i--) {
        const p = data.live[i];
        const age = data.age[p] + dtMs;
        if (age >= data.life[p]) {
          removeAt(i);
          continue;
        }
        data.age[p] = age;
        data.vy[p] -= data.gravity[p] * dt;
        data.x[p] += data.vx[p] * dt;
        data.y[p] += data.vy[p] * dt;
        data.z[p] += data.vz[p] * dt;
        data.yaw[p] += data.spin[p] * dt;
        data.roll[p] += data.spin[p] * 0.63 * dt;
        if (data.y[p] < 0 && data.vy[p] < 0) {
          const flags = data.flags[p];
          data.y[p] = 0;
          if ((flags & FLAG_BOUNCE) !== 0 && (flags & FLAG_BOUNCED) === 0) {
            // Art §8: exactly **one** bounce. The spent flag is what makes the
            // second contact a landing rather than an infinite ripple.
            data.flags[p] = flags | FLAG_BOUNCED;
            data.vy[p] = -data.vy[p] * BOUNCE_RESTITUTION;
            data.vx[p] *= BOUNCE_FRICTION;
            data.vz[p] *= BOUNCE_FRICTION;
            data.spin[p] *= BOUNCE_FRICTION;
          } else {
            data.vy[p] = 0;
            data.vx[p] = 0;
            data.vz[p] = 0;
            data.spin[p] = 0;
          }
        }
      }
    },

    countOf(kind: FxKind): number {
      const k = KIND_INDEX[kind];
      let total = 0;
      for (let i = 0; i < liveCount; i++) {
        if (data.kind[data.live[i]] === k) total++;
      }
      return total;
    },

    clear(): void {
      while (liveCount > 0) {
        removeAt(liveCount - 1);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// --- The dynamic light pool (art §6) ---------------------------------------
// ---------------------------------------------------------------------------

export type FxLightKind =
  | 'muzzle'
  | 'clink'
  | 'explosion'
  | 'baseExplosion'
  | 'powerupPulse'
  | 'spawnStar'
  | 'bulletGlow';

/** How a light's intensity is shaped over its life. */
export type FxLightCurve = 'hold' | 'linear' | 'quadratic' | 'sine';

export interface FxLightSpec {
  /** `PointLight.distance`, i.e. art §6's "range N u". */
  readonly range: number;
  /** Lifetime in ms. **0 = one frame**, re-requested every frame (attached). */
  readonly ms: number;
  /** Peak intensity, in three's candela. See the note below the table. */
  readonly intensity: number;
  readonly curve: FxLightCurve;
  /** Higher survives; art §6's "priority by proximity/**importance**". */
  readonly priority: number;
}

/**
 * Art §6's dynamic-light list, verbatim in its ranges and durations.
 *
 * **The intensities are not in the doc and could not be** — three 0.185.1 is
 * physically-based, so a point light's contribution is `intensity / d²` and the
 * number that reads correctly depends entirely on the scene's scale. This board
 * is 208 **u** across (1 tile = 16 u), so a light meant to matter at half a
 * tile needs an intensity in the hundreds, and one meant to reach across the
 * base needs thousands. They are quoted here as `range² × wanted`, so the
 * arithmetic behind each is visible and re-derivable: `explosion` wants ≈ 2×
 * the key light's 3.8 at 30 u, hence 30² × 2 = 1800.
 */
export const FX_LIGHTS: Readonly<Record<FxLightKind, FxLightSpec>> =
  Object.freeze({
    // "muzzle flash (range 40 u, 60 ms)"
    muzzle: Object.freeze({
      range: 40,
      ms: 60,
      intensity: 420,
      curve: 'hold' as const,
      priority: 30,
    }),
    // Art §8's steel-hit row: "*clink* light 40 ms". Not in §6's list, because
    // §6 lists the pool's *shapes* — this is a muzzle-class light with §8's
    // shorter duration and a tighter range.
    clink: Object.freeze({
      range: 26,
      ms: 40,
      intensity: 260,
      curve: 'hold' as const,
      priority: 28,
    }),
    // "explosion (range 90 u, 400 ms, quadratic decay)"
    explosion: Object.freeze({
      range: 90,
      ms: 400,
      intensity: 1800,
      curve: 'quadratic' as const,
      priority: 70,
    }),
    // "base explosion (range 160 u, 1.2 s)"
    baseExplosion: Object.freeze({
      range: 160,
      ms: 1200,
      intensity: 5200,
      curve: 'quadratic' as const,
      priority: 100,
    }),
    // "power-up idle pulse (range 24 u, 1.2 s sine)" — attached to the item, so
    // it is re-requested every frame and its phase is the bob's, not its age.
    powerupPulse: Object.freeze({
      range: 24,
      ms: 0,
      intensity: 150,
      curve: 'sine' as const,
      priority: 20,
    }),
    // "spawn star (range 30 u)". Its duration is the spawn animation's.
    spawnStar: Object.freeze({
      range: 30,
      ms: 1300,
      intensity: 240,
      curve: 'linear' as const,
      priority: 40,
    }),
    // "bullet glow (tiny, attached, Low: off)"
    bulletGlow: Object.freeze({
      range: 22,
      ms: 0,
      intensity: 70,
      curve: 'hold' as const,
      priority: 5,
    }),
  });

export interface LightPool {
  readonly capacity: number;
  /** Lights in play. */
  readonly count: number;
  /** The budget in force — `LIGHT_CAP` for the preset. */
  readonly cap: number;
  readonly lights: readonly PointLight[];
  setCap(cap: number): void;
  /**
   * Claim a slot. Returns the light, or `null` when the pool is full and
   * `evict` is false.
   *
   * @param evict `false` for the two **attached** lights (the power-up pulse
   * and bullet glows), which take a free slot or go without: an attached light
   * is re-requested every frame, so letting it evict would let a stream of
   * bullets push an explosion's light off the board.
   */
  acquire(
    kind: FxLightKind,
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    evict: boolean,
  ): PointLight | null;
  /** Ages every live light and darkens the ones that expired. */
  advance(dtMs: number): void;
  /** Sine phase for `powerupPulse`, in ms — see art §9's power-up row. */
  setPulsePhase(ms: number): void;
  clear(): void;
}

/** Art §9: the power-up's light pulse shares the bob's 1.2 s period. */
export const PULSE_PERIOD_MS = 1200;

export function createLightPool(capacity: number): LightPool {
  const n = Math.max(1, capacity);
  const lights: PointLight[] = [];
  for (let i = 0; i < n; i++) {
    const light = new PointLight(0xffffff, 0, 1, 2);
    light.castShadow = false; // a shadow-casting point light is 6 extra draws
    lights.push(light);
  }
  const spec: (FxLightSpec | null)[] = new Array<FxLightSpec | null>(n).fill(
    null,
  );
  const age = new Float32Array(n);
  const seqOf = new Float64Array(n);
  let seq = 0;
  let cap = n;
  let live = 0;
  let pulseMs = 0;

  /**
   * An idle light is **dark, never hidden** — and that distinction is worth
   * 1.4 seconds.
   *
   * `WebGLRenderer.projectObject` returns early on `object.visible === false`,
   * so an invisible light is not in `lights.state` at all and
   * `numPointLights` — which is part of `programCacheKey` — drops. Toggling
   * `visible` as lights come and go therefore asks three for a *different
   * program* for every material on every flicker: measured on an Intel UHD,
   * one played stage produced a **1394 ms** frame and a mean of 11.9 ms against
   * a 2.0 ms baseline (`docs/calibration/fx.json`, and the reason it exists).
   *
   * Intensity 0 is a uniform. The count stays 8, one program set is compiled
   * once at boot, and the cost of an idle light is the shader loop iteration it
   * was always going to be — which is why art §7's Low row takes four of them
   * out of the scene entirely rather than merely darkening them.
   */
  function release(i: number): void {
    spec[i] = null;
    lights[i].intensity = 0;
    live--;
  }

  function intensityOf(i: number): number {
    const s = spec[i];
    if (s === null) return 0;
    switch (s.curve) {
      case 'hold':
        return s.intensity;
      case 'linear':
        return s.intensity * Math.max(0, 1 - age[i] / Math.max(1, s.ms));
      case 'quadratic':
        return s.intensity * Math.max(0, 1 - age[i] / Math.max(1, s.ms)) ** 2;
      case 'sine':
        // Art §9's power-up row: a 1.2 s sine. Never fully off — the item has
        // to stay findable — so it swings between 40% and 100%.
        return (
          s.intensity *
          (0.7 + 0.3 * Math.sin((2 * Math.PI * pulseMs) / PULSE_PERIOD_MS))
        );
    }
  }

  return {
    capacity: n,
    get count(): number {
      return live;
    },
    get cap(): number {
      return cap;
    },
    lights,

    setCap(next: number): void {
      cap = Math.max(0, Math.min(n, Math.floor(next)));
      while (live > cap) {
        let worst = -1;
        for (let i = 0; i < n; i++) {
          const s = spec[i];
          if (s === null) continue;
          if (
            worst === -1 ||
            s.priority < (spec[worst] as FxLightSpec).priority
          ) {
            worst = i;
          }
        }
        if (worst === -1) break;
        release(worst);
      }
    },

    acquire(kind, x, y, z, r, g, b, evict): PointLight | null {
      const s = FX_LIGHTS[kind];
      let index = -1;
      for (let i = 0; i < cap; i++) {
        if (spec[i] === null) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        if (!evict) return null;
        // Full: the lowest-priority light in play loses its slot, ties broken
        // by age — the same rule the particle pool uses, for the same reason.
        let worst = 0;
        for (let i = 1; i < cap; i++) {
          const a = spec[i] as FxLightSpec;
          const b2 = spec[worst] as FxLightSpec;
          if (
            a.priority < b2.priority ||
            (a.priority === b2.priority && seqOf[i] < seqOf[worst])
          ) {
            worst = i;
          }
        }
        // Reused **in place**: the slot never goes back to the free list, so
        // `live` must not move — decrementing here and re-incrementing below
        // is the off-by-one that leaves the pool one light short of art §6's
        // eight for the rest of the session.
        index = worst;
      }
      if (spec[index] === null) live++;
      spec[index] = s;
      age[index] = 0;
      seqOf[index] = seq++;
      const light = lights[index];
      light.position.set(x, y, z);
      light.color.setRGB(r, g, b);
      light.distance = s.range;
      light.intensity = intensityOf(index);
      return light;
    },

    advance(dtMs: number): void {
      for (let i = 0; i < n; i++) {
        const s = spec[i];
        if (s === null) continue;
        // `ms === 0` is an attached light: it expires the instant it is aged,
        // which is exactly once per frame, and is re-requested in the same
        // update before anything is drawn.
        if (dtMs > 0 || s.ms === 0) {
          age[i] += dtMs;
        }
        if (age[i] >= s.ms) {
          release(i);
          continue;
        }
        lights[i].intensity = intensityOf(i);
      }
    },

    setPulsePhase(ms: number): void {
      pulseMs = ms;
    },

    clear(): void {
      for (let i = 0; i < n; i++) {
        if (spec[i] !== null) release(i);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// --- The sink recipes are written against ----------------------------------
// ---------------------------------------------------------------------------

/**
 * Everything `recipes.ts` is allowed to do. Deliberately narrow: a recipe emits
 * particles, asks for a light, asks for a screen flash and reads the board
 * position of a tank — it cannot see the pools, the meshes or the scene.
 *
 * `recipes.ts` imports this **type-only**, so there is no import cycle between
 * the two files even though this one calls `applyRecipe`.
 */
export interface FxSink {
  begin(kind: FxKind, priority: number): FxSpawn;
  emit(): void;
  light(
    kind: FxLightKind,
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
  ): void;
  /** Art §8's player-explosion row. Suppressed by either accessibility flag. */
  screenFlash(ms: number, strength: number): void;
  /** Deterministic `[0, 1)`, seeded from the event — see {@link hash01}. */
  rand(i: number): number;
  seed(value: number): void;
  /** False when this id has not been drawn yet, i.e. the three below are stale. */
  hasTank(id: number): boolean;
  /** Board **centre** of the tank, in world coordinates (not its top-left). */
  tankX(id: number): number;
  tankZ(id: number): number;
  tankDir(id: number): number;
}

// ---------------------------------------------------------------------------
// --- The view --------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Art §11's two accessibility switches, as far as the FX layer is concerned. */
export interface FxFlags {
  /** `prefers-reduced-motion` or the settings toggle: "no screen flash". */
  reducedMotion: boolean;
  /** The dedicated `reducedFlash` setting (storage.ts). */
  reducedFlash: boolean;
}

export const DEFAULT_FX_FLAGS: FxFlags = Object.freeze({
  reducedMotion: false,
  reducedFlash: false,
});

/** What the capture harness reads back. One shared object; never allocated. */
export interface FxStats {
  particles: number;
  lights: number;
  /** Meshes that will actually draw this frame — the draw-call contribution. */
  activeKinds: number;
}

export interface FxSystem extends FxSink {
  /**
   * One frame. `dtMs` is the loop's real frame time — including on a paused
   * frame, which is its contract — and is zeroed here by {@link animDtOf},
   * because a frozen board must not keep exploding.
   */
  update(state: GameState, dtMs: number): void;
  onEvent(e: GameEvent): void;
  setQuality(q: Quality): void;
  setFlags(flags: FxFlags): void;
  stats(): FxStats;
  dispose(): void;
}

/** Art §4's eagle: "destroyed → … smoke wisps". One puff every this often. */
const WISP_INTERVAL_MS = 420;

/** Height the eagle's wisps rise from, and how big/slow they are. */
const WISP_Y = 7;

/** Tank ids the position cache covers — `tankView.ts`'s `TANK_ID_SPACE`. */
const TANK_ID_SPACE = 64;

export function createFxSystem(
  materials: Materials,
  sceneRoot: SceneRoot,
  flags: FxFlags = DEFAULT_FX_FLAGS,
): FxSystem {
  const group = new Group();
  sceneRoot.entities.add(group);

  const pool = createParticlePool(PARTICLE_CAP.high);
  const lightPool = createLightPool(LIGHT_CAP.high);

  // Geometries. `debris` and `spark` share one unit box; `smoke` is a low-poly
  // sphere, which needs no billboarding (a sphere looks the same from every
  // angle) and is the one FX kind the rig's light actually falls on. The `ring`
  // and the `flash` are authored **flat in XZ** and carry their falloff in
  // vertex colours — see their factories for the hexagon that made that
  // necessary.
  const boxGeo = createFxBoxGeometry();
  const smokeGeo = new IcosahedronGeometry(0.5, 1);
  const flashGeo = createFlashGeometry();
  const ringGeo = createRingGeometry();

  const meshes: Record<FxKind, InstancedMesh> = {
    debris: makeFxMesh(boxGeo, materials.fxDebris, false),
    spark: makeFxMesh(boxGeo, materials.fxSpark, true),
    smoke: makeFxMesh(smokeGeo, materials.fxSmoke, false),
    ring: makeFxMesh(ringGeo, materials.fxRing, false),
    flash: makeFxMesh(flashGeo, materials.fxFlash, true),
  };
  for (const kind of FX_KINDS) {
    group.add(meshes[kind]);
  }

  // Art §8's player-explosion row: "200 ms white **screen-edge** flash". A quad
  // parented to the camera, with the flash baked into its vertex colours so the
  // edges burn and the centre — where the board is — stays clear. It is one
  // object with one material, so its opacity is a per-material value and no
  // per-instance alpha is needed; and it is `visible = false` unless a player
  // has just died, so it costs no draw call at all the rest of the time.
  const screen = new Mesh(createScreenFlashGeometry(), materials.fxScreenFlash);
  screen.visible = false;
  screen.frustumCulled = false;
  screen.renderOrder = 10_000;
  sceneRoot.camera.add(screen);

  for (const light of lightPool.lights) {
    sceneRoot.scene.add(light);
  }

  // --- scratch, reused for the life of the system --------------------------
  const basis = new Float64Array(9);
  const colour = new Color();
  /**
   * The camera-facing basis, built once — art §2 fixes the camera at yaw 0 and
   * pitch 32°, so a billboard is `Rx(BILLBOARD_X)` and not a `lookAt`. Same
   * construction as `tankView.ts`'s spawn star: local −z is screen up, local +y
   * points at the camera.
   */
  const billboard = new Float64Array(9);
  {
    const c = Math.cos(BILLBOARD_X);
    const s = Math.sin(BILLBOARD_X);
    billboard[0] = 1;
    billboard[4] = c;
    billboard[7] = s;
    billboard[5] = -s;
    billboard[8] = c;
  }
  const used: Record<FxKind, number> = {
    debris: 0,
    spark: 0,
    smoke: 0,
    ring: 0,
    flash: 0,
  };
  /** 1 / material colour, so a recipe's linear colour survives `instanceColor`. */
  const inverseBase: Record<FxKind, Float64Array> = {
    debris: inverseOf(materials.fxDebris),
    spark: inverseOf(materials.fxSpark),
    smoke: inverseOf(materials.fxSmoke),
    ring: inverseOf(materials.fxRing),
    flash: inverseOf(materials.fxFlash),
  };
  const statsOut: FxStats = { particles: 0, lights: 0, activeKinds: 0 };

  // Tank positions, refreshed every frame. Art §8 gives three rows — ice skid,
  // tree rustle and stun — whose events carry a `tankId` and **no position**
  // (`core/events.ts`), so this is the one lookup the layer cannot avoid. It is
  // a lookup and not a derivation: nothing here decides *whether* an effect
  // happens, only where the event that already happened should be drawn.
  const tankX = new Float32Array(TANK_ID_SPACE);
  const tankZ = new Float32Array(TANK_ID_SPACE);
  const tankDir = new Uint8Array(TANK_ID_SPACE);
  const tankSeen = new Uint8Array(TANK_ID_SPACE);

  let quality: Quality = 'high';
  let currentFlags: FxFlags = flags;
  let randSeed = 0;
  let frame = 0;

  // Screen flash (art §8) — one at a time; a second overrides the first.
  let flashMs = -1;
  let flashDurMs = 0;
  let flashStrength = 0;

  // The eagle's wisps (art §4) — the seam `propView.ts` left open. Armed by the
  // event, disarmed when a state says the eagle is standing again.
  let wispsArmed = false;
  let wispT = 0;
  let wispX = 0;
  let wispZ = 0;

  // The power-up's idle pulse (art §6/§9) — the other seam. Its phase is the
  // bob's, so it is accumulated with the same re-arm rules `propView.ts` uses.
  let powerupMs = 0;
  let powerupArmed = false;

  function inverseOf(
    material: MeshStandardMaterial | MeshBasicMaterial,
  ): Float64Array {
    const out = new Float64Array(3);
    out[0] = material.color.r > 1e-6 ? 1 / material.color.r : 1;
    out[1] = material.color.g > 1e-6 ? 1 / material.color.g : 1;
    out[2] = material.color.b > 1e-6 ? 1 / material.color.b : 1;
    return out;
  }

  function makeFxMesh(
    geometry: BufferGeometry,
    material: Material,
    bloom: boolean,
  ): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, PARTICLE_CAP.high);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // No particle casts or receives a shadow. Casting would put every kind in
    // the shadow pass — five more draws for silhouettes a few units across —
    // and receiving would make a spark, which *is* light, take one.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (bloom) {
      // Art §1 pillar 2 rations emissive surfaces and names "flashes" among
      // them. `enable`, not `set`: the mesh stays on layer 0 so the beauty pass
      // still draws it, and gains the layer the bloom source pass renders.
      mesh.layers.enable(BLOOM_LAYER);
    }
    // The bounding sphere comes from the GEOMETRY — a unit primitive at the
    // origin — so three would cull every particle on the board.
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Row-major Ry(yaw)·Rx(roll) — the tumble. */
  function setTumble(yaw: number, roll: number): void {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    basis[0] = cy;
    basis[1] = sy * sr;
    basis[2] = sy * cr;
    basis[3] = 0;
    basis[4] = cr;
    basis[5] = -sr;
    basis[6] = -sy;
    basis[7] = cy * sr;
    basis[8] = cy * cr;
  }

  /**
   * A basis whose local **−z** points along `(vx, vy, vz)` — the entity layer's
   * "local −z is forward" convention (models.ts), so scaling depth stretches a
   * spark along its own flight.
   */
  function setAlongVelocity(vx: number, vy: number, vz: number): void {
    const len = Math.hypot(vx, vy, vz) || 1;
    const zx = -vx / len;
    const zy = -vy / len;
    const zz = -vz / len;
    // Any up vector that is not parallel to z; near-vertical flight picks +x.
    const ux = Math.abs(zy) > 0.99 ? 1 : 0;
    const uy = Math.abs(zy) > 0.99 ? 0 : 1;
    let xx = uy * zz - 0 * zy;
    let xy = 0 * zx - ux * zz;
    let xz = ux * zy - uy * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    basis[0] = xx;
    basis[1] = yx;
    basis[2] = zx;
    basis[3] = xy;
    basis[4] = yy;
    basis[5] = zy;
    basis[6] = xz;
    basis[7] = yz;
    basis[8] = zz;
  }

  function writeParticles(): void {
    for (const kind of FX_KINDS) {
      used[kind] = 0;
    }
    const d = pool.data;
    for (let i = 0; i < pool.count; i++) {
      const p = d.live[i];
      const kind = FX_KINDS[d.kind[p]];
      const mesh = meshes[kind];
      const index = used[kind];
      if (index >= mesh.instanceMatrix.count) continue;
      used[kind] = index + 1;

      const t = d.age[p] / d.life[p];
      const size =
        (d.size0[p] + (d.size1[p] - d.size0[p]) * t) * sizeFactorAt(kind, t);
      const flat = (d.flags[p] & FLAG_FLAT) !== 0;
      // A flat piece is a **decal**, not a cube: art §8's ice skid marks are
      // laid on the board and a 2.4 u block standing on the ice is not a mark.
      // The ring is unaffected — its geometry is entirely at y = 0, so any
      // non-zero height scale renders the same thing.
      const height = flat ? size * FLAT_THICKNESS : size;
      let depth = size * d.lengthK[p];
      const stretch = d.stretch[p];
      let axes = basis;
      if (kind === 'flash') {
        // A flare faces the camera, always. Art §2 fixes the camera, so this is
        // the same constant basis `tankView.ts` and `propView.ts` use for their
        // billboards rather than a per-particle `lookAt`.
        axes = billboard;
      } else if (stretch > 0) {
        const speed = Math.hypot(d.vx[p], d.vy[p], d.vz[p]);
        depth *= 1 + stretch * speed;
        setAlongVelocity(d.vx[p], d.vy[p], d.vz[p]);
      } else if (flat) {
        setTumble(d.yaw[p], 0);
      } else {
        setTumble(d.yaw[p], d.roll[p]);
      }

      writePartMatrix(
        mesh,
        index,
        axes,
        d.x[p],
        d.y[p],
        d.z[p],
        0,
        0,
        0,
        size,
        height,
        depth,
      );

      const k = tintFactorAt(kind, t);
      const inv = inverseBase[kind];
      colour.setRGB(
        d.r[p] * k * inv[0],
        d.g[p] * k * inv[1],
        d.b[p] * k * inv[2],
      );
      mesh.setColorAt(index, colour);
    }

    let active = 0;
    for (const kind of FX_KINDS) {
      const mesh = meshes[kind];
      const n = used[kind];
      mesh.count = n;
      if (n === 0) continue;
      active++;
      // Only the prefix that changed is uploaded. Without this every kind would
      // push its whole 180-instance buffer every frame, which is 57 KB of
      // matrices per frame to draw three sparks.
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) {
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, n * 3);
        mesh.instanceColor.needsUpdate = true;
      }
    }
    statsOut.activeKinds = active;
  }

  /** Art §6's two attached lights, refreshed from the board every frame. */
  function attachedLights(state: GameState): void {
    const item = state.powerup;
    if (item !== null) {
      lightPool.setPulsePhase(powerupMs);
      lightPool.acquire(
        'powerupPulse',
        item.x + 8,
        POWERUP_LIGHT_Y,
        item.y + 8,
        1,
        0.78,
        0.35,
        false,
      );
    }
    if (!BULLET_GLOW_QUALITY[quality]) return;
    const bullets = state.bullets;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b.alive) continue;
      if (
        lightPool.acquire(
          'bulletGlow',
          b.x + 2,
          BULLET_LIGHT_Y,
          b.y + 2,
          1,
          0.84,
          0.42,
          false,
        ) === null
      ) {
        return; // pool full of things that matter more — art §6's priority rule
      }
    }
  }

  const sink: FxSink = {
    begin(kind: FxKind, priority: number): FxSpawn {
      return pool.begin(kind, priority);
    },
    emit(): void {
      pool.emit();
    },
    light(kind, x, y, z, r, g, b): void {
      lightPool.acquire(kind, x, y, z, r, g, b, true);
    },
    screenFlash(ms: number, strength: number): void {
      // Art §11: "`prefers-reduced-motion` or settings toggle: … no screen
      // flash". Every particle the same recipe emits still spawns — the
      // information is preserved, only the full-frame blast is not.
      if (currentFlags.reducedMotion || currentFlags.reducedFlash) return;
      flashMs = 0;
      flashDurMs = Math.max(1, ms);
      flashStrength = strength;
    },
    rand(i: number): number {
      return hash01(randSeed, i);
    },
    seed(value: number): void {
      randSeed = value >>> 0;
    },
    hasTank(id: number): boolean {
      return id >= 0 && id < TANK_ID_SPACE && tankSeen[id] === 1;
    },
    tankX(id: number): number {
      return tankX[id];
    },
    tankZ(id: number): number {
      return tankZ[id];
    },
    tankDir(id: number): number {
      return tankDir[id];
    },
  };

  return {
    ...sink,

    update(state: GameState, dtMs: number): void {
      const dt = animDtOf(state, dtMs);

      // Positions first: an event pumped later this frame reads them, and an
      // event pumped *before* this call read last frame's — at most one tick
      // stale, i.e. under 4 u for the fastest tank.
      tankSeen.fill(0);
      const tanks = state.tanks;
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (!tank.alive || tank.id < 0 || tank.id >= TANK_ID_SPACE) continue;
        tankX[tank.id] = tank.x + 8;
        tankZ[tank.id] = tank.y + 8;
        tankDir[tank.id] = tank.dir;
        tankSeen[tank.id] = 1;
      }

      // The power-up's bob phase, re-armed exactly as `propView.ts` re-arms its
      // own, so the light and the bob cannot drift apart (its header says so).
      if (state.powerup === null) {
        powerupMs = 0;
        powerupArmed = false;
      } else {
        if (!powerupArmed) {
          powerupMs = 0;
          powerupArmed = true;
        }
        powerupMs += dt;
      }

      // The eagle's wisps. `state.eagleAlive` is read only to *disarm* — a new
      // stage puts the bird back — while arming is the event's job.
      if (state.eagleAlive) {
        wispsArmed = false;
      } else if (wispsArmed) {
        wispT += dt;
        while (wispT >= WISP_INTERVAL_MS) {
          wispT -= WISP_INTERVAL_MS;
          frame++;
          sink.seed(frame * 2654435761);
          const p = pool.begin('smoke', WISP_PRIORITY);
          p.x = wispX + (sink.rand(0) - 0.5) * 7;
          p.y = WISP_Y;
          p.z = wispZ + (sink.rand(1) - 0.5) * 7;
          p.vy = 9 + sink.rand(2) * 6;
          p.vx = (sink.rand(3) - 0.5) * 4;
          p.vz = (sink.rand(4) - 0.5) * 4;
          p.lifeMs = 1600;
          p.size0 = 3;
          p.size1 = 10;
          p.r = SMOKE_RGB[0];
          p.g = SMOKE_RGB[1];
          p.b = SMOKE_RGB[2];
          pool.emit();
        }
      }

      pool.advance(dt);
      lightPool.advance(dt);
      attachedLights(state);
      writeParticles();

      if (flashMs >= 0) {
        flashMs += dt;
        const t = flashMs / flashDurMs;
        if (t >= 1) {
          flashMs = -1;
          screen.visible = false;
        } else {
          screen.visible = true;
          materials.fxScreenFlash.opacity = flashStrength * (1 - t) ** 2;
          // The frustum moves with the viewport, so the quad is re-fitted here
          // rather than on resize: it is two multiplications on the frames it
          // is actually visible, against a resize hook that could go stale.
          const camera = sceneRoot.camera;
          screen.position.set(0, 0, -(camera.near + 1));
          screen.scale.set(
            (camera.right - camera.left) / 2,
            (camera.top - camera.bottom) / 2,
            1,
          );
        }
      }

      statsOut.particles = pool.count;
      statsOut.lights = lightPool.count;
    },

    onEvent(e: GameEvent): void {
      if (e.t === 'baseDestroyed') {
        wispsArmed = true;
        wispT = WISP_INTERVAL_MS; // first wisp on the next frame, not in 420 ms
        wispX = EAGLE_FX_X;
        wispZ = EAGLE_FX_Z;
      } else if (e.t === 'powerupSpawned' || e.t === 'powerupCollected') {
        powerupArmed = false;
      }
      sink.seed(seedOf(e));
      applyRecipe(sink, e);
    },

    setQuality(q: Quality): void {
      if (q === quality) return;
      const before = LIGHT_CAP[quality];
      quality = q;
      pool.setCap(PARTICLE_CAP[q]);
      lightPool.setCap(LIGHT_CAP[q]);
      // Resident count, not just budget: see LIGHT_CAP's note. three sees the
      // change through `lights.state.version` and recompiles by itself.
      const after = LIGHT_CAP[q];
      if (after < before) {
        for (let i = after; i < before; i++) {
          sceneRoot.scene.remove(lightPool.lights[i]);
        }
      } else if (after > before) {
        for (let i = before; i < after; i++) {
          sceneRoot.scene.add(lightPool.lights[i]);
        }
      }
    },

    setFlags(next: FxFlags): void {
      currentFlags = next;
      if (next.reducedMotion || next.reducedFlash) {
        flashMs = -1;
        screen.visible = false;
      }
    },

    stats(): FxStats {
      return statsOut;
    },

    dispose(): void {
      group.removeFromParent();
      screen.removeFromParent();
      screen.geometry.dispose();
      for (const kind of FX_KINDS) {
        meshes[kind].dispose();
      }
      for (const light of lightPool.lights) {
        light.removeFromParent();
        light.dispose();
      }
      boxGeo.dispose();
      smokeGeo.dispose();
      flashGeo.dispose();
      ringGeo.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// --- Constants the view and the recipes share ------------------------------
// ---------------------------------------------------------------------------

/** Art §9's power-up hovers 2.5 u up and bobs ±2; the light sits mid-swing. */
const POWERUP_LIGHT_Y = 8;
/** Bullets are 4 u; their glow sits at the capsule's own height. */
const BULLET_LIGHT_Y = 5;
/** The eagle's tile centre — a constant of the board, not a state read. */
const EAGLE_FX_X = 6 * 16 + 8;
const EAGLE_FX_Z = 12 * 16 + 8;
/** Wisps are scenery; anything the player is looking at outranks them. */
const WISP_PRIORITY = 5;

/**
 * Linear RGB of the `smoke` token, resolved once. The wisp emitter lives in
 * this file rather than in a recipe (it is continuous, not event-shaped), so it
 * needs the one colour recipes.ts would otherwise own.
 */
const SMOKE_RGB: readonly number[] = (() => {
  const c = new Color(PALETTE.smoke);
  return Object.freeze([c.r, c.g, c.b]);
})();

// ---------------------------------------------------------------------------
// --- Geometry --------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * The particle box: a plain unit cube, positions and normals only.
 *
 * Deliberately **not** `createPartGeometry()`'s beveled box, which is 48
 * triangles: at 180 live particles that is 8 640 triangles of chamfer nobody
 * can see on a 2 u chunk. 12 triangles is the same silhouette at this size.
 */
function createFxBoxGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const h = 0.5;
  const push = (ax: number, s: number): void => {
    // The face on axis `ax` at sign `s`, as two triangles wound outwards.
    const o1 = (ax + 1) % 3;
    const o2 = (ax + 2) % 3;
    const corner = (u: number, v: number): number[] => {
      const p = [0, 0, 0];
      p[ax] = s * h;
      p[o1] = u * h;
      p[o2] = v * h;
      return p;
    };
    const quad =
      s > 0
        ? [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
        : [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
    for (const [a, b, c] of [
      [quad[0], quad[1], quad[2]],
      [quad[0], quad[2], quad[3]],
    ]) {
      for (const v of [a, b, c]) {
        pos.push(v[0], v[1], v[2]);
        const n = [0, 0, 0];
        n[ax] = s;
        nrm.push(n[0], n[1], n[2]);
      }
    }
  };
  for (let ax = 0; ax < 3; ax++) {
    push(ax, 1);
    push(ax, -1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  return geo;
}

/** Segments around the ring and the flare. 36 is smooth at 170 u across. */
const RADIAL_SEGMENTS = 36;
/** The shockwave band: inner edge, bright core and outer edge, as radii. */
const RING_BAND: readonly number[] = Object.freeze([0.3, 0.4, 0.5]);

/**
 * A flat shockwave band of outer **diameter 1**, lying in the XZ plane with its
 * normal up, and **carrying its own falloff in vertex colours**: 0 at both
 * edges, 1 along the bright core.
 *
 * Both halves of that matter. Flat, because every ring art §8 asks for — the
 * tank explosion's ground ring, the base's double shockwave, the spawn rings,
 * the stun ring — lies on the board, so drawing one is a scale rather than an
 * orientation. And soft, because an additive surface with no texture and no
 * lighting is otherwise a **hard-edged solid band**: the first capture of this
 * task rendered exactly that and it read as a UI element drawn over the board
 * rather than as energy moving through it. Vertex colours are the whole fix,
 * they cost nothing, and `instanceColor` still multiplies on top so a recipe's
 * own colour and the kind's fade both survive (`color_vertex.glsl` applies
 * `color` and `instanceColor` in turn).
 */
function createRingGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const [inner, core, outer] = RING_BAND;
  const push = (r: number, a: number, k: number): void => {
    pos.push(r * Math.cos(a), 0, r * Math.sin(a));
    nrm.push(0, 1, 0);
    col.push(k, k, k);
  };
  for (let i = 0; i < RADIAL_SEGMENTS; i++) {
    const a0 = (i / RADIAL_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RADIAL_SEGMENTS) * Math.PI * 2;
    // Two quads per segment: inner edge → core, core → outer edge.
    //
    // **Wound to face +y**, which is not a detail: angle increases from +x
    // toward +z, so the "obvious" order (lo·a0, hi·a0, hi·a1) produces a normal
    // pointing DOWN and `FrontSide` culls the whole ring against this camera.
    // Every shockwave in art §8 was invisible for exactly that reason until a
    // screenshot showed the base exploding with no shockwave at all;
    // `tests/render/fxSystem.test.ts` now checks the winding, because a
    // declared `normal` attribute does not fix a wound-away triangle and
    // `MeshBasicMaterial` never reads it.
    for (const [lo, hi, klo, khi] of [
      [inner, core, 0, 1],
      [core, outer, 1, 0],
    ]) {
      push(lo, a0, klo);
      push(hi, a1, khi);
      push(hi, a0, khi);
      push(lo, a0, klo);
      push(lo, a1, klo);
      push(hi, a1, khi);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/**
 * The flash: a **camera-facing disc of diameter 1** whose vertex colours run 1
 * at the centre to 0 at the rim — a soft glow, built out of geometry because
 * this project has no textures and would not add one for a flare.
 *
 * It replaced a low-poly sphere, and the reason is in
 * `.superpowers/sdd/screens-T4/`: an *unlit additive* icosahedron has no
 * shading and no falloff, so what art §8 calls a "flash sphere scale 1→2.2"
 * rendered as a flat gold **hexagon** two tiles wide sitting on the board. A
 * flash is light, and light has an edge you cannot see.
 *
 * Authored in the XZ plane like the ring, so the billboard is the constant
 * `Rx(BILLBOARD_X)` basis the rest of this layer already uses (models.ts) —
 * art §2 fixes the camera, so facing it is a rotation, not a `lookAt`.
 */
function createFlashGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const r = 0.5;
  for (let i = 0; i < RADIAL_SEGMENTS; i++) {
    const a0 = (i / RADIAL_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RADIAL_SEGMENTS) * Math.PI * 2;
    // Wound to face +y — see `createRingGeometry` for what the other winding
    // costs (a flare that is culled away and never appears).
    pos.push(0, 0, 0, r * Math.cos(a1), 0, r * Math.sin(a1), r * Math.cos(a0), 0, r * Math.sin(a0)); // prettier-ignore
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    // Hot core, nothing at the rim. The 1.6 exponent is applied per-vertex by
    // making the mid-ring implicit: a linear fan already reads as a soft blob
    // at this size, and adding a ring of intermediate vertices only sharpens a
    // gradient the bloom pass is about to smear anyway.
    col.push(1, 1, 1, 0, 0, 0, 0, 0, 0);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  return geo;
}

/** Where the screen flash starts to burn, as a fraction of the half-diagonal. */
const SCREEN_FLASH_INNER = 0.42;

/**
 * A 2×2 quad whose vertex colours are 0 at the centre and 1 in the corners —
 * art §8's "screen-**edge** flash". The falloff is baked into the mesh rather
 * than into a shader because it never changes and because a `MeshBasicMaterial`
 * with `vertexColors` is already in the render layer's vocabulary.
 *
 * 24×24 so the smoothstep reads as a gradient rather than as facets.
 */
function createScreenFlashGeometry(): BufferGeometry {
  const geo = new PlaneGeometry(2, 2, 24, 24);
  const position = geo.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    // 0 at the centre, 1 at a corner, at any aspect (the quad is square in
    // local space and scaled to the frustum afterwards).
    const r = Math.min(1, Math.hypot(x, y) / Math.SQRT2);
    const u = Math.max(
      0,
      Math.min(1, (r - SCREEN_FLASH_INNER) / (1 - SCREEN_FLASH_INNER)),
    );
    const k = u * u * (3 - 2 * u);
    colours[i * 3] = k;
    colours[i * 3 + 1] = k;
    colours[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return geo;
}
