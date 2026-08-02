// src/render/fx/fxSystem.ts — the pooled particle and dynamic-light machinery
// of art §8 and §6.
//
// ## What is here, and what is not (yet)
//
// This is **T4.1**: the pools, the eviction rule, the per-kind envelopes and
// art §6's light table. It is deliberately pure — no scene, no meshes, no
// `GameState` — which is why `tests/render/fxSystem.test.ts` can assert all of
// it in the Vitest node environment where there is neither DOM nor WebGL. It
// also means this file on its own draws nothing: T4.2 adds the view that turns
// these pools into `InstancedMesh`es and the recipe table that fills them.
//
// ## Five kinds, five draw calls — never 180
//
// Art §8 caps the field at ~180 live particles at High. Those 180 will be
// **five** `InstancedMesh`es, one per particle *kind*, and a kind is chosen by
// what a particle physically is rather than by which event spawned it:
//
// | kind | surface | what it is |
// |---|---|---|
// | `debris` | lit, opaque | brick chunks, metal shards, hull debris, emblem shards, leaves, skid marks |
// | `spark` | additive, bloomed | white-hot sparks, gold motes, frost motes |
// | `smoke` | lit, α 0.35 | dust puffs, explosion smoke, the base's column, the eagle's wisps |
// | `ring` | additive | ground rings, shockwaves, spawn rings, the stun ring |
// | `flash` | additive, bloomed | muzzle flash, explosion flash sphere |
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

import { PointLight } from 'three';

import type { Quality } from '../materials';

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
 * Art §6: "Dynamic point-light pool (max 8, priority by proximity/importance)";
 * art §7's Low row: "lights pool halved".
 *
 * The **resident** light count follows this, i.e. lights are removed from the
 * scene on Low rather than merely left dark: three compiles `NUM_POINT_LIGHTS`
 * into every program, so eight idle lights would still cost eight iterations of
 * the direct-lighting loop per fragment on the preset that can least afford it.
 * three notices the change through `lights.state.version` and recompiles by
 * itself, and a preset switch already pays for a recompile (`renderer.ts`).
 */
export const LIGHT_CAP: Readonly<Record<Quality, number>> = Object.freeze({
  high: 8,
  medium: 8,
  low: 4,
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
  readonly flags: Uint8Array;
  /** Dense list of occupied slots, `live[0 … count)`. */
  readonly live: Int32Array;
}

const FLAG_BOUNCE = 1;
const FLAG_FLAT = 2;
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
    light.visible = false;
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

  function release(i: number): void {
    spec[i] = null;
    lights[i].intensity = 0;
    lights[i].visible = false;
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
      light.visible = true;
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
 * Everything T4.2's recipes will be allowed to do. Deliberately narrow: a
 * recipe emits particles, asks for a light, asks for a screen flash and reads
 * the board position of a tank — it cannot see the pools, the meshes or the
 * scene.
 *
 * It lives here, with the pools, so `recipes.ts` can import it **type-only**
 * and the two files never form an import cycle.
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
