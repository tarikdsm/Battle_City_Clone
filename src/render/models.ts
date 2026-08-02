// src/render/models.ts — the procedural tank and bullet geometry of art §4.
//
// ## Everything here is pure data
//
// A tank is **a list of boxes**, and this file is that list. No `Object3D`, no
// scene, no per-frame state: `tests/render/models.test.ts` asserts the art §4
// silhouette recipes straight off these tables in the Vitest node environment,
// and `tankView.ts` is what turns them into instance matrices.
//
// ## Why one shared primitive, scaled
//
// Six tank skins are six materials (art §3.1 authors a token each), and a
// material is a draw call. The whole entity layer therefore has to fit inside
// arch §11's budget with **one `InstancedMesh` per type** — and the instances
// are *parts*, not tanks. That is what buys independent per-part animation
// (track scroll, turret recoil) at no extra draw calls: every part is one
// instance of {@link createPartGeometry}'s beveled unit box, scaled and placed
// by its own matrix, and coloured by its own `instanceColor`.
//
// Two consequences worth knowing before editing:
//
// - **Every part is an axis-aligned box.** Art §4 says "cylinder/box" for the
//   turret and "cylinder" for the barrel; a chamfered box is the low-poly
//   reading of that, and it is what art §1's "low-poly, beveled, slightly
//   chunky pieces" asks for anyway. A second primitive would be a second
//   `InstancedMesh` per type, i.e. six more draw calls.
// - **The bevel is proportional, not absolute.** The unit box is chamfered by
//   {@link PART_BEVEL} and then scaled, so a 16 u track gets a ~1 u bevel and a
//   1.8 u barrel gets ~0.1 u. That reads correctly (big pieces look chunkier)
//   but it does mean the bevel is not one width across the model.
//
// ## Colour
//
// `material.color` is the authored §3.1 token and **nothing else** (art §3.0;
// `scripts/calibrate-lighting.ts` reads it). Per-part trim is a *ratio* against
// that token in `ModelPart.tint`, applied through `instanceColor` — the same
// mechanism `terrainView.ts` uses for mortar and rivets, delivered per instance
// instead of per vertex. See {@link faceTint}.

import {
  BufferGeometry,
  CapsuleGeometry,
  Float32BufferAttribute,
  type InstancedMesh,
} from 'three';

import { ARMOR_HP, BULLET_SIZE, TANK_SIZE, TILE } from '../core/constants';
import type { GameState, PowerupType, Tank } from '../core/types';
import {
  PALETTE,
  faceTint,
  type PaletteKey,
  type TankMaterialKey,
} from './materials';
import { PITCH_TAN } from './sceneRoot';

// ---------------------------------------------------------------------------
// --- Shared presentation constants -----------------------------------------
// ---------------------------------------------------------------------------

/**
 * Yaw, in radians, that turns a model's **−z** face towards `Dir` 0…3
 * (Up/Right/Down/Left). Local −z is forward for every entity in this layer, so
 * a part's `z` is "how far back from the muzzle" and a recoil is +z.
 */
export const DIR_YAW: readonly number[] = [
  0,
  -Math.PI / 2,
  Math.PI,
  Math.PI / 2,
];

/**
 * `alpha` reaches **exactly 1** on every paused frame (T2.1's loop contract), so
 * the endpoint has to be exact: `a + (b − a) · t` is not, and would leave every
 * entity a rounding error away from its true position for the whole pause. This
 * form returns `b` bit-exactly at t = 1 and `a` at t = 0.
 */
