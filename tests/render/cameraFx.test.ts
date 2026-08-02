// tests/render/cameraFx.test.ts — art §2's camera rig and art §10's two
// screen-space beats (T4.3), in the Vitest **node** environment. Same reach as
// `fxSystem.test.ts`: no DOM and no WebGL, so everything here is a pure curve,
// an `InstancedMesh` or an `OrthographicCamera` — none of which needs a GL
// context.
//
// What is NOT here: whether a shake *feels* like an impact, or whether the
// fly-in lands. `scripts/capture-fx.ts` photographs those.
//
// What IS here is every number art §2 and §10 authored, asserted against the
// doc rather than against a re-statement of the code — and the two contracts a
// screenshot cannot check: that reduced motion removes the motion and nothing
// else, and that a paused frame is a frozen frame.

import { describe, expect, it } from 'vitest';

import { InstancedMesh, OrthographicCamera } from 'three';

import { createGame } from '../../src/core/game';
import type { GameEvent } from '../../src/core/events';
import type { GameState, LevelData } from '../../src/core/types';
import { createMaterials, type Materials } from '../../src/render/materials';
import {
  CAMERA_PITCH_RAD,
  createSceneRoot,
  type SceneRoot,
} from '../../src/render/sceneRoot';
import {
  CURTAIN_MS,
  DEFAULT_CAMERA_FX_FLAGS,
  DOLLY_ZOOM,
  FLY_IN_MS,
  FLY_IN_PITCH_RAD,
  NEARBY_FULL_U,
  NEARBY_NONE_U,
  PLUS_CODE,
  POPUP_MAX_GLYPHS,
  POPUP_MS,
  POPUP_RISE_U,
  SHAKE_MAX_ROLL_RAD,
  SHAKE_MAX_U,
  SLOW_MO_MS,
  SLOW_MO_SCALE,
  TRAUMA,
  TRAUMA_DECAY_PER_S,
  addTrauma,
  createCameraFx,
  curtainCoverAt,
  dollyAt,
  flyInPitchAt,
  glyphBoxes,
  nearbyFalloff,
  popupFadeAt,
  popupGlyphs,
  popupRiseAt,
  shakeOffsetX,
  shakeOffsetY,
  shakeRoll,
  slowMoScaleAt,
  traumaAfter,
  type CameraFx,
} from '../../src/render/cameraFx';
import { DEFAULT_FX_FLAGS, createFxSystem } from '../../src/render/fx/fxSystem';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;
const DEG = 180 / Math.PI;

function game(): GameState {
  const state = createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 });
  // Every test that is not *about* the intro wants the rest pose.
  state.phase = 'playing';
  state.phaseT = 0;
  return state;
}

interface Mounted {
  fx: CameraFx;
  materials: Materials;
  root: SceneRoot;
  camera: OrthographicCamera;
  dispose(): void;
}

function mount(): Mounted {
  const materials = createMaterials();
  const root = createSceneRoot(materials);
  const fx = createCameraFx(materials, root, { ...DEFAULT_CAMERA_FX_FLAGS });
  root.setViewport(1600, 900);
  return {
    fx,
    materials,
    root,
    camera: root.camera,
    dispose(): void {
      fx.dispose();
      root.dispose();
      materials.dispose();
    },
  };
}

/** The two shutters, which live on the camera rather than in `entities`. */
function shuttersOf(m: Mounted): InstancedMesh {
  const found: InstancedMesh[] = [];
  m.camera.traverse((o) => {
    if (o instanceof InstancedMesh) found.push(o);
  });
  expect(found).toHaveLength(1);
  return found[0];
}

// ---------------------------------------------------------------------------

