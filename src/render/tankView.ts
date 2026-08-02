// src/render/tankView.ts — the pooled tank views and every animation art §9
// asks for. Presentation only: it **reads** `GameState` and the event stream and
// writes to neither (arch §3.3).
//
// ## The two halves of this file
//
// Everything above `--- The view ---` is **pure**: the animation curves, the
// identity-keyed pool, and the per-entity state that rides in it. That is what
// `tests/render/models.test.ts` asserts in the Vitest node environment. Below it
// is the `InstancedMesh` plumbing, verified by the screenshot checklist.
//
// ## One InstancedMesh per type, one instance per PART
//
// Art §3.1 authors a token per tank type and art §3.0 requires each to be a
// material's own `color`, so six types are six materials — and a material is a
// draw call. The entity layer therefore instances **parts**: every box in
// `TANK_MODELS[type].parts` is one instance of the shared beveled unit box, and
// a type's whole population is one draw call however many tanks are on the
// field. That is what pays for art §9's *per-part* animation — the turret
// recoils while the tracks scroll while the hull vibrates — at no draw-call cost
// at all, and it is why per-part trim rides on `instanceColor` rather than on a
// second material.
//
// ## Identity, and the trap it exists for
//
// Slots inside an `InstancedMesh` compact on a death: kill the tank in slot 1 of
// four and slot 3's instances back-fill into it. **Nothing per-entity may be
// addressed by slot.** Track phase, recoil, hit flash and the armor HP tint live
// in `TankAnim` keyed by `Tank.id`; `SlotMap` (reused from `terrainView.ts`,
// where it is already tested) answers only "where do this tank's matrices go".
// The two are deliberately separate, and `models.test.ts` kills a mid-pool tank
// and checks that every survivor still holds its own phase.
//
// `Tank.id` alone is **not** identity, which is the second half of the same
// trap: `spawner.ts` recycles a dead enemy's array slot and keeps its id, so
// tank 2 can be a Basic, die, and come back as an Armor. The pool therefore
// keys on `(kind, playerIndex | spawnOrdinal)` and resets the animation state
// when that changes.

import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';

import { ENEMY_CAP, TANK_SIZE } from '../core/constants';
import type { GameEvent } from '../core/events';
import type { GameState, Tank } from '../core/types';
import type { Materials } from './materials';
import {
  ARMOR_HP_TINT,
  BILLBOARD_X,
  DANGER_TINT,
  DIR_YAW,
  TANK_MODELS,
  TANK_TYPES,
  TREAD_PITCH,
  TREAD_SPAN,
  WHITE_TINT,
  animDtOf,
  countRole,
  createPartGeometry,
  isOverlayRole,
  lerp,
  tankTypeOf,
  writePartMatrix,
  type ModelPart,
  type TankModel,
  type TankType,
} from './models';
import { BLOOM_LAYER } from './post';
import type { SceneRoot } from './sceneRoot';
import { createSlotMap, type SlotMap, type SlotMove } from './terrainView';

// ---------------------------------------------------------------------------
// --- Animation constants (art §9) ------------------------------------------
// ---------------------------------------------------------------------------

/** "Tracks: stepped scroll, **8 u per visual step**, rate ∝ speed." */
export const TRACK_STEP_U = 8;
/** "Turret recoil: **2 u** back, **80 ms** out-back ease per shot." */
export const RECOIL_U = 2;
export const RECOIL_MS = 80;
/** Fraction of the recoil window spent travelling out. See {@link recoilAt}. */
const RECOIL_STRIKE = 0.3;
/** "Turn: hull yaw snaps logically; visual eases **100 ms**…" */
export const YAW_EASE_MS = 100;
/** "…with a **2.5°** lean into the turn." */
export const LEAN_RAD = (2.5 * Math.PI) / 180;
/** "Engine idle: **0.3 u** vertical vibration @ **9 Hz** while moving." */
export const VIBRATION_U = 0.3;
export const VIBRATION_HZ = 9;
/** "Armor HP tint: crossfade **150 ms** on hit + white hit-flash **60 ms**." */
export const ARMOR_TINT_MS = 150;
export const HIT_FLASH_MS = 60;
/** "Carrier flash: emissive pulse **4 Hz square**" + art §11's +4% scale. */
export const CARRIER_HZ = 4;
export const CARRIER_SCALE = 0.04;
/** How far the carrier pulse pushes the tank towards `danger`. */
const CARRIER_MIX = 0.75;
/** Art §4: "spawn star … twinkle scale 1.3 s". */
export const SPAWN_TWINKLE_MS = 1300;
/** How much brighter than its token the spawn star burns (art §4: emissive). */
const STAR_BOOST = 1.7;
/** Shield shimmer rate, and how far it dips. */
const SHIELD_HZ = 8;
/** Art §8: "orbiting stars over the stunned tank." */
const STUN_RPS = 1.1;
const STUN_RADIUS = 6;