export function lerp(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

/**
 * The frame time a **presentation** animation may advance by.
 *
 * The loop hands the renderer a real `dtMs` even on a paused frame — that is
 * its contract (T2.1), and overlays outside the board are entitled to keep
 * moving. Everything *on* the board is not: the simulation is frozen, `prevX`
 * equals `x`, `alpha` is pinned to exactly 1, and a tank whose tracks keep
 * scrolling (or a power-up that keeps bobbing) over a stopped field reads as a
 * bug. So the views that draw the field zero their own dt here rather than the
 * loop zeroing it for everyone.
 *
 * **`alpha` is deliberately not touched.** It stays exactly 1 through a pause
 * (T2.1's contract, and the reason `lerp` is written to be bit-exact at t = 1);
 * clamping it is the failure this file's `lerp` comment already warns about.
 */
export function animDtOf(state: GameState, dtMs: number): number {
  return state.paused ? 0 : dtMs;
}

/**
 * Where a point at height `y` and board depth `z` **lands on screen**, expressed
 * as the board depth of the ground point it coincides with.
 *
 * Art §2 fixes the camera at yaw 0, so screen height is `y·sin θ − z·cos θ` and
 * two points coincide when `z − y·tan θ` is equal: one number per point orders
 * the whole scene vertically on screen. Exported because it is the only honest
 * way to answer "is this probe point visible, or is a taller part standing in
 * front of it" without a renderer — see `EAGLE_PROBE`, which
 * `tests/render/models.test.ts` checks against every other part of the model.
 */
export function screenDepth(y: number, z: number): number {
  return z - y * PITCH_TAN;
}

/**
 * Writes one part's instance matrix **directly**, without composing a `Matrix4`
 * from a position/quaternion/scale triple.
 *
 * Two reasons, and both are load-bearing: it allocates nothing, and at yaw 0 it
 * is **bit-exact** — `cx + 1·px + 0·py + 0·pz` is `cx + px`, which is what keeps
 * a paused frame (alpha exactly 1) pixel-stable rather than a ULP away from
 * itself every frame.
 *
 * @param r a row-major 3×3 basis: the part's local axes in the entity's frame.
 * @param cx,cy,cz the entity's centre, already in world coordinates.
 * @param px,py,pz the part's centre in the entity's local frame.
 * @param sw,sh,sd the part's full extents. All three zero collapses it, which is
 * how an `InstancedMesh` hides an instance without disturbing anyone's index.
 *
 * Lives here rather than inside a view because both `tankView.ts` and
 * `propView.ts` need exactly this, and a second copy is how two files drift
 * apart (the same argument that put `faceTint` in `materials.ts`).
 */
export function writePartMatrix(
  mesh: InstancedMesh,
  index: number,
  r: Float64Array,
  cx: number,
  cy: number,
  cz: number,
  px: number,
  py: number,
  pz: number,
  sw: number,
  sh: number,
  sd: number,
): void {
  const e = mesh.instanceMatrix.array as Float32Array;
  const o = index * 16;
  e[o] = r[0] * sw;
  e[o + 1] = r[3] * sw;
  e[o + 2] = r[6] * sw;
  e[o + 3] = 0;
  e[o + 4] = r[1] * sh;
  e[o + 5] = r[4] * sh;
  e[o + 6] = r[7] * sh;
  e[o + 7] = 0;
  e[o + 8] = r[2] * sd;
  e[o + 9] = r[5] * sd;
  e[o + 10] = r[8] * sd;
  e[o + 11] = 0;
  e[o + 12] = cx + r[0] * px + r[1] * py + r[2] * pz;
  e[o + 13] = cy + r[3] * px + r[4] * py + r[5] * pz;
  e[o + 14] = cz + r[6] * px + r[7] * py + r[8] * pz;
  e[o + 15] = 1;
}

/**
 * Rotation about **x** that turns a board-parallel quad to face the camera.
 *
 * Art §2 fixes the camera at yaw 0 and pitch 32° from vertical, so a billboard
 * is a constant rather than a per-frame `lookAt`: a quad whose normal is +y
 * rotated by θ about +x has normal `(0, cos θ, sin θ)`, and the direction back
 * to this camera is `(0, cos 32°, sin 32°)`. Derived from `PITCH_TAN` rather
 * than written out, so the two cannot drift if the pitch is ever re-ruled.
 */
export const BILLBOARD_X = Math.atan(PITCH_TAN);

/** The material's own token, unmodified — the surface art §6 target 1 measures. */
const PLAIN: readonly [number, number, number] = [1, 1, 1];

/** A pure value shade of the type's own token (no hue shift). */
function shade(k: number): readonly [number, number, number] {
  return [k, k, k];
}

// ---------------------------------------------------------------------------
// --- The part table --------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * What a part *is*, which is how `tankView.ts` decides what to do with it each
 * frame. Roles are behavioural, not decorative: `tread` scrolls, `plate` takes
 * the armor HP tint, `ring`/`tip` appear with the player's star tier, and the
 * three overlay roles are drawn only while their timer is running.
 */
export type PartRole =
  | 'track'
  | 'tread'
  | 'hull'
  | 'plate'
  | 'turret'
  | 'cap'
  | 'barrel'
  | 'shroud'
  | 'trim'
  | 'exhaust'
  | 'ring'
  | 'tip'
  | 'shield'
  | 'stun'
  | 'star';

/** Roles that are an effect *around* the tank, not part of its body. */
const OVERLAY_ROLES: ReadonlySet<PartRole> = new Set<PartRole>([
  'shield',
  'stun',
  'star',
]);

export function isOverlayRole(role: PartRole): boolean {
  return OVERLAY_ROLES.has(role);
}

/**
 * One box, in tank-local space: origin at the tank's centre on the board, +x
 * right, +y up, **−z forward**. `x`/`y`/`z` are the box's centre and
 * `w`/`h`/`d` its full extents, so the part *is* its instance matrix — scale
 * then translate, with no offset arithmetic at the call site.
 */
export interface ModelPart {
  readonly role: PartRole;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** Multiplier against the type's token; see {@link faceTint}. */
  readonly tint: readonly [number, number, number];
  /** Star tier at which a `ring`/`tip` appears (1…3). Absent = always. */
  readonly tier?: number;
  /** Position within its role group — tread rung, stun star, shield side. */
  readonly index?: number;
  /** Moves with the gun: turret, barrel, shroud, tier hardware. */
  readonly recoil?: boolean;
  /** Faces the camera and ignores the tank's yaw (see {@link BILLBOARD_X}). */
  readonly billboard?: boolean;
}

export type TankType = 'p1' | 'p2' | 'basic' | 'fast' | 'power' | 'armor';

export const TANK_TYPES: readonly TankType[] = Object.freeze([
  'p1',
  'p2',
  'basic',
  'fast',
  'power',
  'armor',
] as const);

export interface TankModel {
  readonly type: TankType;
  /** The art §3.1 palette key this skin is authored from. */
  readonly tokenKey: PaletteKey;
  /** …and its value, for the ratio maths and the calibration probe. */
  readonly token: number;
  /** Which shared material carries it. */
  readonly material: TankMaterialKey;
  readonly parts: readonly ModelPart[];
}

// --- shared proportions (art §4: "footprint 16×16 u, height ~10 u") --------

const HALF = TANK_SIZE / 2;
const TRACK_W = 4;
const TRACK_X = HALF - TRACK_W / 2;
const TRACK_H = 5;

/**
 * Tread rungs per track, and the span they scroll through.
 *
 * The span is **shorter than the track** so a rung that wraps past the rear lip
 * lands back inside the track rather than half outside its front — see
 * `wrapTread` in `tankView.ts`. Three rungs over 14 u is a 4.67 u pitch, i.e. a
 * ~19 px feature at the canonical 1600×900 viewport: visible, and coarse enough
 * that art §9's *stepped* scroll reads as steps rather than as sliding.
 */
export const TREAD_N = 3;
export const TREAD_SPAN = 14;
export const TREAD_PITCH = TREAD_SPAN / TREAD_N;
const TREAD_H = 1.2;
const TREAD_D = 1.6;
/** How far a rung stands proud of the track top — what makes the step visible. */
const TREAD_PROUD = 0.5;

const TRACK_TINT = shade(0.5);
const TREAD_TINT = shade(0.86);
const BARREL_TINT = shade(0.72);

/** Local z of tread rung `i` at rest. */
export function treadBaseZ(i: number): number {
  return -TREAD_SPAN / 2 + TREAD_PITCH * (i + 0.5);
}

function part(p: ModelPart): ModelPart {
  return p;
}

/** Art §4's "track blocks ×2", plus the rungs art §9 scrolls. */
function trackSet(w: number, h: number, x: number): ModelPart[] {
  const out: ModelPart[] = [];
  for (const sx of [-x, x]) {
    out.push(
      part({
        role: 'track',
        x: sx,
        y: h / 2,
        z: 0,
        w,
        h,
        d: TANK_SIZE,
        tint: TRACK_TINT,
      }),
    );
  }
  for (const sx of [-x, x]) {
    for (let i = 0; i < TREAD_N; i++) {
      out.push(
        part({
          role: 'tread',
          x: sx,
          y: h - TREAD_H / 2 + TREAD_PROUD,
          z: treadBaseZ(i),
          w,
          h: TREAD_H,
          d: TREAD_D,
          tint: TREAD_TINT,
          index: i,
        }),
      );
    }
  }
  return out;
}

/**
 * The spawn star of art §4 — two crossed bars, billboarded.
 *
 * Drawn on the **shared `spawnStar` material** rather than on the tank's own
 * (art §8's emissive ruling, 2026-08-02), so its tint is `PLAIN`: there is no
 * ratio to apply because `material.color` already *is* `spawnAccent`. The parts
 * still live in the tank's table because that is where a reader looks for them
 * and because the twinkle and the billboard are per-tank; only the mesh they
 * are written into differs.
 */
function starParts(): ModelPart[] {
  const tint = PLAIN;
  return [
    part({
      role: 'star',
      x: 0,
      y: 6,
      z: 0,
      w: 11,
      h: 0.6,
      d: 2.4,
      tint,
      index: 0,
      billboard: true,
    }),
    part({
      role: 'star',
      x: 0,
      y: 6,
      z: 0,
      w: 2.4,
      h: 0.6,
      d: 11,
      tint,
      index: 1,
      billboard: true,
    }),
  ];
}

/**
 * The spawn shield, as a square frame around the tank.
 *
 * A *frame* rather than a shell because the tank materials are opaque: a shell
 * would hide the tank it is protecting, and per-instance transparency is not a
 * thing three offers. Four chunky bars read as a shield in the same toy-diorama
 * register as everything else, and cost no extra draw call because they are
 * instances of the tank's own mesh.
 */
function shieldParts(token: number): ModelPart[] {
  const tint = faceTint(PALETTE.spawnAccent, token);
  const r = HALF + 0.8;
  const bar = 1.4;
  const span = 2 * r + bar;
  return [
    part({
      role: 'shield',
      x: 0,
      y: 5.4,
      z: -r,
      w: span,
      h: bar,
      d: bar,
      tint,
      index: 0,
    }),
    part({
      role: 'shield',
      x: 0,
      y: 5.4,
      z: r,
      w: span,
      h: bar,
      d: bar,
      tint,
      index: 1,
    }),
    part({
      role: 'shield',
      x: -r,
      y: 5.4,
      z: 0,
      w: bar,
      h: bar,
      d: span,
      tint,
      index: 2,
    }),
    part({
      role: 'shield',
      x: r,
      y: 5.4,
      z: 0,
      w: bar,
      h: bar,
      d: span,
      tint,
      index: 3,
    }),
  ];
}

/** Art §8's "orbiting stars over the stunned tank" — position is per frame. */
function stunParts(token: number): ModelPart[] {
  const tint = faceTint(PALETTE.powerupGold, token);
  const out: ModelPart[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      part({
        role: 'stun',
        x: 0,
        y: 13,
        z: 0,
        w: 1.7,
        h: 1.7,
        d: 1.7,
        tint,
        index: i,
      }),
    );
  }
  return out;
}

// --- the five silhouettes (art §4) ----------------------------------------

/**
 * Player: "balanced hull, rounded turret, centre barrel". The turret is a
 * two-step stack — a wide base and an inset cap — which is how a box primitive
 * says "rounded" at this scale, and it is the shape that separates a player
 * from Basic's single flat turret in grayscale.
 *
 * The **cap carries the untouched token** and is the model's highest horizontal
 * face, which is deliberate: it is what {@link TANK_PROBE} samples, so art §6
 * target 1 measures the type's own albedo rather than an accent.
 */
