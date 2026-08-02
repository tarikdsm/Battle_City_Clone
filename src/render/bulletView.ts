// src/render/bulletView.ts — art §4's bullets: a 4×4 u emissive capsule with a
// short additive tracer behind it. Presentation only; reads `GameState` and
// writes nothing back (arch §3.3).
//
// Two `InstancedMesh`es, both over the same capsule geometry: one for the heads
// on `materials.bullet`, one for the tracers on `materials.bulletTrail`. They
// cannot share a mesh, and the reason is easy to get wrong — three applies
// vertex/instance colour to `diffuseColor` only, never to `emissive`, so a
// tracer drawn as extra instances of the head mesh would glow at exactly the
// head's brightness however it was tinted and read as a solid rod. Two meshes
// is two draw calls whatever the bullet count, which is what instancing buys.
//
// Bullets are pooled by **compaction order**, not by identity, and that is
// correct here where it would be fatal for tanks: a bullet carries no per-entity
// animation state at all (position, direction and length are all read straight
// off the simulation each frame), so there is nothing a shifted slot could take
// with it.

import {
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';

import { BULLET_SIZE } from '../core/constants';
import type { GameState } from '../core/types';
import type { Materials } from './materials';
import { BULLET_LENGTH, DIR_YAW, createBulletGeometry, lerp } from './models';
import type { SceneRoot } from './sceneRoot';

/**
 * Height of a bullet's centre above the board — roughly barrel height, so a
 * tracer leaves the muzzle rather than the tracks. The models put every barrel
 * between 7.3 u and 11 u; 8 u is the shared line.
 */
export const BULLET_Y = 8;

/** Art §4's "short" tracer, in u behind the head. */
export const TRAIL_U = 13;
/** How much narrower the tracer is than the bullet — it tapers to a streak. */
const TRAIL_WIDTH = 0.45;

/**
 * Steady-state pool size. The simulation caps airborne bullets at one per enemy
 * plus one or two per player, so 16 is generous; the pool grows rather than
 * dropping a bullet if a later task raises that.
 */
const BULLET_POOL = 16;

export interface BulletView {
  update(state: GameState, alpha: number): void;
  dispose(): void;
}

export function createBulletView(
  materials: Materials,
  sceneRoot: SceneRoot,
): BulletView {
  const group = new Group();
  sceneRoot.entities.add(group);

  const geometry: BufferGeometry = createBulletGeometry();
  let capacity = BULLET_POOL;
  let head = makeInstanced(geometry, materials.bullet, capacity);
  let trail = makeInstanced(geometry, materials.bulletTrail, capacity);
  group.add(head, trail);

  // Scratch, reused for the life of the view: the frame path allocates nothing.
  const pos = new Vector3();
  const quat = new Quaternion();
  const scale = new Vector3();
  const offset = new Vector3();
  const mat = new Matrix4();
  const UP = new Vector3(0, 1, 0);

  function grow(to: number): void {
    const next = Math.max(to, capacity * 2);
    group.remove(head, trail);
    head.dispose();
    trail.dispose();
    head = makeInstanced(geometry, materials.bullet, next);
    trail = makeInstanced(geometry, materials.bulletTrail, next);
    group.add(head, trail);
    capacity = next;
  }

  return {
    update(state: GameState, alpha: number): void {
      const bullets = state.bullets;
      let live = 0;
      for (let i = 0; i < bullets.length; i++) {
        if (bullets[i].alive) live++;
      }
      if (live > capacity) grow(live);

      let used = 0;
      for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (!b.alive) continue;
        // Core positions are the AABB's top-left corner; the capsule is centred.
        pos.set(
          lerp(b.prevX, b.x, alpha) + BULLET_SIZE / 2,
          BULLET_Y,
          lerp(b.prevY, b.y, alpha) + BULLET_SIZE / 2,
        );
        quat.setFromAxisAngle(UP, DIR_YAW[b.dir]);

        scale.set(1, 1, 1);
        mat.compose(pos, quat, scale);
        head.setMatrixAt(used, mat);

        // Local −z is forward, so the tracer sits at +z and stretches back.
        offset.set(0, 0, TRAIL_U / 2).applyQuaternion(quat);
        pos.add(offset);
        scale.set(TRAIL_WIDTH, TRAIL_WIDTH, TRAIL_U / BULLET_LENGTH);
        mat.compose(pos, quat, scale);
        trail.setMatrixAt(used, mat);
        used++;
      }

      head.count = used;
      trail.count = used;
      if (used > 0) {
        head.instanceMatrix.needsUpdate = true;
        trail.instanceMatrix.needsUpdate = true;
      }
    },

    dispose(): void {
      group.removeFromParent();
      head.dispose();
      trail.dispose();
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
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Bullets are 4 u across and emissive: their shadow would be a sub-texel
  // speck that costs a shadow-map draw call for nothing, and the tracer is
  // additive — a shadow cast by a glow is simply wrong.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The bounding sphere comes from the GEOMETRY, one capsule at the origin, so
  // three would cull every bullet on the board.
  mesh.frustumCulled = false;
  return mesh;
}