// ---------------------------------------------------------------------------
// --- Animation curves (pure) -----------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Which visual step a tank that has travelled `distance` is on.
 *
 * Driven by **distance**, not by a timer scaled by speed, so art §9's "rate ∝
 * speed" and "stationary = still" are structural rather than tuned — and an ice
 * slide, which moves a tank whose `moving` flag is false, still scrolls.
 */
export function trackStepOf(distance: number): number {
  return Math.floor(distance / TRACK_STEP_U);
}

/**
 * How far the rungs are shifted on step `step`. Two frames, alternating by half
 * the rung pitch: that is what makes the scroll read as art §9's *stepped* one
 * rather than as a slide, and it is the NES original's two-frame track.
 */
export function treadShiftOf(step: number): number {
  return (step & 1) === 0 ? 0 : TREAD_PITCH / 2;
}

/**
 * Brings a shifted rung back inside the track. Without it the rearmost rung
 * walks off the back of the track block every other step.
 */
export function wrapTread(z: number, span: number): number {
  const half = span / 2;
  return ((((z + half) % span) + span) % span) - half;
}

/**
 * Art §9's "2 u back, 80 ms **out-back** ease". A fast strike out over the first
 * 30% of the window and an eased cubic return over the remaining 70% — the
 * asymmetry is what makes it read as a shot rather than as a wobble. Exactly 0
 * at both ends, so a recoil that has expired leaves the turret where it was.
 */
export function recoilAt(ms: number): number {
  if (ms <= 0 || ms >= RECOIL_MS) return 0;
  const t = ms / RECOIL_MS;
  if (t <= RECOIL_STRIKE) return RECOIL_U * (t / RECOIL_STRIKE);
  const u = (t - RECOIL_STRIKE) / (1 - RECOIL_STRIKE);
  return RECOIL_U * (1 - u) ** 3;
}

/** Art §9's white hit-flash: full at the hit, linear to nothing at 60 ms. */
export function hitFlashAt(ms: number): number {
  if (ms < 0 || ms >= HIT_FLASH_MS) return 0;
  return 1 - ms / HIT_FLASH_MS;
}

/** Art §9's 4 Hz **square** carrier pulse — 1 while on, 0 while off. */
export function carrierPulseAt(ms: number): number {
  const period = 1000 / CARRIER_HZ;
  return ms % period < period / 2 ? 1 : 0;
}

/**
 * Art §9's engine vibration. A raised cosine rather than a plain sine so the
 * tank never sinks *below* the board: the 0.3 u is spent entirely upwards.
 */
export function vibrationAt(ms: number): number {
  return (
    (VIBRATION_U / 2) * (1 - Math.cos((2 * Math.PI * VIBRATION_HZ * ms) / 1000))
  );
}

/** Art §4's "twinkle scale 1.3 s" on the spawn star. */
export function spawnTwinkleAt(ms: number): number {
  return 1 + 0.3 * Math.sin((4 * Math.PI * ms) / SPAWN_TWINKLE_MS);
}

/**
 * Which of fidelity §3.2's four tints an armor tank on `hp` wears. Clamped at
 * both ends: reading off the end of the table would be a black tank, and a
 * grenade or a mis-ordered event can hand us 0.
 */
export function armorTintIndex(hp: number): number {
  const n = ARMOR_HP_TINT.length;
  const clamped = Math.max(1, Math.min(n, Math.round(hp)));
  return n - clamped;
}

/** Signed shortest rotation from `from` to `to`, in (−π, π]. */
export function shortestAngle(from: number, to: number): number {
  const tau = 2 * Math.PI;
  let d = (to - from) % tau;
  if (d > Math.PI) d -= tau;
  if (d < -Math.PI) d += tau;
  return d;
}