function playerParts(token: number, accent: number): ModelPart[] {
  const accentTint = faceTint(accent, token);
  const rings: ModelPart[] = [];
  for (let i = 1; i <= 3; i++) {
    rings.push(
      part({
        role: 'ring',
        x: 0,
        y: 8.6,
        z: -3.6 - i,
        w: 2.8,
        h: 2.8,
        d: 0.6,
        tint: accentTint,
        tier: i,
        index: i,
        recoil: true,
      }),
    );
  }
  return [
    ...trackSet(TRACK_W, TRACK_H, TRACK_X),
    // The hull is set BACK and is shorter than the tracks, which is what leaves
    // the barrel visible between them. A hull that fills the footprint swallows
    // the barrel under a 32° camera — measured on this task's first screenshots,
    // where every tank read as a lidded box.
    part({
      role: 'hull',
      x: 0,
      y: 5.75,
      z: 2,
      w: 12,
      h: 4.5,
      d: 11,
      tint: PLAIN,
    }),
    part({
      role: 'turret',
      x: 0,
      y: 8.75,
      z: 1,
      w: 8,
      h: 1.5,
      d: 8,
      tint: shade(0.88),
      recoil: true,
    }),
    part({
      role: 'cap',
      x: 0,
      y: 9.75,
      z: 1,
      w: 5.6,
      h: 0.5,
      d: 5.6,
      tint: PLAIN,
      recoil: true,
    }),
    part({
      role: 'barrel',
      x: 0,
      y: 8.6,
      z: -4.4,
      w: 1.8,
      h: 1.8,
      d: 7,
      tint: BARREL_TINT,
      recoil: true,
    }),
    ...rings,
    // Art §4's "gold emissive barrel tip", on the shared `tierTip` material —
    // so `PLAIN` here means `powerupGold`, not the tank's own token.
    part({
      role: 'tip',
      x: 0,
      y: 8.6,
      z: -7.55,
      w: 2.4,
      h: 2.4,
      d: 0.9,
      tint: PLAIN,
      tier: 3,
      recoil: true,
    }),
    ...shieldParts(token),
    ...stunParts(token),
    ...starParts(),
  ];
}

/** Basic: "short hull, small turret set back" (art §4). */
function basicParts(token: number): ModelPart[] {
  const band = faceTint(PALETTE.enemyBasicTrim, token);
  return [
    ...trackSet(TRACK_W, TRACK_H, TRACK_X),
    part({
      role: 'hull',
      x: 0,
      y: 5.75,
      z: 2,
      w: 12,
      h: 4.5,
      d: 9.5,
      tint: PLAIN,
    }),
    part({
      role: 'turret',
      x: 0,
      y: 9,
      z: 2.5,
      w: 6.5,
      h: 2,
      d: 6.5,
      tint: PLAIN,
      recoil: true,
    }),
    // A modest barrel, and that is a §4 requirement rather than taste: Power's
    // barrel has to read as "noticeably longer than any other type", and every
    // barrel is clipped by the same 16 u footprint — so if Basic's also reaches
    // the front edge, the two are the same length on screen whatever the part
    // table says.
    part({
      role: 'barrel',
      x: 0,
      y: 8.8,
      z: -2,
      w: 1.6,
      h: 1.6,
      d: 7.5,
      tint: BARREL_TINT,
      recoil: true,
    }),
    // Art §3.1's red, as two shoulder flashes either side of the barrel rather
    // than one band across it — a single strip would intersect the barrel and
    // poke through it.
    part({
      role: 'trim',
      x: -4.2,
      y: 8.25,
      z: -2.6,
      w: 3.6,
      h: 0.5,
      d: 2.2,
      tint: band,
      index: 0,
    }),
    part({
      role: 'trim',
      x: 4.2,
      y: 8.25,
      z: -2.6,
      w: 3.6,
      h: 0.5,
      d: 2.2,
      tint: band,
      index: 1,
    }),
    ...starParts(),
  ];
}

/** Fast: "narrow hull (12 u wide), elongated, tracks exposed front" (art §4). */
function fastParts(token: number): ModelPart[] {
  const w = 3;
  const x = 6 - w / 2;
  return [
    ...trackSet(w, TRACK_H, x),
    part({ role: 'hull', x: 0, y: 5.5, z: 2, w: 6, h: 4, d: 10, tint: PLAIN }),
    part({
      role: 'turret',
      x: 0,
      y: 8.5,
      z: 2.5,
      w: 5,
      h: 2,
      d: 5,
      tint: shade(0.85),
      recoil: true,
    }),
    part({
      role: 'cap',
      x: 0,
      y: 9.75,
      z: 2.5,
      w: 3.6,
      h: 0.5,
      d: 3.6,
      tint: PLAIN,
      recoil: true,
    }),
    part({
      role: 'barrel',
      x: 0,
      y: 8.4,
      z: -2.5,
      w: 1.4,
      h: 1.4,
      d: 11,
      tint: BARREL_TINT,
      recoil: true,
    }),
    // A dorsal spine at the tail, in art §3.1's `enemyFastTrim` orange (added
    // 2026-08-02 — it was an unauthored "orange" until then, and shipped as a
    // value shade). The spine is the silhouette cue art §11 wants ahead of
    // colour; the orange reinforces it.
    part({
      role: 'trim',
      x: 0,
      y: 8.3,
      z: 5.6,
      w: 1.6,
      h: 1.6,
      d: 4.4,
      tint: faceTint(PALETTE.enemyFastTrim, token),
    }),
    ...starParts(),
  ];
}

/**
 * Power (art §4, amended 2026-08-02): "standard hull, **barrel is the
 * silhouette**: noticeably longer and thicker than any other type, ending in a
 * blocky muzzle brake."
 *
 * The amendment came out of T2.4's own measurement: Basic-vs-Power was the
 * weakest grayscale pair at 11.0% strongly-different area, because the previous
 * cut put Power's mass in a shroud sitting *above* the hull — and turret-height
 * differences do not read from all four facings under a 32° camera. A barrel
 * does: it is the one part that projects clear of the chassis whichever way the
 * tank is pointing. So the barrel carries the mass (3.0 u thick over 11.5 u,
 * against Fast's 1.4 × 11 and Armor's 2.0 × 9) and the brake caps it.
 */
function powerParts(): ModelPart[] {
  // The fin is shaded and the muzzle block is BRIGHT, which is a readability
  // decision and not a style one: the brake overhangs the near-black board, so
  // a dark block loses its own edge there. Measured — art §11 asks for value
  // separation, and the brightest part of Power's silhouette is now the part
  // that distinguishes it.
  const dark = shade(0.62);
  const bright = shade(1.25);
  return [
    ...trackSet(TRACK_W, TRACK_H, TRACK_X),
    part({
      role: 'hull',
      x: 0,
      y: 5.75,
      z: 2.2,
      w: 12,
      h: 4.5,
      d: 10,
      tint: PLAIN,
    }),
    part({
      role: 'turret',
      x: 0,
      y: 9,
      z: 1.8,
      w: 8,
      h: 2,
      d: 8,
      tint: PLAIN,
      recoil: true,
    }),
    part({
      role: 'barrel',
      x: 0,
      y: 8.2,
      z: -2.25,
      w: 3.2,
      h: 2.8,
      d: 11.5,
      tint: BARREL_TINT,
      recoil: true,
    }),
    // The brake, as two stepped blocks at the muzzle — both wider than the
    // barrel, which is what makes it read as a brake rather than as more
    // barrel. Clear of the hull front (z = −2.8) on purpose: the previous cut
    // overlapped it and the mass simply did not appear.
    part({
      role: 'shroud',
      x: 0,
      y: 8.2,
      z: -4.4,
      w: 5,
      h: 3.4,
      d: 1.4,
      tint: dark,
      index: 0,
      recoil: true,
    }),
    part({
      role: 'shroud',
      x: 0,
      y: 8.2,
      z: -6.7,
      w: 6.6,
      h: 3.6,
      d: 2.6,
      tint: bright,
      index: 1,
      recoil: true,
    }),
    ...starParts(),
  ];
}

