// src/render/renderer.ts — Contract Zero's `Renderer`: owns the WebGL context,
// the scene root and the pooled entity views, and turns one `GameState` plus an
// interpolation alpha into one frame (arch §5).
//
// It **reads** `GameState` and never writes to it. The simulation is the single
// source of truth and nothing flows back up (arch §3.3).

import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import type { GameEvent } from '../core/events';
import type { GameState } from '../core/types';
import { createBulletView, type BulletView } from './bulletView';
import {
  DEFAULT_FX_FLAGS,
  createFxSystem,
  type FxFlags,
  type FxStats,
  type FxSystem,
} from './fx/fxSystem';
import {
  CALIBRATION,
  QUALITY_PRESETS,
  createMaterials,
  type Quality,
} from './materials';
import { animDtOf } from './models';
import { POST_PRESETS, createPostChain, type PostChain } from './post';
import { createPropView, type PropView } from './propView';
import { createSceneRoot, type SceneRoot } from './sceneRoot';
import { createTankView, type TankView } from './tankView';
import { createTerrainView, type TerrainView } from './terrainView';

// `Quality` is declared next to the preset table it indexes (materials.ts) and
// re-exported here, because Contract Zero names `renderer.ts` as its home and a
// type-only re-export is erased at build time — no import cycle, one definition.
export type { Quality } from './materials';

