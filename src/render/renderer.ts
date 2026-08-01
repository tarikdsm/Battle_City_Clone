// src/render/renderer.ts — Contract Zero's `Renderer`: owns the WebGL context,
// the scene root and the pooled entity views, and turns one `GameState` plus an
// interpolation alpha into one frame (arch §5).
//
// It **reads** `GameState` and never writes to it. The simulation is the single
// source of truth and nothing flows back up (arch §3.3).

import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

import { BULLET_SIZE, TANK_SIZE } from '../core/constants';
import type { GameEvent } from '../core/events';
import type { GameState, Tank } from '../core/types';
import {
  QUALITY_PRESETS,
  createMaterials,
  type Materials,
  type Quality,
} from './materials';
import { createSceneRoot, type SceneRoot } from './sceneRoot';

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

/** Art §6: ACES filmic, exposure 1.1. */
const TONE_MAPPING_EXPOSURE = 1.1;

/** Placeholder tank body: the 16×16 u footprint of art §4 at ~10 u tall. */
const PLACEHOLDER_TANK_H = 10;

/** Height of the bullet's centre above the board — roughly barrel height. */
const BULLET_Y = 6;

/**
 * Steady-state pool sizes. Both are generous against the simulation's own caps
 * (2 players + `ENEMY_CAP` tanks; one or two bullets per tank), and the views
 * grow rather than drop an entity if a later task raises them — an allocation on
 * the frame a cap changes beats a tank that is simply not drawn.
 */
const TANK_POOL = 8;
const BULLET_POOL = 16;

/** Yaw, in radians, that turns a mesh's −z face towards `Dir` 0…3 (Up/R/D/L). */
const DIR_YAW: readonly number[] = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

/**
 * `alpha` reaches **exactly 1** on every paused frame (T2.1's loop contract), so
 * the endpoint has to be exact: `a + (b − a) · t` is not, and would leave every
 * entity a rounding error away from its true position for the whole pause. This
 * form returns `b` bit-exactly at t = 1 and `a` at t = 0.
 */
function lerp(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

/** Which shared skin a tank wears. Pure lookup — no allocation per frame. */
function tankMaterial(tank: Tank, mats: Materials): MeshStandardMaterial {
  if (tank.kind === 'player') {
    return tank.playerIndex === 1 ? mats.player2 : mats.player1;
  }
  switch (tank.enemyType) {
    case 'fast':
      return mats.enemyFast;
    case 'power':
      return mats.enemyPower;
    case 'armor':
      return mats.enemyArmor;
    default:
      return mats.enemyBasic;
  }
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  quality: Quality,
): Renderer {
  const materials = createMaterials();
  const sceneRoot: SceneRoot = createSceneRoot(materials);

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
  gl.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  // Art §6 asks for "PCF-soft", and `PCFSoftShadowMap` is what that used to
  // mean — but three 0.185.1 **deprecated** it: `WebGLShadowMap.render` swaps it
  // for `PCFShadowMap` on the first frame and logs a warning every time. Naming
  // the survivor is the version-correct way to ask for the same thing, and it
  // keeps the console clean. (Reported for a doc amendment; see the T2.2 report.)
  gl.shadowMap.type = PCFShadowMap;
  // Matches index.html's page background, so the letterbox around a non-square
  // viewport is seamless rather than a visible black bar.
  gl.setClearColor(0x0a0a0a, 1);

  // --- Pooled placeholder views (T2.4 replaces these with procedural models) --
  const tankGeo = new BoxGeometry(TANK_SIZE, PLACEHOLDER_TANK_H, TANK_SIZE);
  const bulletGeo = new BoxGeometry(BULLET_SIZE, BULLET_SIZE, BULLET_SIZE);
  const tankViews: Mesh[] = [];
  const bulletViews: Mesh[] = [];

  function growTankViews(to: number): void {
    while (tankViews.length < to) {
      const mesh = new Mesh(tankGeo, materials.enemyBasic);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      sceneRoot.entities.add(mesh);
      tankViews.push(mesh);
    }
  }

  function growBulletViews(to: number): void {
    while (bulletViews.length < to) {
      const mesh = new Mesh(bulletGeo, materials.bullet);
      // Bullets are 4 u across and emissive: their shadow would be a sub-texel
      // speck that costs a shadow-map draw call for nothing.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = false;
      sceneRoot.entities.add(mesh);
      bulletViews.push(mesh);
    }
  }

  growTankViews(TANK_POOL);
  growBulletViews(BULLET_POOL);

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

  /**
   * Positions the pooled boxes from `state` for this frame. **This is the seam
   * T2.4 cuts on**: swap the geometry and the per-type dressing here and the
   * pooling, interpolation and visibility bookkeeping stay untouched.
   *
   * Allocation-free by construction: indexed loops (no iterator objects),
   * `Vector3.set` instead of new vectors, and `mesh.material` reassigned by
   * reference from the shared table rather than a colour written per frame.
   */
  function syncPlaceholderViews(state: GameState, alpha: number): void {
    const tanks = state.tanks;
    let used = 0;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (!tank.alive) {
        continue;
      }
      if (used >= tankViews.length) {
        growTankViews(used + 1);
      }
      const view = tankViews[used++];
      // Core positions are the AABB's top-left corner; a box mesh is centred.
      view.position.set(
        lerp(tank.prevX, tank.x, alpha) + TANK_SIZE / 2,
        PLACEHOLDER_TANK_H / 2,
        lerp(tank.prevY, tank.y, alpha) + TANK_SIZE / 2,
      );
      view.rotation.y = DIR_YAW[tank.dir];
      view.material = tankMaterial(tank, materials);
      view.visible = true;
    }
    for (let i = used; i < tankViews.length; i++) {
      tankViews[i].visible = false;
    }

    const bullets = state.bullets;
    used = 0;
    for (let i = 0; i < bullets.length; i++) {
      const bullet = bullets[i];
      if (!bullet.alive) {
        continue;
      }
      if (used >= bulletViews.length) {
        growBulletViews(used + 1);
      }
      const view = bulletViews[used++];
      view.position.set(
        lerp(bullet.prevX, bullet.x, alpha) + BULLET_SIZE / 2,
        BULLET_Y,
        lerp(bullet.prevY, bullet.y, alpha) + BULLET_SIZE / 2,
      );
      view.visible = true;
    }
    for (let i = used; i < bulletViews.length; i++) {
      bulletViews[i].visible = false;
    }
  }

  return {
    // `dtMs` is part of the contract but unused until time-based presentation
    // lands (T2.5 shake/fly-in). A shorter parameter list is assignable to the
    // interface, so it is omitted rather than named and ignored.
    render(state: GameState, alpha: number): void {
      syncPlaceholderViews(state, alpha);
      gl.render(sceneRoot.scene, sceneRoot.camera);
    },

    // T2.3+ (terrain damage) and T4.x (FX) subscribe here. A no-op stub with no
    // parameter, so an unused argument cannot rot into a wrong one.
    onEvent(): void {},

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
      tankGeo.dispose();
      bulletGeo.dispose();
      sceneRoot.dispose();
      materials.dispose();
      gl.dispose();
    },
  };
}