describe('trauma (art §2)', () => {
  it('decays at 1.2 per second', () => {
    expect(TRAUMA_DECAY_PER_S).toBe(1.2);
    // A full meter is spent in exactly 1/1.2 s.
    expect(traumaAfter(1, 500)).toBeCloseTo(0.4, 10);
    expect(traumaAfter(1, 833.4)).toBe(0);
    expect(traumaAfter(1, 5000)).toBe(0);
    // Decay is on the trauma, not on the offset — that is what makes "1.2/s"
    // mean what it says rather than something a square root away from it.
    expect(traumaAfter(0.5, 1000 / 1.2)).toBe(0);
  });

  it('saturates at 1 and never goes negative', () => {
    expect(addTrauma(0.9, 0.6)).toBe(1);
    expect(addTrauma(0.1, -0.5)).toBe(0);
    expect(traumaAfter(0.05, 0)).toBe(0.05);
  });

  it('carries art §2’s three sources verbatim', () => {
    expect(TRAUMA.ownShot).toBe(0.05);
    expect(TRAUMA.explosion).toBe(0.25);
    expect(TRAUMA.base).toBe(0.6);
    // The ranking is the point: the base going up must dominate a firefight.
    expect(TRAUMA.base).toBeGreaterThan(TRAUMA.explosion * 2);
  });

  it('offsets by trauma² and never past 3 u', () => {
    expect(SHAKE_MAX_U).toBe(3);
    for (const trauma of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      for (let ms = 0; ms < 400; ms += 3) {
        expect(Math.abs(shakeOffsetX(trauma, ms))).toBeLessThanOrEqual(
          SHAKE_MAX_U + 1e-9,
        );
        expect(Math.abs(shakeOffsetY(trauma, ms))).toBeLessThanOrEqual(
          SHAKE_MAX_U + 1e-9,
        );
      }
    }
    // **Squared**, not linear: half a meter is a quarter of the shake, which is
    // what makes a shot a nudge and the base an earthquake.
    const peakOf = (trauma: number): number => {
      let peak = 0;
      for (let ms = 0; ms < 500; ms += 0.5) {
        peak = Math.max(peak, Math.abs(shakeOffsetX(trauma, ms)));
      }
      return peak;
    };
    expect(peakOf(0.5) / peakOf(1)).toBeCloseTo(0.25, 2);
  });

  it('rolls no more than art §2’s 0.3°', () => {
    expect(SHAKE_MAX_ROLL_RAD * DEG).toBeCloseTo(0.3, 10);
    for (let ms = 0; ms < 500; ms += 1) {
      expect(Math.abs(shakeRoll(1, ms) * DEG)).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });

  it('shakes on more than one axis at more than one rate', () => {
    // A single frequency reads as a vibration along a line rather than as an
    // impact. The three sines are incommensurate, so x and y must diverge.
    let sameSign = 0;
    for (let ms = 0; ms < 1000; ms += 7) {
      if (Math.sign(shakeOffsetX(1, ms)) === Math.sign(shakeOffsetY(1, ms))) {
        sameSign++;
      }
    }
    expect(sameSign).toBeGreaterThan(20);
    expect(sameSign).toBeLessThan(123);
  });

  it('falls off with distance, because 208 u is a long way', () => {
    expect(nearbyFalloff(0)).toBe(1);
    expect(nearbyFalloff(NEARBY_FULL_U)).toBe(1);
    expect(nearbyFalloff(NEARBY_NONE_U)).toBe(0);
    expect(nearbyFalloff(300)).toBe(0);
    expect(nearbyFalloff((NEARBY_FULL_U + NEARBY_NONE_U) / 2)).toBeCloseTo(
      0.5,
      10,
    );
  });
});

describe('the stage fly-in (art §2)', () => {
  it('eases 55° → 32° over 600 ms, with exact endpoints', () => {
    expect(FLY_IN_MS).toBe(600);
    expect(FLY_IN_PITCH_RAD * DEG).toBeCloseTo(55, 10);
    expect(flyInPitchAt(0)).toBe(FLY_IN_PITCH_RAD);
    // Bit-exact at the end: the rest pose is the one every art §6 calibration
    // measured, and "a rounding error away from 32°" is not that pose.
    expect(flyInPitchAt(FLY_IN_MS)).toBe(CAMERA_PITCH_RAD);
    expect(flyInPitchAt(10_000)).toBe(CAMERA_PITCH_RAD);
    expect(CAMERA_PITCH_RAD * DEG).toBeCloseTo(32, 10);
  });

  it('is monotonic and front-loaded', () => {
    let previous = flyInPitchAt(0);
    for (let ms = 10; ms <= FLY_IN_MS; ms += 10) {
      const next = flyInPitchAt(ms);
      expect(next).toBeLessThanOrEqual(previous + 1e-12);
      previous = next;
    }
    // Out-cubic: half the sweep is done well before half the time.
    const half = (FLY_IN_PITCH_RAD + CAMERA_PITCH_RAD) / 2;
    expect(flyInPitchAt(FLY_IN_MS / 2)).toBeLessThan(half);
  });
});

describe('the curtain (art §10)', () => {
  it('wipes 300 ms in and 300 ms out', () => {
    expect(CURTAIN_MS).toBe(300);
    // Intro: shut at the start, fully open by 300 ms — synced with the fly-in,
    // which is still going for another 300.
    expect(curtainCoverAt('intro', 0)).toBe(1);
    expect(curtainCoverAt('intro', 150)).toBeCloseTo(0.5, 10);
    expect(curtainCoverAt('intro', CURTAIN_MS)).toBe(0);
    expect(curtainCoverAt('intro', 2000)).toBe(0);
    // Outro: the reverse.
    for (const phase of ['cleared', 'gameOver'] as const) {
      expect(curtainCoverAt(phase, 0)).toBe(0);
      expect(curtainCoverAt(phase, 150)).toBeCloseTo(0.5, 10);
      expect(curtainCoverAt(phase, CURTAIN_MS)).toBe(1);
    }
  });

  it('stays open through play and through the base-destruction beat', () => {
    expect(curtainCoverAt('playing', 500)).toBe(0);
    // `baseLost` is the moment art §2 asks the player to watch. Shutting the
    // curtain over it would hide the thing the slow-mo exists to show.
    expect(curtainCoverAt('baseLost', 0)).toBe(0);
    expect(curtainCoverAt('baseLost', 3000)).toBe(0);
  });
});

describe('the base-destruction moment (art §2)', () => {
  it('runs 0.6 s at 0.25× and then stops', () => {
    expect(SLOW_MO_MS).toBe(600);
    expect(SLOW_MO_SCALE).toBe(0.25);
    expect(slowMoScaleAt(-1)).toBe(1); // not running
    expect(slowMoScaleAt(0)).toBe(SLOW_MO_SCALE);
    expect(slowMoScaleAt(599)).toBe(SLOW_MO_SCALE);
    expect(slowMoScaleAt(600)).toBe(1);
  });

  it('dollies in and eases back out past the end of the slow-mo', () => {
    expect(dollyAt(-1)).toBe(0);
    expect(dollyAt(0)).toBe(0);
    expect(dollyAt(SLOW_MO_MS / 2)).toBe(1); // held
    // Snapping the frustum back the instant time resumes would read as a cut.
    expect(dollyAt(SLOW_MO_MS)).toBe(1);
    expect(dollyAt(SLOW_MO_MS + 250)).toBeGreaterThan(0);
    expect(dollyAt(SLOW_MO_MS + 500)).toBe(0);
    expect(dollyAt(99_999)).toBe(0);
  });
});

describe('score popups (art §10)', () => {
  it('floats up 12 u and fades over 700 ms', () => {
    expect(POPUP_MS).toBe(700);
    expect(POPUP_RISE_U).toBe(12);
    expect(popupRiseAt(0)).toBe(0);
    expect(popupRiseAt(POPUP_MS)).toBe(POPUP_RISE_U);
    expect(popupRiseAt(POPUP_MS / 2)).toBeCloseTo(POPUP_RISE_U / 2, 10);
    expect(popupFadeAt(0)).toBe(1);
    // Holds while it is being read, then goes.
    expect(popupFadeAt(POPUP_MS * 0.3)).toBe(1);
    expect(popupFadeAt(POPUP_MS)).toBe(0);
    expect(popupFadeAt(POPUP_MS * 0.7)).toBeLessThan(1);
  });

  it('spells every score the core can award', () => {
    const out = new Int8Array(POPUP_MAX_GLYPHS);
    // fidelity §13's four enemy values, plus the grenade's multiples.
    for (const [points, expected] of [
      [100, [PLUS_CODE, 1, 0, 0]],
      [200, [PLUS_CODE, 2, 0, 0]],
      [300, [PLUS_CODE, 3, 0, 0]],
      [400, [PLUS_CODE, 4, 0, 0]],
      [0, [PLUS_CODE, 0]],
      [7, [PLUS_CODE, 7]],
      [1600, [PLUS_CODE, 1, 6, 0, 0]],
    ] as const) {
      const n = popupGlyphs(points, out);
      expect(Array.from(out.slice(0, n)), String(points)).toEqual(
        Array.from(expected),
      );
      expect(n).toBeLessThanOrEqual(POPUP_MAX_GLYPHS);
    }
  });

  it('never overruns its glyph buffer', () => {
    const out = new Int8Array(POPUP_MAX_GLYPHS);
    for (const points of [99_999, 1_000_000, -5]) {
      const n = popupGlyphs(points, out);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(POPUP_MAX_GLYPHS);
    }
  });

  it('draws ten distinguishable digits plus a sign', () => {
    // Seven-segment, so the check that matters is that no two digits share a
    // stroke set — art §11's "silhouette before colour", applied to a readout.
    const shapes = new Set<string>();
    for (let d = 0; d <= 9; d++) {
      const boxes = glyphBoxes(d);
      expect(boxes.length, `digit ${d}`).toBeGreaterThan(1);
      shapes.add(JSON.stringify(boxes));
    }
    expect(shapes.size).toBe(10);
    expect(glyphBoxes(PLUS_CODE)).toHaveLength(2);
    expect(glyphBoxes(42)).toHaveLength(0);
  });
});

describe('CameraFx — the assembled layer', () => {
  it('rests at art §2’s 32° with the camera untouched', () => {
    const m = mount();
    m.fx.update(game(), 16);
    expect(m.fx.stats().pitchDeg).toBeCloseTo(32, 6);
    expect(m.fx.stats().trauma).toBe(0);
    expect(m.fx.stats().offsetX).toBe(0);
    expect(m.fx.stats().zoom).toBe(1);
    expect(m.camera.zoom).toBe(1);
    m.dispose();
  });

  it('flies in during the intro and only during the intro', () => {
    const m = mount();
    const state = game();
    state.phase = 'intro';
    state.phaseT = 0;
    m.fx.update(state, 16);
    expect(m.fx.stats().pitchDeg).toBeCloseTo(55, 6);
    // Higher pitch means a more oblique view: the camera is further south and
    // lower, which is what "elevated" looks like from the rig's own geometry.
    const high = m.camera.position.z;
    state.phaseT = FLY_IN_MS / 1000;
    m.fx.update(state, 16);
    expect(m.fx.stats().pitchDeg).toBeCloseTo(32, 6);
    expect(m.camera.position.z).toBeLessThan(high);
    // Nothing outside the intro moves it.
    state.phase = 'playing';
    state.phaseT = 0;
    m.fx.update(state, 16);
    expect(m.fx.stats().pitchDeg).toBeCloseTo(32, 6);
    m.dispose();
  });

  it('shows the shutters only while a wipe is running', () => {
    const m = mount();
    const shutters = shuttersOf(m);
    const state = game();
    state.phase = 'intro';
    state.phaseT = 0;
    m.fx.update(state, 16);
    expect(shutters.count).toBe(2); // shut
    state.phaseT = 1; // 1 s in — long open
    m.fx.update(state, 16);
    expect(shutters.count).toBe(0); // no draw call at all
    state.phase = 'gameOver';
    state.phaseT = CURTAIN_MS / 1000;
    m.fx.update(state, 16);
    expect(shutters.count).toBe(2);
    m.dispose();
  });

  it('takes trauma from art §2’s three sources and nothing else', () => {
    const shot: GameEvent = {
      t: 'shotFired',
      tankId: 0,
      x: 100,
      y: 100,
      dir: 0,
      byPlayer: true,
    };
    const enemyShot: GameEvent = { ...shot, byPlayer: false };

    const m = mount();
    const state = game();
    m.fx.update(state, 0);
    m.fx.onEvent(shot);
    m.fx.update(state, 0);
    expect(m.fx.stats().trauma).toBeCloseTo(TRAUMA.ownShot, 10);

    // An enemy firing must NOT shake the player's camera — art §2 says "own
    // shot", and a board with four enemies would otherwise never settle.
    m.fx.onEvent(enemyShot);
    m.fx.update(state, 0);
    expect(m.fx.stats().trauma).toBeCloseTo(TRAUMA.ownShot, 10);
    m.dispose();
  });

  it('shakes harder for a close explosion than a far one', () => {
    const at = (x: number, y: number): number => {
      const m = mount();
      const state = game();
      // Player 1 sits at its spawn; place the kill relative to it.
      m.fx.update(state, 0);
      m.fx.onEvent({
        t: 'tankDestroyed',
        tankId: 5,
        kind: 'enemy',
        enemyType: 'basic',
        points: 100,
        x,
        y,
      });
      m.fx.update(state, 0);
      const trauma = m.fx.stats().trauma;
      m.dispose();
      return trauma;
    };
    const player = createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 })
      .tanks[0];
    const near = at(player.x + 8, player.y + 8);
    const far = at(player.x + 8, player.y + 8 + NEARBY_NONE_U + 10);
    expect(near).toBeCloseTo(TRAUMA.explosion, 10);
    expect(far).toBe(0);
  });

  it('gives the base the biggest jolt and starts the slow-mo', () => {
    const m = mount();
    const state = game();
    m.fx.update(state, 0);
    expect(m.fx.timeScale()).toBe(1);

    m.fx.onEvent({ t: 'baseDestroyed' });
    m.fx.update(state, 0);
    expect(m.fx.stats().trauma).toBeCloseTo(TRAUMA.base, 10);
    expect(m.fx.timeScale()).toBe(SLOW_MO_SCALE);
    expect(m.fx.stats().zoom).toBe(1); // the dolly eases in, never snaps

    // Mid-beat: still slow, and now dollied.
    m.fx.update(state, SLOW_MO_MS / 2);
    expect(m.fx.timeScale()).toBe(SLOW_MO_SCALE);
    expect(m.fx.stats().zoom).toBeCloseTo(DOLLY_ZOOM, 6);
    expect(m.camera.zoom).toBeCloseTo(DOLLY_ZOOM, 6);

    // Past it: real time again, and the frustum eases back rather than cutting.
    m.fx.update(state, SLOW_MO_MS);
    expect(m.fx.timeScale()).toBe(1);
    expect(m.fx.stats().zoom).toBeGreaterThan(1);
    m.fx.update(state, 10_000);
    expect(m.fx.stats().zoom).toBe(1);
    expect(m.camera.zoom).toBe(1);
    m.dispose();
  });

  it('draws a popup when a score is awarded, and stops after 700 ms', () => {
    const m = mount();
    const state = game();
    const popups = (): InstancedMesh => {
      const found: InstancedMesh[] = [];
      m.root.entities.traverse((o) => {
        if (o instanceof InstancedMesh) found.push(o);
      });
      return found[0];
    };
    m.fx.update(state, 16);
    expect(popups().count).toBe(0);

    m.fx.onEvent({
      t: 'scoreAwarded',
      playerIndex: 0,
      points: 400,
      x: 100,
      y: 100,
    });
    m.fx.update(state, 0);
    // "+400" is a plus sign (2 strokes) and three digits.
    expect(popups().count).toBeGreaterThan(2);
    expect(m.fx.stats().popups).toBe(1);

    m.fx.update(state, POPUP_MS);
    expect(m.fx.stats().popups).toBe(0);
    expect(popups().count).toBe(0);
    m.dispose();
  });

  it('never drops the NEWEST score when the popup pool is full', () => {
    // A score popup is information (art §11), and the one the player is
    // waiting for is the one that just happened.
    const m = mount();
    const state = game();
    m.fx.update(state, 16);
    for (let i = 0; i < 40; i++) {
      m.fx.onEvent({
        t: 'scoreAwarded',
        playerIndex: 0,
        points: 100,
        x: 50 + i,
        y: 50,
      });
    }
    m.fx.update(state, 0);
    expect(m.fx.stats().popups).toBeGreaterThan(0);
    expect(m.fx.stats().popups).toBeLessThanOrEqual(8);
    m.dispose();
  });

  it('freezes every beat while the simulation is paused (art §9)', () => {
    const m = mount();
    const state = game();
    m.fx.onEvent({ t: 'baseDestroyed' });
    m.fx.onEvent({
      t: 'scoreAwarded',
      playerIndex: 0,
      points: 100,
      x: 100,
      y: 100,
    });
    m.fx.update(state, 0);
    const trauma = m.fx.stats().trauma;
    const popups = m.fx.stats().popups;

    state.paused = true;
    for (let i = 0; i < 300; i++) {
      m.fx.update(state, 16); // 4.8 s of real time
    }
    // Nothing moved: the shake did not drain, the beat did not end, the score
    // did not float away. A camera that keeps shaking over a stopped board is
    // the same bug scrolling tracks were at T3.1.
    expect(m.fx.stats().trauma).toBe(trauma);
    expect(m.fx.stats().popups).toBe(popups);
    expect(m.fx.timeScale()).toBe(SLOW_MO_SCALE);

    state.paused = false;
    for (let i = 0; i < 300; i++) {
      m.fx.update(state, 16);
    }
    expect(m.fx.stats().trauma).toBe(0);
    expect(m.fx.stats().popups).toBe(0);
    expect(m.fx.timeScale()).toBe(1);
    m.dispose();
  });
});