// ---------------------------------------------------------------------------
// --- Per-entity animation state --------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Everything about a tank that the simulation does not hold, keyed by
 * `Tank.id`. **Never addressed by instance slot** — see the file header.
 */
export interface TankAnim {
  /**
   * The identity guard: `−1 − playerIndex` for a player, `spawnOrdinal` for an
   * enemy. Distinguishes a *new* tank in a recycled array slot from the one
   * that used to live there.
   */
  ordinal: number;
  /** Ground travelled, in u. Drives the track step. */
  distance: number;
  lastX: number;
  lastY: number;
  hasLast: boolean;
  /** ms since the shot, or −1. */
  recoilMs: number;
  /** ms since the hit, or −1. */
  flashMs: number;
  /** ms this tank has been on the field; drives the free-running phases. */
  ageMs: number;
  /** Eased visual yaw, and the lean it is currently carrying. */
  yaw: number;
  lean: number;
  /** Last HP seen, so a change can start the crossfade. */
  hp: number;
  tintIndex: number;
  tintFromIndex: number;
  /** ms into the 150 ms armor crossfade, or −1. */
  tintFadeMs: number;
}

/**
 * How many distinct `Tank.id`s the view is prepared for.
 *
 * The core bounds `state.tanks` at 2 players + `ENEMY_CAP` and never compacts
 * it, so ids stay small and stable. 64 is headroom against a future cap change;
 * an id at or above it is skipped rather than read off the end of an
 * `Int32Array`, which returns `undefined` and fails silently (the exact trap
 * `createSlotMap`'s `keySpace` parameter was renamed for in T2.3).
 */
export const TANK_ID_SPACE = 64;

/** Whether an id off the event stream can index the state registry at all. */
function inIdSpace(id: number): boolean {
  return id >= 0 && id < TANK_ID_SPACE;
}

const NO_ORDINAL = Number.NaN;

function blankAnim(): TankAnim {
  return {
    ordinal: NO_ORDINAL,
    distance: 0,
    lastX: 0,
    lastY: 0,
    hasLast: false,
    recoilMs: -1,
    flashMs: -1,
    ageMs: 0,
    yaw: 0,
    lean: 0,
    hp: 1,
    tintIndex: 0,
    tintFromIndex: 0,
    tintFadeMs: -1,
  };
}

/** One `TankAnim` per possible id, allocated once. */
export function createAnimStates(): TankAnim[] {
  const out: TankAnim[] = [];
  for (let i = 0; i < TANK_ID_SPACE; i++) {
    out.push(blankAnim());
  }
  return out;
}

/** The identity a tank keeps for its whole life — see {@link TankAnim.ordinal}. */
export function identityOf(tank: Tank): number {
  return tank.kind === 'player'
    ? -1 - (tank.playerIndex ?? 0)
    : (tank.spawnOrdinal ?? 0);
}

/**
 * `Tank.id` → instance slot, plus the per-entity animation state that must
 * **not** follow a slot.
 *
 * `acquire` is idempotent and is called unconditionally every frame for every
 * live tank; it resets the animation state exactly when the identity behind an
 * id has changed.
 */
export interface TankPool {
  /** Live tanks — `mesh.count` is this times the model's part count. */
  readonly count: number;
  slotOf(id: number): number;
  keyAt(slot: number): number;
  state(id: number): TankAnim;
  acquire(tank: Tank): number;
  release(id: number): void;
  /** Force the next `acquire` to re-arm this tank (a respawn, art §9). */
  invalidate(id: number): void;
  clear(): void;
}

/**
 * @param states a registry shared with the other type pools, so an event that
 * knows only a `tankId` can reach the right state without first working out
 * which type's pool holds it. Defaults to a private one, which is what the unit
 * tests use.
 */
