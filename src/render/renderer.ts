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
  CALIBRATION,
  QUALITY_PRESETS,
  createMaterials,
  type Quality,
} from './materials';
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
  resize(w: number, h: number): void;
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
  }

  function applyViewport(w: number, h: number): void {
    viewW = Math.max(1, Math.floor(w));
    viewH = Math.max(1, Math.floor(h));
    const cap = QUALITY_PRESETS[currentQuality].dprCap;
    // `devicePixelRatio` is read here, not cached: dragging a window between a
    // HiDPI and a 1× display changes it without any other event firing.
    gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, cap));
    gl.setSize(viewW, viewH, true);
    sceneRoot.setViewport(viewW, viewH);
  }

  applyQuality(quality);
  applyViewport(canvas.clientWidth || 1, canvas.clientHeight || 1);

  return {
    render(state: GameState, alpha: number, dtMs: number): void {
      // The terrain's ONE full pass, on the first frame it sees a state. After
      // this the board is driven entirely by `onEvent`; rebuilding from
      // `state.terrain` per frame is forbidden (arch §5) and would be ~40 k
      // matrix writes a frame for a board that changes a few times a second.
      terrain.build(state);
      // Only advances the shovel's blink, and only while one is running.
      terrain.update(dtMs);
      // Entities are pooled and instanced (`tankView.ts`, `bulletView.ts`):
      // positions interpolate from prevX/prevY with `alpha`, and every art §9
      // animation is driven from `state` plus the events pumped through
      // `onEvent`. Nothing here writes to the simulation.
      tanks.update(state, alpha, dtMs);
      bullets.update(state, alpha);
      gl.render(sceneRoot.scene, sceneRoot.camera);
    },

    // Terrain damage (T2.3) and the tanks' recoil / hit-flash / respawn
    // re-arming (T2.4) are here; T4.x's FX joins them. Events must be pumped in
    // the same frame they are produced — `stepGame` clears the array at the top
    // of the next tick (arch §3.1).
    onEvent(e: GameEvent): void {
      terrain.onEvent(e);
      tanks.onEvent(e);
    },

    setQuality(q: Quality): void {
      if (q === currentQuality) {
        return;
      }
      applyQuality(q);
      applyViewport(viewW, viewH); // the DPR cap moved with the preset
    },

    resize(w: number, h: number): void {
      applyViewport(w, h);
    },

    dispose(): void {
      tanks.dispose();
      bullets.dispose();
      terrain.dispose();
      sceneRoot.dispose();
      materials.dispose();
      gl.dispose();
    },
  };
}
