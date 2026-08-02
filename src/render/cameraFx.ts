// src/render/cameraFx.ts — everything art §2 does to the *camera* plus art
// §10's two screen-space beats: trauma shake, the stage fly-in and its curtain,
// the base-destruction slow-mo and dolly, and world-space score popups.
// Presentation only: it **reads** `GameState` and the event stream and writes
// to neither (arch §3.3).
//
// ## The two halves of this file
//
// Everything above `--- The view ---` is **pure**: the trauma curve, the shake
// formula, the fly-in ease, the curtain timeline, the slow-mo window and the
// popup animation. `tests/render/cameraFx.test.ts` asserts all of it in the
// Vitest node environment, where there is no DOM and no WebGL. Below it is the
// scene-graph plumbing, verified by `scripts/capture-fx.ts`'s screenshots.
//
// ## Why the rig math is NOT here
//
// `sceneRoot.ts` owns the camera, and it owns the facts that make a pose
// meaningful: the target point, `CAMERA_DIST`, and the fact that the camera's
// up vector is `(0, sin θ, −cos θ)`. This file computes *numbers* — a pitch, a
// screen-space offset, a roll, a zoom — and hands them to
// `SceneRoot.setCameraPose`. A second copy of the rig here is exactly how the
// two would drift apart, and the drift would be invisible until a resize.
//
// ## Slow-mo is a time scale, not a clock
//
// Arch §5: "presentation-side time dilation of *interpolation only* —
// simulation ticks are unaffected". So this file never touches `alpha` and
// never skips a `step()`. It publishes {@link CameraFx.timeScale}, and
// `renderer.ts` multiplies the frame's `dtMs` by it before handing it to the
// views that animate. The camera's own beats — the shake, the fly-in, the
// dolly, the curtain — run on the **unscaled** clock, because art §2 authors
// them in wall-clock milliseconds ("0.6 s at 0.25×" is 0.6 s of real time).

import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
} from 'three';

import type { GameEvent } from '../core/events';
import type { GameState, StagePhase } from '../core/types';
import type { Materials } from './materials';
import { BILLBOARD_X, animDtOf, writePartMatrix } from './models';
import { CAMERA_PITCH_RAD, type SceneRoot } from './sceneRoot';

// ---------------------------------------------------------------------------
// --- Trauma (art §2) -------------------------------------------------------
// ---------------------------------------------------------------------------

/** "trauma ∈ [0,1], **decays 1.2/s**". */
export const TRAUMA_DECAY_PER_S = 1.2;
/** "offset = trauma² · **max 3 u**". */
export const SHAKE_MAX_U = 3;
/** "roll **≤ 0.3°**". */
export const SHAKE_MAX_ROLL_RAD = (0.3 * Math.PI) / 180;

/**
 * Art §2's three trauma sources, verbatim. Kept as one frozen table so the
 * ranking is arguable in one place, and so `cameraFx.test.ts` can assert the
 * doc's numbers rather than a re-statement of the code.
 */
export const TRAUMA = Object.freeze({
  /** "own shot +0.05" — the player's own gun, not every gun on the board. */
  ownShot: 0.05,
  /** "nearby explosion +0.25" */
  explosion: 0.25,
  /** "base +0.6" */
  base: 0.6,
});

/**
 * How far "nearby" is, in world units, for art §2's explosion source.
 *
 * Not in the doc, and it has to be *something*: an explosion on the far side of
 * a 208 u board shaking the camera as hard as one at the player's feet is the
 * failure this guards against. Two tiles of full strength, falling to nothing
 * at four — the range at which a tank dying is still the player's problem.
 */
export const NEARBY_FULL_U = 32;
export const NEARBY_NONE_U = 64;

/** Trauma contributed by an explosion `distance` u from the camera's subject. */
export function nearbyFalloff(distance: number): number {
  if (distance <= NEARBY_FULL_U) return 1;
  if (distance >= NEARBY_NONE_U) return 0;
  return 1 - (distance - NEARBY_FULL_U) / (NEARBY_NONE_U - NEARBY_FULL_U);
}