export function createTankPool(
  states: TankAnim[] = createAnimStates(),
): TankPool {
  const slots: SlotMap = createSlotMap(TANK_ID_SPACE);
  // `SlotMap.remove` reports through an out-param so a death allocates nothing;
  // the view rewrites every live matrix each frame, so the move itself needs no
  // follow-up here (unlike terrain, which only writes on damage).
  const move: SlotMove = { slot: 0, fromSlot: 0, key: 0 };

  function reset(s: TankAnim, tank: Tank, ordinal: number): void {
    s.ordinal = ordinal;
    s.distance = 0;
    s.lastX = 0;
    s.lastY = 0;
    s.hasLast = false;
    s.recoilMs = -1;
    s.flashMs = -1;
    s.ageMs = 0;
    s.yaw = DIR_YAW[tank.dir];
    s.lean = 0;
    s.hp = tank.hp;
    s.tintIndex = armorTintIndex(tank.hp);
    s.tintFromIndex = s.tintIndex;
    s.tintFadeMs = -1;
  }

  return {
    get count(): number {
      return slots.count;
    },
    slotOf(id: number): number {
      return slots.slotOf(id);
    },
    keyAt(slot: number): number {
      return slots.keyAt(slot);
    },
    state(id: number): TankAnim {
      return states[id];
    },
    acquire(tank: Tank): number {
      const s = states[tank.id];
      const ordinal = identityOf(tank);
      const slot = slots.slotOf(tank.id);
      if (slot !== -1) {
        // Same id, different tank — or an explicit `invalidate` after a
        // respawn. Either way the previous life's phases must not carry over.
        // `!==` and not `Object.is`: the NaN sentinel `invalidate` writes must
        // compare unequal to everything, and `Object.is(NaN, NaN)` is true.
        if (s.ordinal !== ordinal) reset(s, tank, ordinal);
        return slot;
      }
      reset(s, tank, ordinal);
      return slots.add(tank.id);
    },
    release(id: number): void {
      slots.remove(id, move);
    },
    invalidate(id: number): void {
      states[id].ordinal = NO_ORDINAL;
    },
    clear(): void {
      slots.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// --- The view --------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Slots reserved per type. Players are one each by construction (`tankTypeOf`
 * keys on `playerIndex`); every enemy on the field may be the same type, so
 * each enemy mesh is sized for the whole cap plus headroom. Exceeding it grows
 * the mesh rather than dropping a tank — an allocation on the one frame a cap
 * changes beats a tank that is simply not drawn.
 */
function slotsFor(type: TankType): number {
  return type === 'p1' || type === 'p2' ? 2 : ENEMY_CAP + 2;
}

interface TypeEntry {
  readonly model: TankModel;
  readonly pool: TankPool;
  readonly material: MeshStandardMaterial;
  mesh: InstancedMesh;
  slots: number;
}

/**
 * A mesh shared across every type, for the two roles art §8 rules must be
 * genuinely **emissive**: the spawn star and the tier-3 barrel tip.
 *
 * They cannot ride the tank's own mesh, and the reason is a three.js fact
 * rather than a preference: `emissive` is a material property, and
 * vertex/instance colour reaches `diffuseColor` only (`color_fragment.glsl`).
 * A star tinted per instance would be lit, not glowing — and once T2.5's bloom
 * lands, bullets would bloom while the star does not, which is the exact
 * inversion of art §4. Both roles are one colour across the whole field, so one
 * shared material each covers it: +2 draw calls, and only while something is
 * actually spawning or somebody is at tier 3 (an `InstancedMesh` with
 * `count === 0` draws nothing at all).
 */
interface SharedMesh {
  mesh: InstancedMesh;
  readonly material: MeshStandardMaterial;
  capacity: number;
  /** Instances written so far this frame. */
  used: number;
}

export interface TankView {
  /**
   * One frame. `alpha` is the loop's interpolation factor, exactly 1 paused.
   * `dtMs` is the loop's real frame time — including on a paused frame, which
   * is its contract — and is zeroed here by {@link animDtOf}, because a frozen
   * field must not keep scrolling its tracks.
   */
  update(state: GameState, alpha: number, dtMs: number): void;
  /** Recoil, hit flash and respawn re-arming. Ignores everything else. */
  onEvent(e: GameEvent): void;
  dispose(): void;
}

export function createTankView(
  materials: Materials,
  sceneRoot: SceneRoot,
): TankView {
  const group = new Group();
  sceneRoot.entities.add(group);

  const geometry: BufferGeometry = createPartGeometry();
  // One registry for every type, so `onEvent` can reach a tank's state from its
  // id alone — the pools differ, the identities do not.
  const states = createAnimStates();

  /** Parts per tank that each shared mesh may have to draw. */
  const STAR_PARTS = Math.max(
    ...TANK_TYPES.map((t) => countRole(TANK_MODELS[t], 'star')),
  );
  const TIP_PARTS = Math.max(
    ...TANK_TYPES.map((t) => countRole(TANK_MODELS[t], 'tip')),
  );

  const entries = {} as Record<TankType, TypeEntry>;
  for (const type of TANK_TYPES) {
    const model = TANK_MODELS[type];
    const material = materials[model.material];
    const slots = slotsFor(type);
    entries[type] = {
      model,
      material,
      pool: createTankPool(states),
      mesh: makeInstanced(geometry, material, slots * model.parts.length),
      slots,
    };
    group.add(entries[type].mesh);
  }

  const shared: Record<'star' | 'tip', SharedMesh> = {
    star: makeShared(materials.spawnStar, (2 + ENEMY_CAP) * STAR_PARTS),
    tip: makeShared(materials.tierTip, 2 * TIP_PARTS),
  };
  group.add(shared.star.mesh, shared.tip.mesh);

  function makeShared(
    material: MeshStandardMaterial,
    capacity: number,
  ): SharedMesh {
    const mesh = makeInstanced(geometry, material, Math.max(1, capacity));
    // Emissive overlays: a glow casting a shadow is simply wrong, and it would
    // cost a shadow-map draw for a surface the light does not fall on.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // …and these two meshes, alone in the whole scene, are what art §7's bloom
    // is for (art §8's emissive ruling, 2026-08-02: one shared emissive material
    // each for the spawn star and the tier-3 tip). `enable` rather than `set`:
    // the mesh stays on layer 0 so the beauty pass still draws it, and gains a
    // second layer that only the bloom source pass renders. The carrier pulse
    // is deliberately absent — it is a per-instance diffuse tint, not emissive.
    mesh.layers.enable(BLOOM_LAYER);
    return { mesh, material, capacity: Math.max(1, capacity), used: 0 };
  }

  function growShared(entry: SharedMesh, wanted: number): void {
    if (wanted <= entry.capacity) return;
    const capacity = Math.max(wanted, entry.capacity * 2);
    const next = makeInstanced(geometry, entry.material, capacity);
    next.castShadow = false;
    next.receiveShadow = false;
    // The replacement inherits the bloom layer; a grown pool that stopped
    // glowing would be a bug nothing but a screenshot could catch.
    next.layers.enable(BLOOM_LAYER);
    group.remove(entry.mesh);
    entry.mesh.dispose();
    group.add(next);
    entry.mesh = next;
    entry.capacity = capacity;
  }

  /**
   * Which type's pool currently holds each id. Without it a tank that is
   * recycled from Basic into Armor is acquired by the armor pool and never
   * released by the basic one — a slot that leaks and an instance that is drawn
   * forever at a dead tank's last position.
   */
  const homeType: (TankType | null)[] = new Array<TankType | null>(
    TANK_ID_SPACE,
  ).fill(null);

  // Scratch, reused for the life of the view: the frame path allocates nothing.
  const bodyR = new Float64Array(9);
  const flatR = new Float64Array(9);
  const colour = new Color();
  const tint: [number, number, number] = [1, 1, 1];

  // The billboard basis is constant — art §2 fixes the camera — so it is built
  // once rather than per star per frame.
  {
    const c = Math.cos(BILLBOARD_X);
    const s = Math.sin(BILLBOARD_X);
    flatR[0] = 1;
    flatR[4] = c;
    flatR[7] = s;
    flatR[5] = -s;
    flatR[8] = c;
  }

  function setBodyBasis(yaw: number, lean: number): void {
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    const cb = Math.cos(lean);
    const sb = Math.sin(lean);
    // Ry(yaw) · Rz(lean), row-major: yaw turns the hull, lean banks it into the
    // turn about its own forward axis.
    bodyR[0] = ca * cb;
    bodyR[1] = -ca * sb;
    bodyR[2] = sa;
    bodyR[3] = sb;
    bodyR[4] = cb;
    bodyR[5] = 0;
    bodyR[6] = -sa * cb;
    bodyR[7] = sa * sb;
    bodyR[8] = ca;
  }

  /** {@link writePartMatrix}, which `propView.ts` shares — see its header. */
  const writePart = writePartMatrix;

  function ensureCapacity(entry: TypeEntry, wanted: number): void {
    if (wanted <= entry.slots) return;
    const slots = Math.max(wanted, entry.slots * 2);
    const next = makeInstanced(
      geometry,
      entry.material,
      slots * entry.model.parts.length,
    );
    group.remove(entry.mesh);
    entry.mesh.dispose();
    group.add(next);
    entry.mesh = next;
    entry.slots = slots;
  }

  function releaseId(id: number): void {
    if (id < 0 || id >= TANK_ID_SPACE) return;
    const type = homeType[id];
    if (type === null) return;
    entries[type].pool.release(id);
    homeType[id] = null;
  }

  /** Advances every free-running and one-shot timer this tank owns. */
  function advance(s: TankAnim, tank: Tank, dtMs: number): void {
    s.ageMs += dtMs;
    if (s.recoilMs >= 0) {
      s.recoilMs += dtMs;
      if (s.recoilMs >= RECOIL_MS) s.recoilMs = -1;
    }
    if (s.flashMs >= 0) {
      s.flashMs += dtMs;
      if (s.flashMs >= HIT_FLASH_MS) s.flashMs = -1;
    }
    if (s.hp !== tank.hp) {
      s.hp = tank.hp;
      s.tintFromIndex = s.tintIndex;
      s.tintIndex = armorTintIndex(tank.hp);
      s.tintFadeMs = 0;
    }
    // Armed and advanced in the same pass, deliberately: a crossfade started on
    // this frame has to move on this frame too, or a `dtMs` longer than the
    // whole 150 ms window would leave the tint stuck at its starting value.
    if (s.tintFadeMs >= 0) {
      s.tintFadeMs += dtMs;
      if (s.tintFadeMs >= ARMOR_TINT_MS) s.tintFadeMs = -1;
    }
  }

  function syncTank(
    entry: TypeEntry,
    tank: Tank,
    alpha: number,
    dtMs: number,
  ): void {
    const model = entry.model;
    const parts = model.parts;
    const s = entry.pool.state(tank.id);
    const slot = entry.pool.slotOf(tank.id);
    // The caller acquires before it syncs, so this cannot be −1 — but a typed
    // array swallows an out-of-range write silently, so an unguarded negative
    // base would corrupt slot 0's matrices with no symptom but a wrong picture.
    if (slot < 0) return;
    const base = slot * parts.length;
    const mesh = entry.mesh;

    advance(s, tank, dtMs);

    const cx = lerp(tank.prevX, tank.x, alpha) + TANK_SIZE / 2;
    const cz = lerp(tank.prevY, tank.y, alpha) + TANK_SIZE / 2;
    if (s.hasLast) {
      const moved = Math.hypot(cx - s.lastX, cz - s.lastY);
      // A respawn is a teleport, not travel: the core re-anchors prevX/prevY,
      // but a wrapped-around stage change would otherwise add half the board to
      // the track phase in one frame.
      if (moved < TANK_SIZE) s.distance += moved;
    }
    s.lastX = cx;
    s.lastY = cz;
    s.hasLast = true;

    // Art §9's 100 ms turn ease, with the lean proportional to how much of the
    // turn is left — so it peaks at the snap and unwinds as the hull catches up.
    const target = DIR_YAW[tank.dir];
    s.yaw += shortestAngle(s.yaw, target) * Math.min(1, dtMs / YAW_EASE_MS);
    const remaining = shortestAngle(s.yaw, target);
    s.lean = LEAN_RAD * Math.max(-1, Math.min(1, remaining / (Math.PI / 2)));
    setBodyBasis(s.yaw, s.lean);

    const cy = tank.moving ? vibrationAt(s.ageMs) : 0;
    const spawning = tank.spawningT > 0;
    const recoil = recoilAt(s.recoilMs);
    const treadShift = treadShiftOf(trackStepOf(s.distance));
    const flash = hitFlashAt(s.flashMs);
    const white = WHITE_TINT[model.type];
    const carrier =
      tank.carrier === true ? carrierPulseAt(s.ageMs) * CARRIER_MIX : 0;
    const danger = DANGER_TINT[model.type];
    const bodyScale = 1 + (carrier > 0 ? CARRIER_SCALE : 0);
    const twinkle = spawnTwinkleAt(s.ageMs);

    // The armor plates' crossfade (art §9), resolved once per tank rather than
    // once per plate.
    const fade =
      s.tintFadeMs >= 0 ? Math.min(1, s.tintFadeMs / ARMOR_TINT_MS) : 1;
    const from = ARMOR_HP_TINT[s.tintFromIndex];
    const to = ARMOR_HP_TINT[s.tintIndex];

    for (let i = 0; i < parts.length; i++) {
      const p: ModelPart = parts[i];
      let px = p.x;
      let py = p.y;
      let pz = p.z;
      let sw = p.w;
      let sh = p.h;
      let sd = p.d;
      let basis = bodyR;
      let visible = true;
      tint[0] = p.tint[0];
      tint[1] = p.tint[1];
      tint[2] = p.tint[2];

      if (spawning) {
        // Mid-spawn the tank is intangible (`spawningT > 0` short-circuits the
        // core's movement, fire and collision), so it is not drawn at all —
        // art §4's star billboard stands in for it.
        visible = p.role === 'star';
        if (visible) {
          basis = flatR;
          sw *= twinkle;
          sd *= twinkle;
          tint[0] *= STAR_BOOST;
          tint[1] *= STAR_BOOST;
          tint[2] *= STAR_BOOST;
        }
      } else {
        switch (p.role) {
          case 'star':
            visible = false;
            break;
          case 'tread':
            pz = wrapTread(p.z + treadShift, TREAD_SPAN);
            break;
          case 'ring':
          case 'tip':
            visible = tank.tier >= (p.tier ?? 0);
            break;
          case 'plate': {
            const idx = p.index ?? 0;
            for (let c = 0; c < 3; c++) {
              tint[c] *= from[c] + (to[c] - from[c]) * fade;
            }
            // The topmost plate leads the crossfade slightly, so a hit reads as
            // damage travelling down the stack rather than as a flat recolour.
            if (idx === 2) {
              for (let c = 0; c < 3; c++) {
                tint[c] *= 1.04;
              }
            }
            break;
          }
          case 'shield': {
            visible = tank.shieldT > 0;
            // Art §9 has no shield row; the shimmer is a brightness+scale pulse
            // on a frame of the tank's own material, which costs no draw call.
            const on = ((s.ageMs * SHIELD_HZ) / 1000) % 1 < 0.5;
            const k = on ? 1.25 : 0.55;
            for (let c = 0; c < 3; c++) {
              tint[c] *= k;
            }
            sh *= on ? 1.15 : 0.9;
            break;
          }
          case 'stun': {
            visible = tank.stunT > 0;
            const a =
              (s.ageMs / 1000) * STUN_RPS * 2 * Math.PI +
              ((p.index ?? 0) * 2 * Math.PI) / 3;
            px = Math.cos(a) * STUN_RADIUS;
            pz = Math.sin(a) * STUN_RADIUS;
            break;
          }
          default:
            break;
        }
        if (p.recoil === true) pz += recoil;
        if (bodyScale !== 1 && !isOverlayRole(p.role)) {
          // Art §11: the carrier flash also modulates scale +4% for
          // colourblind visibility — a uniform swell of the whole body,
          // positions included, not just fatter parts.
          px *= bodyScale;
          py *= bodyScale;
          pz *= bodyScale;
          sw *= bodyScale;
          sh *= bodyScale;
          sd *= bodyScale;
        }
      }

      // Art §8's two emissive roles are drawn from a shared mesh, so their slot
      // in the tank's own mesh is always collapsed. Writing it (rather than
      // skipping it) keeps `base + i` a pure function of the part index, which
      // is what makes a mid-pool death cheap.
      const emissive =
        p.role === 'star' ? shared.star : p.role === 'tip' ? shared.tip : null;
      if (emissive !== null) {
        writePart(mesh, base + i, basis, cx, cy, cz, px, py, pz, 0, 0, 0);
        colour.r = 1;
        colour.g = 1;
        colour.b = 1;
        mesh.setColorAt(base + i, colour);
        if (visible && emissive.used < emissive.capacity) {
          writePart(
            emissive.mesh,
            emissive.used++,
            basis,
            cx,
            cy,
            cz,
            px,
            py,
            pz,
            sw,
            sh,
            sd,
          );
        }
        continue;
      }

      if (!visible) {
        sw = 0;
        sh = 0;
        sd = 0;
      }

      writePart(mesh, base + i, basis, cx, cy, cz, px, py, pz, sw, sh, sd);

      if (carrier > 0) {
        for (let c = 0; c < 3; c++) {
          tint[c] += (danger[c] - tint[c]) * carrier;
        }
      }
      if (flash > 0) {
        for (let c = 0; c < 3; c++) {
          tint[c] += (white[c] - tint[c]) * flash;
        }
      }
      colour.r = tint[0];
      colour.g = tint[1];
      colour.b = tint[2];
      mesh.setColorAt(base + i, colour);
    }
  }

  return {
    update(state: GameState, alpha: number, dtMs: number): void {
      // A paused field is a still picture (T3.3). `alpha` is untouched — it is
      // exactly 1 through the pause by contract, and clamping it is the bug the
      // loop's own comment warns about.
      dtMs = animDtOf(state, dtMs);
      const tanks = state.tanks;
      // Three passes, deliberately. Acquiring and growing must both finish
      // before ANY matrix is written: `ensureCapacity` replaces the mesh, and a
      // tank synced into the old buffer would vanish for a frame.
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (tank.id < 0 || tank.id >= TANK_ID_SPACE) continue;
        if (!tank.alive) {
          releaseId(tank.id);
          continue;
        }
        const type = tankTypeOf(tank);
        const home = homeType[tank.id];
        if (home !== null && home !== type) releaseId(tank.id);
        homeType[tank.id] = type;
        entries[type].pool.acquire(tank);
      }

      for (const type of TANK_TYPES) {
        ensureCapacity(entries[type], entries[type].pool.count);
      }

      // Sized from what this frame will actually draw, before a single matrix
      // is written — growing a mesh mid-pass would lose the instances already
      // in it, exactly as it would for a type mesh.
      let starWanted = 0;
      let tipWanted = 0;
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (!tank.alive || !inIdSpace(tank.id)) continue;
        if (tank.spawningT > 0) {
          starWanted += countRole(TANK_MODELS[tankTypeOf(tank)], 'star');
        } else if (tank.tier >= 3) {
          tipWanted += countRole(TANK_MODELS[tankTypeOf(tank)], 'tip');
        }
      }
      growShared(shared.star, starWanted);
      growShared(shared.tip, tipWanted);
      shared.star.used = 0;
      shared.tip.used = 0;

      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (!tank.alive || tank.id < 0 || tank.id >= TANK_ID_SPACE) continue;
        const type = homeType[tank.id];
        if (type === null) continue;
        syncTank(entries[type], tank, alpha, dtMs);
      }

      for (const type of TANK_TYPES) {
        const entry = entries[type];
        const mesh = entry.mesh;
        mesh.count = entry.pool.count * entry.model.parts.length;
        if (mesh.count === 0) continue;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      }

      for (const key of ['star', 'tip'] as const) {
        const entry = shared[key];
        entry.mesh.count = entry.used;
        if (entry.used > 0) entry.mesh.instanceMatrix.needsUpdate = true;
      }
    },

    onEvent(e: GameEvent): void {
      switch (e.t) {
        case 'shotFired':
          if (inIdSpace(e.tankId)) states[e.tankId].recoilMs = 0;
          break;
        case 'tankHit':
          if (inIdSpace(e.tankId)) states[e.tankId].flashMs = 0;
          break;
        case 'tankDestroyed':
          releaseId(e.tankId);
          break;
        case 'enemySpawned':
          // Re-arm rather than reset here: the tank's own fields (dir, hp) are
          // read at `acquire` time, and this event can arrive before the view
          // has ever seen it.
          if (inIdSpace(e.tankId)) states[e.tankId].ordinal = NO_ORDINAL;
          break;
        case 'playerSpawned':
          // A player tank's id IS its player index, forever — `players.ts`
          // allocates the two slots up front and never moves them. Pinned by
          // `models.test.ts`, because a respawned player silently inheriting
          // its previous life's track phase is the failure mode if it drifts.
          states[e.playerIndex].ordinal = NO_ORDINAL;
          break;
        default:
          break;
      }
    },

    dispose(): void {
      group.removeFromParent();
      for (const type of TANK_TYPES) {
        entries[type].mesh.dispose();
      }
      shared.star.mesh.dispose();
      shared.tip.mesh.dispose();
      geometry.dispose();
    },
  };
}

function makeInstanced(
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  capacity: number,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  // Every matrix is rewritten every frame — the default STATIC_DRAW hint would
  // make each upload a buffer re-allocation.
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // An InstancedMesh's bounding sphere comes from its GEOMETRY, which here is a
  // unit box at the origin. Left on, three would cull every tank on the board.
  mesh.frustumCulled = false;
  return mesh;
}