export interface Renderer {
  render(state: GameState, alpha: number, dtMs: number): void;
  onEvent(e: GameEvent): void;
  setQuality(q: Quality): void;
  /**
   * Art §11's accessibility switches, as far as the render layer is concerned
   * (today: "no screen flash"). Separate from `setQuality` because they are a
   * *player's* choice rather than a device's, and they persist independently
   * (`storage.ts`). T4.3 extends the same call with shake and slow-mo.
   */
  setFxFlags(flags: FxFlags): void;
  resize(w: number, h: number): void;
  /** Live particle/light counts — read by `scripts/capture-fx.ts`. */
  fxStats(): FxStats;
  dispose(): void;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  quality: Quality,
): Renderer {
  const materials = createMaterials();
  const sceneRoot: SceneRoot = createSceneRoot(materials);
  const terrain: TerrainView = createTerrainView(materials, sceneRoot);
  const tanks: TankView = createTankView(materials, sceneRoot);
  const bullets: BulletView = createBulletView(materials, sceneRoot);
  const props: PropView = createPropView(materials, sceneRoot);
  // Art §8's VFX. It is last in the list and last in the frame for the same
  // reason: every particle is additive or blended, so it must be submitted
  // after the opaque board it sits over. Flags start at their defaults and the
  // app hands the player's real settings down through `setFxFlags`.
  const fx: FxSystem = createFxSystem(materials, sceneRoot, {
    ...DEFAULT_FX_FLAGS,
  });

  const gl = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // Explicit rather than implicit: `outputColorSpace` already defaults to sRGB
  // in this version, but it is the single setting that decides whether the art
  // doc's hex values look like themselves, so it is stated, not assumed.
  gl.outputColorSpace = SRGBColorSpace;
  gl.toneMapping = ACESFilmicToneMapping;
  // Exposure reaches ONLY tone-mapped materials, i.e. the lit 3D path — art
  // §3.0 takes the board, grid and frame off the curve entirely. That is what
  // makes §6's targets jointly satisfiable, and why the value lives in
  // CALIBRATION next to the key/fill pair it has to be solved with.
  gl.toneMappingExposure = CALIBRATION.toneMappingExposure;
  // Art §6 asks for "PCF-soft", and `PCFSoftShadowMap` is what that used to
  // mean — but three 0.185.1 **deprecated** it: `WebGLShadowMap.render` swaps it
  // for `PCFShadowMap` on the first frame and logs a warning every time. Naming
  // the survivor is the version-correct way to ask for the same thing, and it
  // keeps the console clean. (Reported for a doc amendment; see the T2.2 report.)
  gl.shadowMap.type = PCFShadowMap;
  // Matches index.html's page background, so the letterbox around a non-square
  // viewport is seamless rather than a visible black bar.
  gl.setClearColor(0x0a0a0a, 1);

  // The post chain (art §7). It reads the finished drawing buffer and writes
  // back over it, so the beauty pass above stays exactly the render T2.2–T2.4
  // calibrated — see the header of `post.ts` for why it is not a `RenderPass`.
  const post: PostChain = createPostChain(
    gl,
    sceneRoot.scene,
    sceneRoot.camera,
  );

  let currentQuality: Quality = quality;
  let viewW = 1;
  let viewH = 1;

  function applyQuality(q: Quality): void {
    const preset = QUALITY_PRESETS[q];
    currentQuality = q;
    if (gl.shadowMap.enabled !== preset.shadows) {
      gl.shadowMap.enabled = preset.shadows;
      // Whether a material samples the shadow map is baked into its compiled
      // program, so flipping the renderer flag alone leaves every existing
      // program on the old code path. This is the recompile.
      for (const m of materials.all) {
        m.needsUpdate = true;
      }
    }
    sceneRoot.setShadowQuality(preset);
    // Art §7's Low row halves both FX budgets. Done here rather than inside the
    // preset table because it also adds/removes resident point lights, which is
    // a scene-graph change and belongs next to the other one.
    fx.setQuality(q);
    // Reconfigures the chain in place: the scene, its materials and the pooled
    // views are untouched by a preset switch (T2.2's contract), and every effect
    // the new preset replaces is disposed rather than dropped (`post.ts` routes
    // all of them through one `Slot`).
    post.setPreset(POST_PRESETS[q]);
  }

  function applyViewport(w: number, h: number): void {
    viewW = Math.max(1, Math.floor(w));
    viewH = Math.max(1, Math.floor(h));
    const cap = QUALITY_PRESETS[currentQuality].dprCap;
    // `devicePixelRatio` is read here, not cached: dragging a window between a
    // HiDPI and a 1× display changes it without any other event firing.
    gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, cap));
    gl.setSize(viewW, viewH, true);
    // The scissor rectangle is renderer state that nothing else here maintains,
    // and `setSize` does NOT move it — so it sat at the canvas element's bare
    // 300×150 default for the whole session (found by the `?probe=post`
    // ladder). Nothing enables the scissor test today, which is the only reason
    // it was harmless: the moment anything does, every frame would be clipped
    // to a fixed rectangle at the origin. Kept in step with the viewport.
    gl.setScissor(0, 0, viewW, viewH);
    sceneRoot.setViewport(viewW, viewH);
    // After `setPixelRatio`/`setSize`: the chain's targets are sized from the
    // drawing buffer, which only exists once those two have run.
    post.setSize(viewW, viewH);
  }

  // Viewport BEFORE quality, deliberately. `applyQuality` builds the post chain,
  // and building it against the 1×1 placeholder that `cssW`/`cssH` start at
  // meant the boot sequence allocated the whole chain four times over as the
  // layout settled — 1×1, 1×1, the canvas element's 300×150 default, then the
  // real size. `currentQuality` is already initialised from the constructor
  // argument, so the DPR cap is correct here without `applyQuality` having run.
  applyViewport(canvas.clientWidth || 1, canvas.clientHeight || 1);
  applyQuality(quality);

  return {
    render(state: GameState, alpha: number, dtMs: number): void {
      // The terrain's ONE full pass, on the first frame it sees a state. After
      // this the board is driven entirely by `onEvent`; rebuilding from
      // `state.terrain` per frame is forbidden (arch §5) and would be ~40 k
      // matrix writes a frame for a board that changes a few times a second.
      terrain.build(state);
      // Only advances the shovel's blink, and only while one is running — and
      // not at all while the simulation is frozen. `terrain.update` takes no
      // state, so the gate is applied here rather than inside it; the two views
      // below own the same rule themselves, which is what makes it testable
      // without a GL context.
      terrain.update(animDtOf(state, dtMs));
      // Entities are pooled and instanced (`tankView.ts`, `bulletView.ts`):
      // positions interpolate from prevX/prevY with `alpha`, and every art §9
      // animation is driven from `state` plus the events pumped through
      // `onEvent`. Nothing here writes to the simulation.
      tanks.update(state, alpha, dtMs);
      bullets.update(state, alpha);
      // The eagle and the power-up (art §4, fidelity §2/§8). After the tanks so
      // the props' two meshes are the last entity draws submitted; ordering is
      // irrelevant to correctness (both are opaque and depth-tested) and this is
      // simply the order a reader expects from the scene's description.
      props.update(state, alpha, dtMs);
      // FX last: particles are additive/blended and have to be submitted after
      // the opaque board. `alpha` is not passed — a particle lives in real
      // time, not in tick time, so there is nothing between two ticks for it to
      // interpolate. `dtMs` is the loop's real frame time and the FX layer
      // zeroes it itself on a paused frame (art §9).
      fx.update(state, dtMs);
      gl.render(sceneRoot.scene, sceneRoot.camera);
      // Art §7's chain, applied to the frame that is now in the drawing buffer.
      post.render();
    },

    // Terrain damage (T2.3) and the tanks' recoil / hit-flash / respawn
    // re-arming (T2.4) are here; T4.x's FX joins them. Events must be pumped in
    // the same frame they are produced — `stepGame` clears the array at the top
    // of the next tick (arch §3.1).
    onEvent(e: GameEvent): void {
      terrain.onEvent(e);
      tanks.onEvent(e);
      props.onEvent(e);
      fx.onEvent(e);
    },

    setQuality(q: Quality): void {
      if (q === currentQuality) {
        return;
      }
      applyQuality(q);
      applyViewport(viewW, viewH); // the DPR cap moved with the preset
    },

    setFxFlags(flags: FxFlags): void {
      fx.setFlags(flags);
    },

    resize(w: number, h: number): void {
      applyViewport(w, h);
    },

    fxStats(): FxStats {
      return fx.stats();
    },

    dispose(): void {
      post.dispose();
      fx.dispose();
      props.dispose();
      tanks.dispose();
      bullets.dispose();
      terrain.dispose();
      sceneRoot.dispose();
      materials.dispose();
      gl.dispose();
    },
  };
}