describe('reduced motion (art §11, GDD §10)', () => {
  const flags = { reducedMotion: true, reducedFlash: false };

  it('zeroes shake, slow-mo and the dolly', () => {
    const m = mount();
    const state = game();
    m.fx.setFlags(flags);
    m.fx.onEvent({ t: 'baseDestroyed' });
    m.fx.onEvent({
      t: 'shotFired',
      tankId: 0,
      x: 100,
      y: 100,
      dir: 0,
      byPlayer: true,
    });
    m.fx.update(state, 16);
    expect(m.fx.stats().trauma).toBe(0);
    expect(m.fx.stats().offsetX).toBe(0);
    expect(m.fx.stats().offsetY).toBe(0);
    expect(m.fx.stats().rollDeg).toBe(0);
    expect(m.fx.timeScale()).toBe(1);
    expect(m.fx.stats().zoom).toBe(1);
    m.dispose();
  });

  it('drops the fly-in, because a 23° sweep is what the flag is for', () => {
    // Art §11 names shake, slow-mo and flash; the fly-in is not on that list,
    // but it is a camera sweep and it carries no gameplay information. Flagged
    // in the T4.3 report as a deviation for ratification rather than assumed.
    const m = mount();
    const state = game();
    state.phase = 'intro';
    state.phaseT = 0;
    m.fx.setFlags(flags);
    m.fx.update(state, 16);
    expect(m.fx.stats().pitchDeg).toBeCloseTo(32, 6);
    m.dispose();
  });

  it('keeps the curtain, which is a wipe and not a movement', () => {
    const m = mount();
    const state = game();
    state.phase = 'intro';
    state.phaseT = 0;
    m.fx.setFlags(flags);
    m.fx.update(state, 16);
    expect(shuttersOf(m).count).toBe(2);
    m.dispose();
  });

  it('keeps every score popup — it is gameplay information', () => {
    const m = mount();
    const state = game();
    m.fx.setFlags(flags);
    m.fx.update(state, 16);
    m.fx.onEvent({
      t: 'scoreAwarded',
      playerIndex: 0,
      points: 200,
      x: 100,
      y: 100,
    });
    m.fx.update(state, 0);
    expect(m.fx.stats().popups).toBe(1);
    m.dispose();
  });

  it('leaves the FX recipes emitting exactly what they emitted', () => {
    // The implementation-plan line for this task: "reduced-motion flag zeroes
    // shake/slow-mo/flash **but recipes still emit particles**". The camera
    // layer and the particle layer share one flags object, so this is the
    // check that one does not silence the other.
    const death: GameEvent = {
      t: 'tankDestroyed',
      tankId: 5,
      kind: 'player',
      points: 0,
      x: 100,
      y: 100,
    };
    const count = (reduced: boolean): number => {
      const materials = createMaterials();
      const root = createSceneRoot(materials);
      const particles = createFxSystem(materials, root, {
        ...DEFAULT_FX_FLAGS,
        reducedMotion: reduced,
      });
      particles.onEvent(death);
      particles.update(game(), 0);
      const n = particles.stats().particles;
      // …and the screen flash, which IS gated, is the difference.
      expect(materials.fxScreenFlash.opacity > 0).toBe(!reduced);
      particles.dispose();
      root.dispose();
      materials.dispose();
      return n;
    };
    expect(count(true)).toBe(count(false));
    expect(count(true)).toBeGreaterThan(0);
  });
});