/**
 * Art §2's decay, applied for `dtMs`. Linear in trauma (not in the offset),
 * which is what makes "decays 1.2/s" mean what it says: a full 1.0 is spent in
 * exactly 833 ms.
 */
export function traumaAfter(trauma: number, dtMs: number): number {
  const next = trauma - (TRAUMA_DECAY_PER_S * dtMs) / 1000;
  return next < 0 ? 0 : next > 1 ? 1 : next;
}

/** Adding trauma saturates at 1 — art §2's `trauma ∈ [0,1]`. */
export function addTrauma(trauma: number, amount: number): number {
  const next = trauma + amount;
  return next > 1 ? 1 : next < 0 ? 0 : next;
}

/**
 * The three shake frequencies, in Hz.
 *
 * Deliberately **incommensurate**, so the sum never repeats inside a shake and
 * the camera does not read as vibrating along one axis. Sines rather than a
 * noise table for a reason a screenshot harness cares about: this is a pure
 * function of the accumulated phase, so a captured frame is reproducible.
 */
const SHAKE_HZ: readonly number[] = Object.freeze([13.7, 11.3, 9.1]);

/**
 * Art §2: "offset = trauma² · max 3 u". **Squared**, which is the whole point
 * of a trauma model — a half-full meter shakes at a quarter strength, so small
 * events read as a nudge and the base going up reads as an earthquake.
 */
export function shakeOffsetX(trauma: number, phaseMs: number): number {
  return (
    trauma *
    trauma *
    SHAKE_MAX_U *
    Math.sin((2 * Math.PI * SHAKE_HZ[0] * phaseMs) / 1000)
  );
}

export function shakeOffsetY(trauma: number, phaseMs: number): number {
  return (
    trauma *
    trauma *
    SHAKE_MAX_U *
    Math.sin((2 * Math.PI * SHAKE_HZ[1] * phaseMs) / 1000 + 1.7)
  );
}

/** Art §2: "roll ≤ 0.3°", on the same trauma² curve. */
export function shakeRoll(trauma: number, phaseMs: number): number {
  return (
    trauma *
    trauma *
    SHAKE_MAX_ROLL_RAD *
    Math.sin((2 * Math.PI * SHAKE_HZ[2] * phaseMs) / 1000 + 0.6)
  );
}

// ---------------------------------------------------------------------------
// --- The stage fly-in and its curtain (art §2, §10) ------------------------
// ---------------------------------------------------------------------------

/** Art §2: "600 ms ease from elevated pitch 55° down to 32°". */
export const FLY_IN_MS = 600;
export const FLY_IN_PITCH_RAD = (55 * Math.PI) / 180;
/** Art §10: "twin steel shutters wipe in/out (**300 ms each**)". */
export const CURTAIN_MS = 300;

/**
 * The camera's pitch `ms` into the stage intro, from vertical.
 *
 * Eased out-cubic: the sweep is fastest at the start and settles, which is what
 * makes it read as a camera coming to rest rather than as a linear pan. Exactly
 * {@link FLY_IN_PITCH_RAD} at 0 and exactly {@link CAMERA_PITCH_RAD} at and
 * after {@link FLY_IN_MS} — the endpoints are bit-exact so the rest pose is the
 * one every calibration measured, not a rounding error away from it.
 */
export function flyInPitchAt(ms: number): number {
  if (ms <= 0) return FLY_IN_PITCH_RAD;
  if (ms >= FLY_IN_MS) return CAMERA_PITCH_RAD;
  const t = ms / FLY_IN_MS;
  const k = 1 - (1 - t) ** 3;
  return FLY_IN_PITCH_RAD + (CAMERA_PITCH_RAD - FLY_IN_PITCH_RAD) * k;
}

/**
 * How much of the frame the twin shutters cover, 0 (open) … 1 (shut).
 *
 * Driven by the core's own phase and `phaseT` rather than by an accumulator of
 * this layer's own, so a renderer created mid-intro — which is exactly what
 * happens, since a stage *starts* in `'intro'` — picks the timeline up where
 * the simulation already is.
 *
 * `'intro'` opens; `'cleared'` and `'gameOver'` close. `'baseLost'` does **not**
 * close: that is the slow-mo beat and the player is meant to watch it, and the
 * curtain follows a moment later when the phase turns over.
 */