/** Armor: "tall stacked plates (+2 u), twin exhausts; plates tint by HP". */
function armorParts(): ModelPart[] {
  const trackH = 5.5;
  const plates: ModelPart[] = [
    part({
      role: 'plate',
      x: 0,
      y: 6.4,
      z: 1.6,
      w: 13,
      h: 2.6,
      d: 12,
      tint: PLAIN,
      index: 0,
    }),
    part({
      role: 'plate',
      x: 0,
      y: 8.4,
      z: 1.6,
      w: 11.4,
      h: 2.2,
      d: 10.4,
      tint: PLAIN,
      index: 1,
    }),
    part({
      role: 'plate',
      x: 0,
      y: 10,
      z: 1.6,
      w: 9.8,
      h: 1.8,
      d: 8.8,
      tint: PLAIN,
      index: 2,
    }),
  ];
  const exhaust = shade(0.42);
  return [
    ...trackSet(TRACK_W, trackH, TRACK_X),
    ...plates,
    part({
      role: 'turret',
      x: 0,
      y: 11.1,
      z: 2.4,
      w: 7,
      h: 1.8,
      d: 7,
      tint: PLAIN,
      recoil: true,
    }),
    part({
      role: 'barrel',
      x: 0,
      y: 10.8,
      z: -3,
      w: 2,
      h: 2,
      d: 9,
      tint: BARREL_TINT,
      recoil: true,
    }),
    part({
      role: 'exhaust',
      x: -3.6,
      y: 10.2,
      z: 5.8,
      w: 1.6,
      h: 3.6,
      d: 1.6,
      tint: exhaust,
      index: 0,
    }),
    part({
      role: 'exhaust',
      x: 3.6,
      y: 10.2,
      z: 5.8,
      w: 1.6,
      h: 3.6,
      d: 1.6,
      tint: exhaust,
      index: 1,
    }),
    ...starParts(),
  ];
}

function model(
  type: TankType,
  tokenKey: PaletteKey,
  material: TankMaterialKey,
  parts: ModelPart[],
): TankModel {
  return Object.freeze({
    type,
    tokenKey,
    token: PALETTE[tokenKey],
    material,
    parts: Object.freeze(parts.map((p) => Object.freeze(p))),
  });
}

export const TANK_MODELS: Readonly<Record<TankType, TankModel>> = Object.freeze(
  {
    p1: model(
      'p1',
      'player1',
      'player1',
      playerParts(PALETTE.player1, PALETTE.player1Accent),
    ),
    p2: model(
      'p2',
      'player2',
      'player2',
      playerParts(PALETTE.player2, PALETTE.player2Accent),
    ),
    basic: model(
      'basic',
      'enemyBasic',
      'enemyBasic',
      basicParts(PALETTE.enemyBasic),
    ),
    fast: model('fast', 'enemyFast', 'enemyFast', fastParts(PALETTE.enemyFast)),
    power: model('power', 'enemyPower', 'enemyPower', powerParts()),
    armor: model('armor', 'enemyArmor', 'enemyArmor', armorParts()),
  },
);

/** Which skin a tank wears. Pure lookup — no allocation per frame. */
export function tankTypeOf(tank: Tank): TankType {
  if (tank.kind === 'player') {
    return tank.playerIndex === 1 ? 'p2' : 'p1';
  }
  switch (tank.enemyType) {
    case 'fast':
      return 'fast';
    case 'power':
      return 'power';
    case 'armor':
      return 'armor';
    default:
      return 'basic';
  }
}

export function countRole(model: TankModel, role: PartRole): number {
  let n = 0;
  for (const p of model.parts) {
    if (p.role === role) n++;
  }
  return n;
}

export interface ModelBounds {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

/** The minimum a part table has to look like to be measured. */
export interface BoxPart {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/**
 * The axis-aligned box a part table occupies. Shared by tanks and props so
 * "16×16 u footprint" means the same measurement wherever it is asserted.
 */
export function partBounds(parts: readonly BoxPart[]): ModelBounds {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of parts) {
    x0 = Math.min(x0, p.x - p.w / 2);
    x1 = Math.max(x1, p.x + p.w / 2);
    y0 = Math.min(y0, p.y - p.h / 2);
    y1 = Math.max(y1, p.y + p.h / 2);
    z0 = Math.min(z0, p.z - p.d / 2);
    z1 = Math.max(z1, p.z + p.d / 2);
  }
  // Rounded because these are compared against art §4's whole numbers and a
  // sum of authored decimals lands a ULP away from them.
  const round = (n: number): number => Math.round(n * 1e6) / 1e6;
  return Object.freeze({
    width: round(x1 - x0),
    height: round(y1 - y0),
    depth: round(z1 - z0),
  });
}

/**
 * The box art §4 specifies, measured off the parts rather than declared beside
 * them — so "Fast is 12 u wide" and "Armor is 12 u tall" are properties of the
 * geometry that ships, not of a comment. Overlay roles are excluded: the shield
 * frame is deliberately wider than the tank.
 */
export function modelBounds(model: TankModel): ModelBounds {
  return partBounds(model.parts.filter((p) => !isOverlayRole(p.role)));
}

/**
 * Where `scripts/calibrate-lighting.ts` samples a tank, in tank-local space.
 *
 * **Derived from the part table, not written out** — the same discipline
 * `CANOPY_PROBE` follows in `terrainView.ts`, and for the same reason: a probe
 * built from a stand-in answers a different question from the one art §6 asks,
 * and a resized model would silently leave it sampling thin air.
 *
 * Both points sit on a part whose tint is exactly `PLAIN`, so what gets measured
 * is the **type's own token under the rig** rather than the ratio between two
 * authored colours (the mistake that made T2.3's first canopy probe read
 * +29.5%).
 *
 * - `top` — the centre of the highest untinted horizontal face. Normal straight
 *   up, hemisphere blend weight 1, so art §6 target 1 applies to it unchanged.
 * - `side` — the centre of the southernmost untinted vertical face. Under a
 *   yaw-0 camera the south face is the only vertical one with projected area,
 *   and the key (north-west) never reaches it, so this is the shade side the
 *   player actually sees. Art §3.1 authors **no side token for tanks**, so this
 *   has no ±% target; it is reported as a *hue*, which is the evidence art §6's
 *   re-evaluation trigger asks for.
 */
export interface TankProbe {
  readonly top: readonly [number, number, number];
  readonly side: readonly [number, number, number];
}

function probeOf(model: TankModel): TankProbe {
  const plain = model.parts.filter(
    (p) =>
      !isOverlayRole(p.role) &&
      // Tier hardware is conditional (and the tip is on another material
      // entirely), so it must never be what the probe samples.
      p.tier === undefined &&
      p.tint.every((c) => c === 1),
  );
  let top = plain[0];
  let side = plain[0];
  for (const p of plain) {
    if (p.y + p.h / 2 > top.y + top.h / 2) top = p;
    if (p.z + p.d / 2 > side.z + side.d / 2) side = p;
  }
  const round = (n: number): number => Math.round(n * 1e6) / 1e6;
  return Object.freeze({
    top: Object.freeze([top.x, round(top.y + top.h / 2), top.z] as const),
    side: Object.freeze([side.x, side.y, round(side.z + side.d / 2)] as const),
  });
}

export const TANK_PROBE: Readonly<Record<TankType, TankProbe>> = Object.freeze({
  p1: probeOf(TANK_MODELS.p1),
  p2: probeOf(TANK_MODELS.p2),
  basic: probeOf(TANK_MODELS.basic),
  fast: probeOf(TANK_MODELS.fast),
  power: probeOf(TANK_MODELS.power),
  armor: probeOf(TANK_MODELS.armor),
});

/**
 * The armor HP colours art §3.1 authors, index 0 = full HP: **silver → green →
 * yellow → dark-silver** (fidelity §3.2's order).
 *
 * A deliberate deviation, not a placeholder. T10's ROM read closed `[CAL-04]`:
 * the NES holds no colour per HP at all — `$DFCD` indexes `tbl_E003` with
 * `(4·frame + hp) & 7`, so an armor tank strobes between two of four NES sprite
 * palette slots every frame. Our renderer has no NES palette to strobe between
 * (art §3), and a 30 Hz colour flicker is exactly what art §11's reduced-motion
 * rule exists to avoid, so this stays a stable tint per HP. Fidelity §16.2 has
 * the recovered mechanism written out in full.
 *
 * **Luminance-descending on purpose** — art §3.1 requires remaining HP to read
 * in grayscale as well as in colour, so this is not merely a hue ramp.
 * {@link ARMOR_HP_TINT} is what ships; this table is what it is derived from,
 * and what `scripts/calibrate-lighting.ts` scores each rendered plate against.
 */
export const ARMOR_HP_TOKEN: readonly number[] = Object.freeze([
  PALETTE.enemyArmor,
  PALETTE.enemyArmorHp3,
  PALETTE.enemyArmorHp2,
  PALETTE.enemyArmorHp1,
]);

/**
 * …the same four colours as **ratios** against the `enemyArmor` token, which is
 * the form an `instanceColor` needs: `enemyArmor × ARMOR_HP_TINT[i]` is
 * `ARMOR_HP_TOKEN[i]`, so `material.color` stays the authored silver whatever
 * an Armor tank's HP is (art §3.0, and what the calibration probe reads).
 *
 * Index 0 is exactly `[1, 1, 1]` by construction — it is the token divided by
 * itself — and must stay so: a full-HP Armor tank is the target-1 probe.
 */
export const ARMOR_HP_TINT: readonly (readonly [number, number, number])[] =
  Object.freeze(ARMOR_HP_TOKEN.map((hex) => faceTint(hex, PALETTE.enemyArmor)));

if (ARMOR_HP_TINT.length !== ARMOR_HP) {
  throw new Error(
    'ARMOR_HP_TINT must cover every HP level fidelity §3.2 allows',
  );
}

/**
 * Per-type ratio that lands every tank skin on one shared colour — the two
 * whole-tank dynamic tints art §9 asks for, precomputed because they are
 * per-type constants and a frame must not divide six colours to find them.
 */
function tintTable(
  target: number,
): Readonly<Record<TankType, readonly number[]>> {
  const out = {} as Record<TankType, readonly number[]>;
  for (const type of TANK_TYPES) {
    out[type] = faceTint(target, TANK_MODELS[type].token);
  }
  return Object.freeze(out);
}

/** Art §9's white hit flash: `token × WHITE_TINT[type]` is pure white. */
export const WHITE_TINT = tintTable(0xffffff);

/** Art §9's carrier pulse: `token × DANGER_TINT[type]` is `danger`. */
export const DANGER_TINT = tintTable(PALETTE.danger);

// ---------------------------------------------------------------------------
// --- The props: the eagle base and the six power-ups (T3.3) ----------------
// ---------------------------------------------------------------------------
//
// ## Two materials for seven objects
//
// A prop part is exactly the same thing as a tank part — an axis-aligned box,
// an instance of {@link createPartGeometry}, coloured by a ratio against its
// material's own token — so everything the tank tables buy applies here. What
// differs is the **grouping**: a tank's material is its identity (six skins,
// six materials), while a prop's material is a *surface class* shared across
// objects. That is the whole reason the props fit inside art §8's 12-call
// budget with 10 already spent:
//
// | role | material | carries |
// |---|---|---|
// | `stone` | `propStone` (`eagleStone`) | the pedestal, intact and ruined — **and the fallen emblem**, which is dimmed gold delivered as a ratio |
// | `gold`  | `propGold` (`powerupGold`, emissive) | the standing emblem **and all six power-up shapes** |
//
// The second row is art §3.1's own grouping, not an economy measure: the doc
// authors one gold token for "star, pickups, eagle emblem".
//
// The first row is the economy measure, and it is also the right *look*. Art §4
// asks the destroyed eagle for a "fallen **dimmed** emblem", and `emissive` is a
// material property that no per-instance colour can reach — so an emblem that
// stops glowing has to leave the emissive material altogether. Moving it onto
// the stone is therefore the literal implementation of "dimmed": the gold lands
// through `faceTint(powerupGold, eagleStone)` scaled by {@link FALLEN_DIM}, so
// `material.color` is still exactly `eagleStone` and the thing on screen is a
// dull brass shape lying in the rubble.
//
// ## What is deliberately NOT here
//
// Art §4's smoke wisps, art §8's "power-up spawn/pickup" burst and art §6's
// power-up point light are all T4.x's. This file leaves them a clean seam:
// nothing here allocates, spawns or times a particle, and the two animation
// curves below ({@link powerupBobAt}, {@link powerupYawAt}) are pure so the FX
// layer can read the same phase instead of re-deriving it.

/** Which shared material a prop part is drawn from — see the table above. */
export type PropRole = 'stone' | 'gold';

/**
 * One box in **prop-local** space: origin at the prop's centre on the board,
 * +x east, +y up, +z south. Same convention as {@link ModelPart} minus the
 * behavioural fields — a prop has no tracks to scroll and no turret to recoil,
 * so its parts are static within their model and the animation is on the object.
 */
export interface PropPart extends BoxPart {
  readonly role: PropRole;
  /** Multiplier against the role's material token; see {@link faceTint}. */
  readonly tint: readonly [number, number, number];
  /**
   * Faces the camera and ignores the prop's yaw (see {@link BILLBOARD_X}).
   *
   * A billboarded part's `x/y/z` and `w/h/d` are read in the **billboard
   * frame**, not in board coordinates: `x`/`w` are screen-horizontal, `z`/`d`
   * are screen-vertical with **−z up**, and `y`/`h` run toward the camera, so
   * `y` is a pure depth offset that moves nothing on screen and `h` is a
   * thickness. {@link propPartCentre} converts back to board coordinates.
   */
  readonly billboard?: boolean;
}

/** A prop part's centre in board coordinates, billboard included. */
export function propPartCentre(p: PropPart): [number, number, number] {
  if (p.billboard !== true) return [p.x, p.y, p.z];
  const c = Math.cos(BILLBOARD_X);
  const s = Math.sin(BILLBOARD_X);
  return [p.x, p.y * c - p.z * s, p.y * s + p.z * c];
}

export interface PropModel {
  readonly parts: readonly PropPart[];
}

function propModel(parts: PropPart[]): PropModel {
  return Object.freeze({
    parts: Object.freeze(parts.map((p) => Object.freeze(p))),
  });
}

function stone(p: Omit<PropPart, 'role'>): PropPart {
  return { role: 'stone', ...p };
}

function gold(p: Omit<PropPart, 'role'>): PropPart {
  return { role: 'gold', ...p };
}

/**
 * How far the fallen emblem is knocked back from the gold token. 0.5 lands it
 * on ~`#bd9e4d` — still recognisably the same object, plainly no longer lit
 * from within, which is what "dimmed" has to mean once the emissive is gone.
 */
export const FALLEN_DIM = 0.5;

/** Dimmed gold, expressed against the stone the ruin is drawn on. */
const FALLEN_TINT: readonly [number, number, number] = (() => {
  const t = faceTint(PALETTE.powerupGold, PALETTE.eagleStone);
  return [t[0] * FALLEN_DIM, t[1] * FALLEN_DIM, t[2] * FALLEN_DIM];
})();

/**
 * The intact eagle (art §4: "stone pedestal + gold shield emblem, emissive at
 * low intensity"), on a 16×16 u footprint at `EAGLE_TILE` (fidelity §2).
 *
 * Three decisions that are not taste:
 *
 * - **The pedestal fills its tile and the shield does not.** A 16 u base sits
 *   flush inside the brick nest so the base reads as *built into* the ring
 *   rather than dropped in it, and the stepped inset above it (13.2 → 14.6
 *   cornice → 5.6 post) is what gives a single-token stone any modelling at all
 *   under a key that only reaches its top faces.
 * - **The shield is billboarded, and it is the one place readability beat the
 *   obvious construction.** The first cut stood it upright as a plate facing
 *   south; art §2's camera is 32° from vertical, so a vertical face is
 *   foreshortened to 53% and the emblem measured ~37 × 18 px at the canonical
 *   1600×900 viewport — a gold stripe, not a shield. Turned to face the camera
 *   it is ~40 × 45 px for the same geometry. Art §5's standing rule ("when this
 *   doc and readability conflict, readability wins") is the licence; §4 asks for
 *   an emblem, and an emblem is a plaque, so nothing about the recipe fights it.
 * - **The post is set 2 u north.** Height leans *up* the screen, so a part on
 *   the pedestal's centre covers the cornice behind it; pushing the mast north
 *   keeps the whole south half of the cap clear, which is what makes
 *   {@link EAGLE_PROBE} a measurement of stone rather than of gold.
 */
const eagleIntactParts = (): PropPart[] => [
  // The **cornice carries the untouched token**, and that is deliberate: it is
  // the model's highest horizontal face and therefore what {@link EAGLE_PROBE}
  // samples, so art §6 target 1 measures `eagleStone` itself rather than a
  // ratio between two shades. Everything else on the pedestal is shaded down
  // from it — the same discipline the tank models apply to their caps.
  stone({ x: 0, y: 1.0, z: 0, w: 16.0, h: 2.0, d: 16.0, tint: shade(0.6) }),
  stone({ x: 0, y: 3.6, z: 0, w: 13.2, h: 3.2, d: 13.2, tint: shade(0.86) }),
  stone({ x: 0, y: 5.9, z: 0, w: 14.6, h: 1.4, d: 14.6, tint: PLAIN }),
  stone({ x: 0, y: 8.3, z: -2.0, w: 5.6, h: 3.4, d: 4.0, tint: shade(0.92) }),
  // The shield, bottom-first: a point socketed into the mast, a waist, and the
  // shoulders. Three steps is the fewest that reads as a shield rather than as
  // a slab at the size it occupies on screen.
  //
  // These are BILLBOARD-frame coordinates (see `PropPart.billboard`): `z` is
  // screen height with −z up, so the stack runs from the mast upward, and `y`
  // is pure depth toward the camera. `y = 12` is not decoration either — the
  // deepest part of the pedestal sits at 9.5 on the same axis, so anything less
  // would let the mast draw through the emblem it is holding up.
  gold({ x: 0, y: 12, z: -6.6, w: 4.2, h: 1.8, d: 3.0, tint: PLAIN, billboard: true }), // prettier-ignore
  gold({ x: 0, y: 12, z: -9.8, w: 7.6, h: 1.8, d: 3.4, tint: PLAIN, billboard: true }), // prettier-ignore
  gold({ x: 0, y: 12, z: -13.4, w: 10.0, h: 1.8, d: 3.8, tint: PLAIN, billboard: true }), // prettier-ignore
  // A boss standing proud of the shield face (1.4 u nearer the camera), so the
  // emblem has a lit edge of its own instead of one flat glowing rectangle.
  // Shaded DOWN and not up — see the note on the gold tints below.
  gold({ x: 0, y: 13.4, z: -11.8, w: 4.6, h: 1.6, d: 3.0, tint: shade(0.82), billboard: true }), // prettier-ignore
];

/**
 * The destroyed eagle (art §4: "cracked pedestal, fallen dimmed emblem").
 *
 * **This is the game-over signal, so it is designed as a silhouette delta
 * rather than as a damage decal.** Against the intact model it drops from 19.0 u
 * tall to 5.6 u, has **no parts on the emissive material at all** (0 against 4),
 * opens a gap through the middle of the plinth down to a scorched base, and
 * drops its brightest stone from the token itself to 0.62× of it. At gameplay
 * scale the three things a player can read in one frame — *tall/short*,
 * *bright/dark*, *glowing/not* — all flip at once, and `capture-entities`
 * measures 28.6% of the base's tile as strongly different between the two.
 *
 * Smoke wisps are the third item in §4's recipe and belong to T4.x; the ruin is
 * built so a smoke emitter has an obvious anchor (the gap at the origin).
 */
const eagleDestroyedParts = (): PropPart[] => [
  stone({ x: 0, y: 1.0, z: 0, w: 16.0, h: 2.0, d: 16.0, tint: shade(0.38) }),
  // The two surviving stumps, deliberately unequal in height, depth and
  // position: a symmetric break reads as a design, an asymmetric one as damage.
  stone({
    x: -4.0,
    y: 3.4,
    z: -3.4,
    w: 6.0,
    h: 2.8,
    d: 8.4,
    tint: shade(0.52),
  }),
  stone({ x: 4.4, y: 3.8, z: -4.6, w: 4.6, h: 3.6, d: 6.0, tint: shade(0.46) }),
  stone({ x: 0.6, y: 2.7, z: -1.0, w: 3.2, h: 1.4, d: 3.0, tint: shade(0.6) }),
  stone({ x: -6.0, y: 2.6, z: 4.6, w: 2.8, h: 1.2, d: 2.4, tint: shade(0.62) }),
  stone({ x: 6.2, y: 2.7, z: 3.0, w: 2.6, h: 1.4, d: 2.6, tint: shade(0.56) }),
  // The emblem, face-up in the rubble and off the emissive material entirely.
  // Laid across the south half, where a near-plan camera sees 85% of it.
  stone({ x: -1.0, y: 2.8, z: 1.6, w: 8.6, h: 1.6, d: 3.4, tint: FALLEN_TINT }),
  stone({ x: -0.4, y: 2.8, z: 4.6, w: 6.4, h: 1.6, d: 2.8, tint: FALLEN_TINT }),
  stone({ x: 0.2, y: 2.8, z: 6.8, w: 3.6, h: 1.6, d: 2.0, tint: FALLEN_TINT }),
];

export type EagleState = 'intact' | 'destroyed';

export const EAGLE_MODELS: Readonly<Record<EagleState, PropModel>> =
  Object.freeze({
    intact: propModel(eagleIntactParts()),
    destroyed: propModel(eagleDestroyedParts()),
  });

/**
 * Where `scripts/calibrate-lighting.ts` samples the eagle's stone, in
 * eagle-local space — the cornice's top face, 4.5 u west and 5.0 u south of
 * centre.
 *
 * Three constraints pick that point, and none of them is "the middle":
 *
 * 1. **An untinted face.** The cornice carries exactly `PLAIN`, which is why it
 *    and not the plinth is the model's brightest step: art §6 target 1 is a
 *    statement about a token, and a probe on a shaded face measures the ratio
 *    between two colours instead (the mistake that made T2.3's first canopy
 *    probe read +29.5%).
 * 2. **Not behind anything.** Art §2 fixes the camera, so the sight line is a
 *    constant; the mast and the emblem both sit north of
 *    `screenDepth(6.6, 5.0) = 0.88`, and `propView.test.ts` casts that ray
 *    against every part rather than trusting this comment.
 * 3. **Not in the mast's shadow.** The key is north-west at 50° elevation, so
 *    the mast's shadow falls south-**east** across the cornice; 4.5 u west of
 *    centre is outside it. Art §6 target 1 is about a *fully-lit* surface, and
 *    a probe in shade measures target 2 by accident.
 */
export const EAGLE_PROBE: readonly [number, number, number] = Object.freeze([
  -4.5, 6.6, 5.0,
]);

/** Centre of the eagle's tile in world coordinates (fidelity §2: tile 6,12). */
export function eagleCentre(tile: readonly [number, number]): [number, number] {
  return [tile[0] * TILE + TILE / 2, tile[1] * TILE + TILE / 2];
}

// --- The six power-ups (fidelity §8, art §9) -------------------------------

/**
 * Art §9: "bob **±2 u** @ **1.2 s** + **0.5 rps** yaw + light pulse". The light
 * is art §6's dynamic pool and belongs to T4.x; the two curves below are the
 * whole of the animation this task owns.
 */
export const POWERUP_BOB_U = 2;
export const POWERUP_BOB_MS = 1200;
export const POWERUP_RPS = 0.5;

/**
 * How far a power-up's own base floats above the board at the **middle** of its
 * bob. 2.5 with a ±2 u bob leaves it between 0.5 u and 4.5 u — never touching
 * the board (which would read as resting, not hovering) and never so high that
 * it stops registering with the tile the core will collect it on.
 */
export const POWERUP_HOVER_U = 2.5;

/** Vertical offset of a power-up's base at phase `ms`, in u above the board. */
export function powerupBobAt(ms: number): number {
  return (
    POWERUP_HOVER_U +
    POWERUP_BOB_U * Math.sin((2 * Math.PI * ms) / POWERUP_BOB_MS)
  );
}

/** Yaw at phase `ms`, in radians. */
export function powerupYawAt(ms: number): number {
  return (2 * Math.PI * POWERUP_RPS * ms) / 1000;
}

/**
 * The six shapes, all on one gold material — so **silhouette is the only cue**
 * (art §11: "identifiable in grayscale; colour reinforces, never carries
 * alone"). They are separated on three axes at once, which is what makes them
 * survive both the grayscale test and the 0.5 rps spin that keeps changing
 * every one of their outlines:
 *
 * | | height | widest | plan reading |
 * |---|---|---|---|
 * | star | 3.3 | 12.0 | four arms + a raised boss |
 * | helmet | 9.1 | 12.0 | wide brim under a stepped dome with a crest |
 * | clock | 4.1 | 12.0 | flat dial inside a square rim, two hands |
 * | shovel | 12.6 | 6.8 | upright: blade, shaft, cross grip |
 * | grenade | 9.3 | 8.3 | barrel body, narrow neck, side lever |
 * | tank | 6.0 | 8.8 | two tracks, hull, turret, barrel |
 *
 * The flat pair (star, clock) versus the four tall ones is the first split;
 * within each group the plan outline is unmistakable. `propView.test.ts` pins
 * every pair as separated by ≥ 2 u of height **or** ≥ 2 u of plan width, which
 * is ~8 px at 1600×900 where a whole tile is 65 px.
 *
 * **Every tint here is a shade at or below 1**, and that is a constraint rather
 * than a style: `powerupGold` is `#ffd76b`, whose red channel is already at the
 * ceiling, so a ratio above 1 would clip red first and wash the face toward
 * white instead of brightening it. On this material the untouched token IS the
 * highlight and detail is carved out below it. (The stone material has headroom
 * and does use a ratio above 1, for the cornice.)
 */
const POWERUP_PARTS: Readonly<Record<PowerupType, () => PropPart[]>> =
  Object.freeze({
    // A four-arm cross with diagonal fillers and a raised centre: a star that
    // still reads as a star at every yaw, which a bare cross does not.
    star: () => [
      gold({ x: 0, y: 0.9, z: 0, w: 12.0, h: 1.8, d: 3.0, tint: shade(0.85) }),
      gold({ x: 0, y: 0.9, z: 0, w: 3.0, h: 1.8, d: 12.0, tint: shade(0.85) }),
      gold({
        x: -3.3,
        y: 0.7,
        z: -3.3,
        w: 2.4,
        h: 1.4,
        d: 2.4,
        tint: shade(0.7),
      }),
      gold({
        x: 3.3,
        y: 0.7,
        z: -3.3,
        w: 2.4,
        h: 1.4,
        d: 2.4,
        tint: shade(0.7),
      }),
      gold({
        x: -3.3,
        y: 0.7,
        z: 3.3,
        w: 2.4,
        h: 1.4,
        d: 2.4,
        tint: shade(0.7),
      }),
      gold({
        x: 3.3,
        y: 0.7,
        z: 3.3,
        w: 2.4,
        h: 1.4,
        d: 2.4,
        tint: shade(0.7),
      }),
      gold({ x: 0, y: 2.6, z: 0, w: 5.0, h: 1.6, d: 5.0, tint: PLAIN }),
    ],
    // Rim, three-step dome, crest — plus a **visor peak** thrown forward. The
    // peak is not decoration: without it the helmet is a wide round mound and
    // the clock is a wide round disc, and the two scored 0.868 silhouette IoU,
    // by far the worst pair. A shape that pokes out of its own circle is what
    // an outline test (and an eye) can hold on to.
    helmet: () => [
      gold({ x: 0, y: 0.7, z: 0, w: 11.0, h: 1.4, d: 11.0, tint: shade(0.78) }),
      gold({ x: 0, y: 2.7, z: 0, w: 9.0, h: 2.6, d: 9.0, tint: shade(0.92) }),
      gold({ x: 0, y: 5.0, z: 0, w: 7.0, h: 2.0, d: 7.0, tint: PLAIN }),
      gold({ x: 0, y: 6.8, z: 0, w: 4.6, h: 1.6, d: 4.6, tint: PLAIN }),
      gold({ x: 0, y: 8.3, z: 0, w: 1.8, h: 1.4, d: 6.6, tint: shade(0.72) }),
    ],
    // A pocket watch lying face-up: a bezel around a recessed dial, two hands,
    // and a **crown stem** off one side. Under a 32°-from-vertical camera the
    // plan face is seen at 85%, so the hands — the one thing that says "clock" —
    // are the most legible part of it.
    //
    // It is deliberately the *smallest* of the three wide shapes, and the crown
    // is deliberately outside the bezel: measured against the helmet, an
    // 11 u disc scored 0.868 silhouette IoU (both read as "wide low round
    // slab"), which is the one pair art §11's bar would have failed. Shrinking
    // the body and breaking the outline is what fixed it.
    clock: () => [
      gold({ x: 0, y: 1.2, z: 0, w: 8.8, h: 2.4, d: 7.0, tint: shade(0.82) }),
      gold({
        x: 0,
        y: 3.0,
        z: -3.4,
        w: 9.8,
        h: 1.2,
        d: 1.0,
        tint: shade(0.96),
      }),
      gold({ x: 0, y: 3.0, z: 3.4, w: 9.8, h: 1.2, d: 1.0, tint: shade(0.96) }),
      gold({
        x: -4.4,
        y: 3.0,
        z: 0,
        w: 1.0,
        h: 1.2,
        d: 7.8,
        tint: shade(0.96),
      }),
      gold({ x: 4.4, y: 3.0, z: 0, w: 1.0, h: 1.2, d: 7.8, tint: shade(0.96) }),
      gold({ x: 0, y: 2.9, z: 0, w: 7.2, h: 1.2, d: 5.6, tint: shade(0.42) }),
      // The hands run 1.6 u wide — ~6 px against a 65 px tile. The first cut
      // ran them at 1.0 and they did not resolve at all in the grayscale
      // capture, and the hands are the entire difference between "clock" and
      // "disc".
      gold({ x: 0, y: 4.1, z: -1.3, w: 1.6, h: 1.4, d: 5.0, tint: PLAIN }),
      gold({ x: 1.6, y: 4.1, z: 0, w: 4.0, h: 1.4, d: 1.6, tint: PLAIN }),
      gold({ x: 5.7, y: 2.4, z: 0, w: 2.2, h: 1.4, d: 1.8, tint: PLAIN }),
    ],
    // The only upright one, and by 3.3 u the tallest. A spinning vertical bar
    // keeps its outline at every yaw, which is exactly what the other five
    // cannot promise — so the shape that most needs to be unmistakable gets it.
    shovel: () => [
      // The blade is 2.4 u deep rather than 1.8: under a near-plan camera an
      // upright plate is seen almost edge-on, and the first cut's blade read as
      // a sliver. Depth is what a 32°-from-vertical camera actually sees.
      gold({ x: 0, y: 1.3, z: 0, w: 7.4, h: 2.6, d: 2.4, tint: PLAIN }),
      gold({ x: 0, y: 3.8, z: 0, w: 5.6, h: 2.4, d: 2.4, tint: PLAIN }),
      gold({ x: 0, y: 5.5, z: 0, w: 2.6, h: 1.0, d: 2.0, tint: shade(0.7) }),
      gold({ x: 0, y: 8.5, z: 0, w: 2.0, h: 5.0, d: 2.0, tint: shade(0.85) }),
      gold({ x: 0, y: 11.8, z: 0, w: 5.0, h: 1.6, d: 2.0, tint: PLAIN }),
    ],
    // Barrel body, narrow neck, a lever down one side and a pin ring off the
    // other — the two asymmetric bits are what stop it reading as "the helmet
    // without a brim" while it turns.
    grenade: () => [
      gold({ x: 0, y: 1.1, z: 0, w: 6.0, h: 2.2, d: 6.0, tint: shade(0.8) }),
      gold({ x: 0, y: 3.7, z: 0, w: 7.2, h: 3.0, d: 7.2, tint: shade(0.94) }),
      gold({ x: 0, y: 6.3, z: 0, w: 5.8, h: 2.2, d: 5.8, tint: shade(0.86) }),
      gold({ x: 0, y: 8.1, z: 0, w: 3.2, h: 1.4, d: 3.2, tint: shade(0.7) }),
      gold({ x: 3.2, y: 6.6, z: 0, w: 1.4, h: 5.4, d: 1.6, tint: PLAIN }),
      gold({ x: -3.0, y: 8.6, z: 0.6, w: 2.8, h: 0.8, d: 2.8, tint: PLAIN }),
    ],
    // A tank, at 55% scale. The one power-up whose meaning is literal, so the
    // silhouette is the tank recipe of art §4 rather than an abstraction of it.
    tank: () => [
      gold({ x: -3.2, y: 1.3, z: 0, w: 2.2, h: 2.6, d: 9.6, tint: shade(0.7) }),
      gold({ x: 3.2, y: 1.3, z: 0, w: 2.2, h: 2.6, d: 9.6, tint: shade(0.7) }),
      gold({ x: 0, y: 2.9, z: 0.6, w: 7.2, h: 2.6, d: 7.6, tint: shade(0.9) }),
      gold({ x: 0, y: 5.1, z: 0.6, w: 4.2, h: 1.8, d: 4.2, tint: PLAIN }),
      gold({
        x: 0,
        y: 4.9,
        z: -4.6,
        w: 1.4,
        h: 1.4,
        d: 6.4,
        tint: shade(0.78),
      }),
    ],
  });

/**
 * Radius of the circle a spinning power-up sweeps, in u from its centre.
 *
 * The core places an item on a 16 u lattice slot and collects it on a 16×16 box
 * (fidelity §8), so a shape whose *rotated* corners leave that box is picked up
 * from somewhere it does not appear to be. Measured off the tables rather than
 * asserted about them: a plain bounding-box diagonal is the wrong test (it
 * would condemn the star's 12 × 12 cross, whose arms are 3 u thick and whose
 * real swept radius is 6.4 u), and the right one is the farthest corner.
 */
export function propSweepRadius(model: PropModel): number {
  let r = 0;
  for (const p of model.parts) {
    r = Math.max(
      r,
      Math.hypot(Math.abs(p.x) + p.w / 2, Math.abs(p.z) + p.d / 2),
    );
  }
  return r;
}

export const POWERUP_MODELS: Readonly<Record<PowerupType, PropModel>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(POWERUP_PARTS) as PowerupType[]).map((k) => [
        k,
        propModel(POWERUP_PARTS[k]()),
      ]),
    ) as Record<PowerupType, PropModel>,
  );