export function curtainCoverAt(phase: StagePhase, phaseMs: number): number {
  if (phase === 'intro') {
    if (phaseMs >= CURTAIN_MS) return 0;
    return 1 - phaseMs / CURTAIN_MS;
  }
  if (phase === 'cleared' || phase === 'gameOver') {
    if (phaseMs >= CURTAIN_MS) return 1;
    return phaseMs / CURTAIN_MS;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// --- The base-destruction moment (art §2) ----------------------------------
// ---------------------------------------------------------------------------

/** Art §2: "**0.6 s** at **0.25×** presentation speed + slight dolly-in". */
export const SLOW_MO_MS = 600;
export const SLOW_MO_SCALE = 0.25;
/** How far the ortho frustum tightens at the peak of the dolly. */
export const DOLLY_ZOOM = 1.07;
/** The dolly outlasts the slow-mo, easing back out over this long. */
export const DOLLY_RELEASE_MS = 500;

/** 0.25× inside art §2's window, 1 outside it. `-1` means "not running". */
export function slowMoScaleAt(ms: number): number {
  return ms >= 0 && ms < SLOW_MO_MS ? SLOW_MO_SCALE : 1;
}

/**
 * The dolly, 0 … 1, over a window that outlasts the slow-mo. Snapping the
 * frustum back the instant time resumes would read as a cut; easing it out
 * reads as the camera settling.
 */
export function dollyAt(ms: number): number {
  if (ms < 0) return 0;
  if (ms < SLOW_MO_MS) {
    // Ease in over the first third of the beat, then hold.
    const t = Math.min(1, ms / (SLOW_MO_MS / 3));
    return t * t * (3 - 2 * t);
  }
  const out = (ms - SLOW_MO_MS) / DOLLY_RELEASE_MS;
  if (out >= 1) return 0;
  return 1 - out * out * (3 - 2 * out);
}

// ---------------------------------------------------------------------------
// --- Score popups (art §10) ------------------------------------------------
// ---------------------------------------------------------------------------

/** Art §10: "world-space billboards (`+100`), Orbitron 10 u, float up 12 u, fade 700 ms". */
export const POPUP_MS = 700;
export const POPUP_RISE_U = 12;
export const POPUP_GLYPH_H = 10;
/** Glyph advance, i.e. how far apart two characters sit. */
export const POPUP_GLYPH_ADVANCE = 7.2;
/** Most characters one popup can show: `+` plus four digits. */
export const POPUP_MAX_GLYPHS = 5;
/** Popups alive at once. Two players scoring into a crowd is the worst case. */
export const POPUP_SLOTS = 8;

/** How far a popup has risen, `ms` in. Linear — a score is a readout, not a leaf. */
export function popupRiseAt(ms: number): number {
  if (ms <= 0) return 0;
  if (ms >= POPUP_MS) return POPUP_RISE_U;
  return (POPUP_RISE_U * ms) / POPUP_MS;
}

/**
 * Brightness of a popup `ms` in, 1 … 0. Holds for the first 40% and then goes:
 * a score the player has to read must be *readable* before it starts leaving.
 */
export function popupFadeAt(ms: number): number {
  if (ms <= 0) return 1;
  if (ms >= POPUP_MS) return 0;
  const t = ms / POPUP_MS;
  return t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
}

/**
 * Seven-segment masks for `0`–`9`, bit per segment in the order
 * `a b c d e f g` (top, upper-right, lower-right, bottom, lower-left,
 * upper-left, middle).
 *
 * Procedural glyphs, because art §10's Orbitron does not exist in the bundle
 * until T6.3 and a texture would be the project's first. A seven-segment
 * readout is also the right *character* for an arcade score, it is built from
 * the same boxes as everything else in this layer, and it is legible in
 * grayscale — art §11's bar, which a coloured font would still have to clear.
 */
const SEGMENTS: readonly number[] = Object.freeze([
  0b0111111, // 0
  0b0000110, // 1
  0b1011011, // 2
  0b1001111, // 3
  0b1100110, // 4
  0b1101101, // 5
  0b1111101, // 6
  0b0000111, // 7
  0b1111111, // 8
  0b1101111, // 9
]);

/** One box of a glyph: centre and extents, in glyph-local units. */
export interface GlyphBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const STROKE = POPUP_GLYPH_H * 0.16;
const GLYPH_W = POPUP_GLYPH_H * 0.56;
const HALF_H = POPUP_GLYPH_H / 2;
const HALF_W = GLYPH_W / 2;

/** `a b c d e f g`, as boxes in a glyph whose centre is the origin. */
const SEGMENT_BOXES: readonly GlyphBox[] = Object.freeze([
  { x: 0, y: HALF_H, w: GLYPH_W, h: STROKE }, // a — top
  { x: HALF_W, y: HALF_H / 2, w: STROKE, h: HALF_H }, // b — upper right
  { x: HALF_W, y: -HALF_H / 2, w: STROKE, h: HALF_H }, // c — lower right
  { x: 0, y: -HALF_H, w: GLYPH_W, h: STROKE }, // d — bottom
  { x: -HALF_W, y: -HALF_H / 2, w: STROKE, h: HALF_H }, // e — lower left
  { x: -HALF_W, y: HALF_H / 2, w: STROKE, h: HALF_H }, // f — upper left
  { x: 0, y: 0, w: GLYPH_W, h: STROKE }, // g — middle
]);

/** The `+` art §10 puts in front of every score. */
const PLUS_BOXES: readonly GlyphBox[] = Object.freeze([
  { x: 0, y: 0, w: GLYPH_W * 0.8, h: STROKE },
  { x: 0, y: 0, w: STROKE, h: GLYPH_W * 0.8 },
]);

/**
 * The boxes that draw one character. `-1` is the plus sign; `0`–`9` are digits.
 * Pure and exported so the test can assert every digit is distinguishable
 * without a renderer.
 */
export function glyphBoxes(code: number): readonly GlyphBox[] {
  if (code === PLUS_CODE) return PLUS_BOXES;
  if (code < 0 || code > 9) return EMPTY_BOXES;
  const mask = SEGMENTS[code];
  const out: GlyphBox[] = [];
  for (let i = 0; i < SEGMENT_BOXES.length; i++) {
    if ((mask & (1 << i)) !== 0) out.push(SEGMENT_BOXES[i]);
  }
  return out;
}

export const PLUS_CODE = -1;
const EMPTY_BOXES: readonly GlyphBox[] = Object.freeze([]);

/**
 * Writes `+points` into `out` as glyph codes, most significant first, and
 * returns how many were written. Clamped to {@link POPUP_MAX_GLYPHS}; a score
 * too big to show becomes its four lowest digits rather than overflowing the
 * buffer, which is what an arcade readout does anyway.
 */
export function popupGlyphs(points: number, out: Int8Array): number {
  const value = Math.max(0, Math.round(points));
  let digits = 1;
  for (let v = value; v >= 10; v = Math.floor(v / 10)) digits++;
  if (digits > POPUP_MAX_GLYPHS - 1) digits = POPUP_MAX_GLYPHS - 1;
  out[0] = PLUS_CODE;
  let scale = 1;
  for (let i = 1; i < digits; i++) scale *= 10;
  let rest = value;
  for (let i = 0; i < digits; i++) {
    out[i + 1] = Math.floor(rest / scale) % 10;
    rest %= scale;
    scale /= 10;
  }
  return digits + 1;
}

// ---------------------------------------------------------------------------
// --- The view --------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Art §11's accessibility switches, as far as the camera layer is concerned. */
export interface CameraFxFlags {
  /** `prefers-reduced-motion` or the settings toggle. */
  reducedMotion: boolean;
  /** The dedicated `reducedFlash` setting. Not a camera concern; carried so
   *  `renderer.setFxFlags` can hand one object to both layers. */
  reducedFlash: boolean;
  /**
   * GDD §10's screen-shake toggle — art §2's "Disabled by reduced-motion **or
   * setting**", and until T6.1 only the first half of that sentence was wired.
   * Narrower than `reducedMotion`: turning shake off leaves the slow-mo beat
   * and the stage fly-in alone, because neither of those is a shake.
   */
  screenShake: boolean;
}

/** What the capture harness reads back. One shared object; never allocated. */
export interface CameraFxStats {
  trauma: number;
  offsetX: number;
  offsetY: number;
  rollDeg: number;
  pitchDeg: number;
  timeScale: number;
  zoom: number;
  curtain: number;
  popups: number;
}

export interface CameraFx {
  /**
   * One frame, on the **unscaled** clock. Call it before `gl.render`: it is
   * what poses the camera. `dtMs` is zeroed on a paused frame by
   * {@link animDtOf}, so a pause freezes the shake with the board.
   */
  update(state: GameState, dtMs: number): void;
  onEvent(e: GameEvent): void;
  setFlags(flags: CameraFxFlags): void;
  /**
   * Multiplier the presentation layers' `dtMs` must be scaled by this frame —
   * art §2's base-destruction beat. Always 1 under reduced motion.
   */
  timeScale(): number;
  stats(): CameraFxStats;
  dispose(): void;
}

export const DEFAULT_CAMERA_FX_FLAGS: CameraFxFlags = Object.freeze({
  reducedMotion: false,
  reducedFlash: false,
  screenShake: true,
});

/** Height a popup is born at, over the thing that scored. */
const POPUP_Y = 14;
/** Half a bullet — `scoreAwarded` carries the killing bullet's own corner. */
const HALF_BULLET = 2;

export function createCameraFx(
  materials: Materials,
  sceneRoot: SceneRoot,
  flags: CameraFxFlags = DEFAULT_CAMERA_FX_FLAGS,
): CameraFx {
  const group = new Group();
  sceneRoot.entities.add(group);

  // --- the curtain: two shutters, one draw call ----------------------------
  // An `InstancedMesh` with two instances rather than two `Mesh`es, because the
  // shutters move independently but are the same steel: two objects would be
  // two draws for one wipe. Parented to the camera, like the FX screen flash.
  const quad = createUnitQuad();
  const shutters = new InstancedMesh(quad, materials.curtain, 2);
  shutters.count = 0;
  shutters.instanceMatrix.setUsage(DynamicDrawUsage);
  shutters.frustumCulled = false;
  shutters.castShadow = false;
  shutters.receiveShadow = false;
  shutters.renderOrder = 9000; // under the FX screen flash, over everything else
  sceneRoot.camera.add(shutters);

  // --- score popups --------------------------------------------------------
  const glyphBox = createGlyphGeometry();
  const popups = new InstancedMesh(
    glyphBox,
    materials.popup,
    POPUP_SLOTS * POPUP_MAX_GLYPHS * 7,
  );
  popups.count = 0;
  popups.instanceMatrix.setUsage(DynamicDrawUsage);
  popups.frustumCulled = false;
  popups.castShadow = false;
  popups.receiveShadow = false;
  group.add(popups);

  // --- scratch, reused for the life of the view ----------------------------
  const basis = new Float64Array(9);
  const colour = new Color();
  const codes = new Int8Array(POPUP_MAX_GLYPHS);
  const statsOut: CameraFxStats = {
    trauma: 0,
    offsetX: 0,
    offsetY: 0,
    rollDeg: 0,
    pitchDeg: 0,
    timeScale: 1,
    zoom: 1,
    curtain: 0,
    popups: 0,
  };
  {
    // Art §2 fixes the camera, so a billboard is a constant rather than a
    // per-frame `lookAt` — the same basis `tankView.ts` and `propView.ts` use.
    const c = Math.cos(BILLBOARD_X);
    const s = Math.sin(BILLBOARD_X);
    basis[0] = 1;
    basis[4] = c;
    basis[7] = s;
    basis[5] = -s;
    basis[8] = c;
  }

  // Popup pool: fixed slots, oldest evicted, allocated once.
  const popAge = new Float32Array(POPUP_SLOTS).fill(-1);
  const popX = new Float32Array(POPUP_SLOTS);
  const popY = new Float32Array(POPUP_SLOTS);
  const popZ = new Float32Array(POPUP_SLOTS);
  const popPoints = new Int32Array(POPUP_SLOTS);

  let current: CameraFxFlags = flags;
  let trauma = 0;
  let shakePhaseMs = 0;
  /** ms since `baseDestroyed`, or −1. Runs on the unscaled clock. */
  let beatMs = -1;
  let scale = 1;

  /** Where the shake is measured from: the player's tank, else the board's centre. */
  let subjectX = 104;
  let subjectZ = 104;

  function addPopup(x: number, z: number, points: number): void {
    let slot = -1;
    for (let i = 0; i < POPUP_SLOTS; i++) {
      if (popAge[i] < 0) {
        slot = i;
        break;
      }
    }
    if (slot === -1) {
      // Full: the oldest goes. A score popup is information (art §11), so the
      // newest is never the one dropped.
      let oldest = 0;
      for (let i = 1; i < POPUP_SLOTS; i++) {
        if (popAge[i] > popAge[oldest]) oldest = i;
      }
      slot = oldest;
    }
    popAge[slot] = 0;
    popX[slot] = x;
    popY[slot] = POPUP_Y;
    popZ[slot] = z;
    popPoints[slot] = points;
  }

  function writePopups(dtMs: number): void {
    let used = 0;
    let live = 0;
    for (let i = 0; i < POPUP_SLOTS; i++) {
      if (popAge[i] < 0) continue;
      popAge[i] += dtMs;
      if (popAge[i] >= POPUP_MS) {
        popAge[i] = -1;
        continue;
      }
      live++;
      const ms = popAge[i];
      const n = popupGlyphs(popPoints[i], codes);
      const fade = popupFadeAt(ms);
      const y = popY[i] + popupRiseAt(ms);
      // Centred on the thing that scored, so a `+400` does not hang off it.
      const left = -((n - 1) * POPUP_GLYPH_ADVANCE) / 2;
      for (let g = 0; g < n; g++) {
        const boxes = glyphBoxes(codes[g]);
        for (let b = 0; b < boxes.length; b++) {
          if (used >= popups.instanceMatrix.count) break;
          const box = boxes[b];
          // A glyph is authored in x (right) / y (up), but the billboard basis
          // this layer shares maps local **−z** to screen up and local +y
          // straight at the camera (`tankView.ts`'s spawn star, same basis).
          // So the glyph's own up goes into −z and its height into the depth
          // extent. Getting this wrong is not subtle and was not: every stroke
          // of every digit collapsed onto one horizontal line, and `+400`
          // photographed as a white bar.
          writePartMatrix(
            popups,
            used,
            basis,
            popX[i],
            y,
            popZ[i],
            left + g * POPUP_GLYPH_ADVANCE + box.x,
            0,
            -box.y,
            box.w,
            STROKE,
            box.h,
          );
          colour.setRGB(fade, fade, fade);
          popups.setColorAt(used, colour);
          used++;
        }
      }
    }
    popups.count = used;
    if (used > 0) {
      popups.instanceMatrix.clearUpdateRanges();
      popups.instanceMatrix.addUpdateRange(0, used * 16);
      popups.instanceMatrix.needsUpdate = true;
      if (popups.instanceColor !== null) {
        popups.instanceColor.clearUpdateRanges();
        popups.instanceColor.addUpdateRange(0, used * 3);
        popups.instanceColor.needsUpdate = true;
      }
    }
    statsOut.popups = live;
  }

  function writeCurtain(cover: number): void {
    if (cover <= 0) {
      shutters.count = 0;
      return;
    }
    const camera = sceneRoot.camera;
    // Sized from the live frustum rather than from a resize hook, for the same
    // reason the FX screen flash is: two multiplications on the frames it is
    // visible beat a cached number that can go stale.
    const halfW = (camera.right - camera.left) / 2;
    const halfH = (camera.top - camera.bottom) / 2;
    const z = -(camera.near + 2);
    // Each shutter is half the frame tall and slides in from its own edge.
    // Written straight into the instance matrix rather than through
    // `writePartMatrix`: a shutter is parented to the CAMERA, so its local
    // space is already screen space — axis-aligned, no basis, no billboard.
    const travel = halfH * (1 - cover);
    const e = shutters.instanceMatrix.array as Float32Array;
    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? 1 : -1;
      const o = i * 16;
      e[o] = halfW * 2;
      e[o + 1] = 0;
      e[o + 2] = 0;
      e[o + 3] = 0;
      e[o + 4] = 0;
      // Signed, so the quad's vertex gradient flips with the panel and both
      // lips face the seam. `DoubleSide` on the material is what makes the
      // inverted winding this produces still draw.
      e[o + 5] = dir * halfH;
      e[o + 6] = 0;
      e[o + 7] = 0;
      e[o + 8] = 0;
      e[o + 9] = 0;
      e[o + 10] = 1;
      e[o + 11] = 0;
      e[o + 12] = 0;
      e[o + 13] = dir * (halfH / 2 + travel);
      e[o + 14] = z;
      e[o + 15] = 1;
    }
    shutters.count = 2;
    shutters.instanceMatrix.needsUpdate = true;
  }

  return {
    update(state: GameState, dtMs: number): void {
      // A paused field is a still picture (art §9), and the camera is how it is
      // looked at: a shake that keeps running over a frozen board reads as a
      // bug in exactly the way scrolling tracks did at T3.1.
      const dt = animDtOf(state, dtMs);

      // The player's own tank is what "nearby" is measured from. Slot 0 is
      // player 1 forever (`players.ts`); falling back to the board's centre
      // keeps a 2P-less or dead-player frame from measuring against (0, 0).
      const tanks = state.tanks;
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (tank.kind === 'player' && tank.alive) {
          subjectX = tank.x + 8;
          subjectZ = tank.y + 8;
          break;
        }
      }

      const reduced = current.reducedMotion;
      // Art §2: shake is "disabled by reduced-motion/setting" — two sources,
      // one behaviour, and either one alone is enough to switch it off.
      const shakes = !reduced && current.screenShake;

      trauma = shakes ? traumaAfter(trauma, dt) : 0;
      shakePhaseMs += dt;
      const offsetX = trauma > 0 ? shakeOffsetX(trauma, shakePhaseMs) : 0;
      const offsetY = trauma > 0 ? shakeOffsetY(trauma, shakePhaseMs) : 0;
      const roll = trauma > 0 ? shakeRoll(trauma, shakePhaseMs) : 0;

      if (beatMs >= 0) {
        beatMs += dt;
        if (beatMs >= SLOW_MO_MS + DOLLY_RELEASE_MS) beatMs = -1;
      }
      scale = reduced ? 1 : slowMoScaleAt(beatMs);
      const zoom = reduced ? 1 : 1 + (DOLLY_ZOOM - 1) * dollyAt(beatMs);

      const phaseMs = state.phaseT * 1000;
      // Art §11 lists shake, slow-mo and screen flash. The fly-in is not on
      // that list, but a 23° camera sweep is the canonical vestibular trigger
      // `prefers-reduced-motion` exists for and it carries no gameplay
      // information at all — the curtain still wipes, so the beat still reads.
      // Flagged in the T4.3 report for ratification rather than assumed.
      const pitch =
        reduced || state.phase !== 'intro'
          ? CAMERA_PITCH_RAD
          : flyInPitchAt(phaseMs);

      sceneRoot.setCameraPose(pitch, offsetX, offsetY, roll, zoom);
      writeCurtain(curtainCoverAt(state.phase, phaseMs));
      writePopups(dt);

      statsOut.trauma = trauma;
      statsOut.offsetX = offsetX;
      statsOut.offsetY = offsetY;
      statsOut.rollDeg = (roll * 180) / Math.PI;
      statsOut.pitchDeg = (pitch * 180) / Math.PI;
      statsOut.timeScale = scale;
      statsOut.zoom = zoom;
      statsOut.curtain = curtainCoverAt(state.phase, phaseMs);
    },

    onEvent(e: GameEvent): void {
      switch (e.t) {
        case 'shotFired':
          // Art §2: "**own** shot +0.05". An enemy's gun does not shake the
          // player's camera, or a busy board would never stop moving.
          if (e.byPlayer) trauma = addTrauma(trauma, TRAUMA.ownShot);
          break;
        case 'tankDestroyed':
          trauma = addTrauma(
            trauma,
            TRAUMA.explosion *
              nearbyFalloff(Math.hypot(e.x - subjectX, e.y - subjectZ)),
          );
          break;
        case 'baseDestroyed':
          trauma = addTrauma(trauma, TRAUMA.base);
          // Art §2's base-destruction moment. The simulation's own scripted
          // lock is core's (`phase = 'baseLost'`); this is only the picture.
          beatMs = 0;
          break;
        case 'scoreAwarded':
          addPopup(e.x + HALF_BULLET, e.y + HALF_BULLET, e.points);
          break;
        default:
          break;
      }
    },

    setFlags(next: CameraFxFlags): void {
      current = next;
      if (!next.screenShake) {
        // Drop the trauma already banked, or turning the setting off mid-blast
        // would still shake for the ~0.8 s the decay takes.
        trauma = 0;
      }
      if (next.reducedMotion) {
        trauma = 0;
        beatMs = -1;
        scale = 1;
      }
    },

    timeScale(): number {
      return scale;
    },

    stats(): CameraFxStats {
      return statsOut;
    },

    dispose(): void {
      group.removeFromParent();
      shutters.removeFromParent();
      shutters.dispose();
      popups.dispose();
      quad.dispose();
      glyphBox.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// --- Geometry --------------------------------------------------------------
// ---------------------------------------------------------------------------

/** The lip's gain against the plate's, as multipliers on the steel token. */
const SHUTTER_LIP = 1.35;
const SHUTTER_PLATE = 0.4;

/**
 * A 1×1 quad in the XY plane facing +z — one shutter, scaled to the frustum.
 *
 * Its vertex colours run **bright at local −y, dark at +y**, which is the whole
 * of art §10's "twin steel shutters": each panel is written with a y scale of
 * `±halfH`, so local −y is whichever edge faces the middle of the screen and
 * both panels get a bright lip along the seam they meet at. Without it the
 * curtain is one flat grey rectangle and reads as a blank screen rather than as
 * two plates closing.
 */
function createUnitQuad(): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], // prettier-ignore
      3,
    ),
  );
  geo.setAttribute(
    'normal',
    new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3), // prettier-ignore
  );
  const lip = SHUTTER_LIP;
  const plate = SHUTTER_PLATE;
  geo.setAttribute(
    'color',
    new Float32BufferAttribute(
      [lip, lip, lip, lip, lip, lip, plate, plate, plate, lip, lip, lip, plate, plate, plate, plate, plate, plate], // prettier-ignore
      3,
    ),
  );
  return geo;
}

/**
 * One segment of a glyph: a unit box in the XY plane, thin in z.
 *
 * The same "one primitive, scaled" idiom the whole entity layer is built on
 * (models.ts) — every stroke of every digit of every popup is one instance of
 * this, so the score readout is a single draw call however much is on screen.
 */
function createGlyphGeometry(): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const h = 0.5;
  const face = (ax: number, s: number): void => {
    const o1 = (ax + 1) % 3;
    const o2 = (ax + 2) % 3;
    const corner = (u: number, v: number): number[] => {
      const p = [0, 0, 0];
      p[ax] = s * h;
      p[o1] = u * h;
      p[o2] = v * h;
      return p;
    };
    const q =
      s > 0
        ? [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
        : [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
    for (const tri of [
      [q[0], q[1], q[2]],
      [q[0], q[2], q[3]],
    ]) {
      for (const v of tri) {
        pos.push(v[0], v[1], v[2]);
        const n = [0, 0, 0];
        n[ax] = s;
        nrm.push(n[0], n[1], n[2]);
      }
    }
  };
  for (let ax = 0; ax < 3; ax++) {
    face(ax, 1);
    face(ax, -1);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  return geo;
}