/** Parts of one role in a prop model — how a view sizes its two meshes. */
export function countPropRole(model: PropModel, role: PropRole): number {
  let n = 0;
  for (const p of model.parts) {
    if (p.role === role) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// --- Geometry --------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Chamfer of the shared unit box, as a fraction of its edge. 0.06 puts a ~1 u
 * bevel on a 16 u track and ~0.1 u on a barrel — chunky where the piece is big,
 * which is the toy-diorama read art §1 asks for.
 *
 * Note for art §6: the 12 edge quads and 8 corner triangles this produces are
 * 45°-ish normals, i.e. exactly the "uncovered band" §6's closing note flags.
 * They are trim, not the surfaces target 1 measures — {@link TANK_PROBE} samples
 * the flat faces.
 */
export const PART_BEVEL = 0.06;

/**
 * The one primitive every tank part is an instance of: a **chamfered unit box**,
 * centred on the origin, 1×1×1.
 *
 * Positions and normals only — no `color` attribute, deliberately. All colour
 * rides on `instanceColor`, and adding the attribute would force
 * `material.vertexColors = true` on every tank material (see `tankSkin`).
 *
 * Winding is not hand-checked per face. Every triangle's normal is derived from
 * its winding and then *oriented outwards* by testing it against the vertex's
 * own position — valid because the solid is convex and centred on the origin,
 * and it removes the whole class of "one face renders black" bugs that
 * hand-ordering 26 faces invites.
 */
export function createPartGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const h = 0.5;
  const i = h - PART_BEVEL;

  /** A point with `a`-th coordinate `av`, `b`-th `bv`, `c`-th `cv`. */
  const at = (
    a: number,
    av: number,
    b: number,
    bv: number,
    c: number,
    cv: number,
  ): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0];
    p[a] = av;
    p[b] = bv;
    p[c] = cv;
    return p;
  };

  const tri = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
  ): void => {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    // Outward test against the centroid at the origin.
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    const front = nx * cx + ny * cy + nz * cz >= 0;
    const order = front ? [a, b, c] : [a, c, b];
    if (!front) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const v of order) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(nx, ny, nz);
    }
  };

  const quad = (
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
  ): void => {
    tri(a, b, c);
    tri(a, c, d);
  };

  const axes = [0, 1, 2];
  const others = (m: number): [number, number] => {
    const o = axes.filter((k) => k !== m);
    return [o[0], o[1]];
  };

  // The six flat faces.
  for (const m of axes) {
    const [o1, o2] = others(m);
    for (const s of [-1, 1]) {
      quad(
        at(m, s * h, o1, -i, o2, -i),
        at(m, s * h, o1, i, o2, -i),
        at(m, s * h, o1, i, o2, i),
        at(m, s * h, o1, -i, o2, i),
      );
    }
  }

  // The twelve edge chamfers.
  for (const a of axes) {
    for (const b of axes) {
      if (b <= a) continue;
      const c = axes.find((k) => k !== a && k !== b)!;
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          quad(
            at(a, sa * h, b, sb * i, c, -i),
            at(a, sa * h, b, sb * i, c, i),
            at(a, sa * i, b, sb * h, c, i),
            at(a, sa * i, b, sb * h, c, -i),
          );
        }
      }
    }
  }

  // The eight corner triangles.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        tri(
          [sx * h, sy * i, sz * i],
          [sx * i, sy * h, sz * i],
          [sx * i, sy * i, sz * h],
        );
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  return geo;
}

/** Length of the bullet capsule's straight section, art §4's "4×4 u capsule". */
const BULLET_BODY = BULLET_SIZE * 0.6;

/**
 * Total length of {@link createBulletGeometry}'s capsule along z — the two
 * hemispherical caps plus the straight section. Exported because the tracer
 * trail is the *same* geometry stretched, so its instance scale is a ratio
 * against this rather than an absolute length.
 */
export const BULLET_LENGTH = BULLET_SIZE + BULLET_BODY;

/**
 * Art §4's bullet: a 4×4 u capsule, built lying along **z** so a bullet shares
 * the entity layer's "local −z is forward" convention and can reuse `DIR_YAW`.
 * The tracer trail is the same geometry, stretched (see `bulletView.ts`).
 */
export function createBulletGeometry(): BufferGeometry {
  const geo = new CapsuleGeometry(BULLET_SIZE / 2, BULLET_BODY, 3, 8);
  geo.rotateX(Math.PI / 2);
  return geo;
}
