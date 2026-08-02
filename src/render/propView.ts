// src/render/propView.ts — the two static props of the fidelity spec: the
// **eagle** the stage is defended for (§2) and the **power-up** on the field
// (§8). Presentation only: it reads `GameState` and the event stream and writes
// to neither (arch §3.3).
//
// ## Why one view for two unrelated objects
//
// Because they share their materials, and a material is a draw call. Art §3.1
// authors a single gold token for "star, pickups, eagle emblem", so the eagle's
// standing emblem and all six power-up shapes are instances of **one** emissive
// mesh; the pedestal — in both its states, fallen emblem included — is
// instances of **one** stone mesh. Two draw calls for seven objects, which is
// what let the props land inside art §8's 12-call entity budget with 10 already
// spent (see `ENTITY_DRAW_BUDGET`). Splitting this file in two would split the
// meshes with it and cost two more.
//
// ## What it is not responsible for
//
// - **The base explosion** (art §8: shockwave, emblem shards, smoke column,
//   long light) and the eagle's **smoke wisps** (art §4) are T4.x's. The seam is
//   `onEvent`: `baseDestroyed` already arrives here and switches the model, so
//   an FX layer hangs its emitter off the same event without this file changing.
// - **The power-up's idle point light** (art §6's dynamic pool, "range 24 u,
//   1.2 s sine") is likewise T4.x's. Its phase is `powerupBobAt`'s phase, and
//   that curve is pure and exported so the two cannot drift.
// - **Collection and placement** are the core's. `state.powerup` is read, never
//   written; the item's position is whatever the simulation says it is.
//
// ## Bookkeeping
//
// There is no pool here and there does not need to be one: the field holds
// exactly one eagle and at most one power-up (fidelity §8), so both meshes are
// written from index 0 every frame at a cost of ~20 instances. That is cheaper
// than the dirty-update machinery `terrainView.ts` needs for 676 subcells, and
// it removes the whole class of stale-slot bugs `SlotMap` exists to prevent.

import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';

import { EAGLE_TILE, TILE } from '../core/constants';
import type { GameEvent } from '../core/events';
import type { GameState, PowerupType } from '../core/types';
import type { Materials } from './materials';
import {
  BILLBOARD_X,
  EAGLE_MODELS,
  POWERUP_MODELS,
  animDtOf,
  countPropRole,
  createPartGeometry,
  eagleCentre,
  powerupBobAt,
  powerupYawAt,
  writePartMatrix,
  type PropModel,
  type PropPart,
  type PropRole,
} from './models';
import { BLOOM_LAYER } from './post';
import type { SceneRoot } from './sceneRoot';

const POWERUP_TYPE_LIST = Object.keys(POWERUP_MODELS) as PowerupType[];

/** Instances each mesh must be able to hold with everything on the field. */
function capacityOf(role: PropRole): number {
  const eagle = Math.max(
    countPropRole(EAGLE_MODELS.intact, role),
    countPropRole(EAGLE_MODELS.destroyed, role),
  );
  const powerup = Math.max(
    ...POWERUP_TYPE_LIST.map((t) => countPropRole(POWERUP_MODELS[t], role)),
  );
  // Both may be on screen at once, so this is a sum and not a max.
  return eagle + powerup;
}

export interface PropView {
  /**
   * One frame. `alpha` is unused — neither prop interpolates, because neither
   * has a `prevX`: the eagle never moves and the core places a power-up once
   * and leaves it there. It is in the signature so every entity view has the
   * same one, which is what lets `renderer.ts` call them in a row.
   *
   * `dtMs` drives the bob and the spin, and is zeroed on a paused frame by
   * {@link animDtOf}.
   */
  update(state: GameState, alpha: number, dtMs: number): void;
  /** `baseDestroyed` and the power-up's spawn/collect. Ignores everything else. */
  onEvent(e: GameEvent): void;
  dispose(): void;
}

export function createPropView(
  materials: Materials,
  sceneRoot: SceneRoot,
): PropView {
  const group = new Group();
  sceneRoot.entities.add(group);

  const geometry: BufferGeometry = createPartGeometry();

  const stone = makeInstanced(
    geometry,
    materials.propStone,
    capacityOf('stone'),
    false,
  );
  const goldMesh = makeInstanced(
    geometry,
    materials.propGold,
    capacityOf('gold'),
    true,
  );
  group.add(stone, goldMesh);

  const [eagleX, eagleZ] = eagleCentre(EAGLE_TILE);

  /**
   * Set by `baseDestroyed`, cleared by the next `update`.
   *
   * The **flag is the source of truth** — `bulletsSystem` clears
   * `state.eagleAlive` in the same tick it emits the event, so a mid-game load,
   * a replay, or any frame drawn without the event having been pumped still
   * lands on the right model. The event is a *same-frame* accelerator on top of
   * that, and it is what makes this view's switch observable to a caller that
   * drives events without a settled state.
   */
  let destroyedEvent = false;

  /**
   * ms of animation the current power-up has accumulated. Re-armed when the
   * item changes so a new drop starts at the bottom of its bob instead of
   * inheriting the last one's phase — the pop that would otherwise happen at
   * the exact moment the player is meant to notice something appeared.
   */
  let powerupMs = 0;
  let shownType: PowerupType | null = null;

  // Scratch, reused for the life of the view: the frame path allocates nothing.
  const basis = new Float64Array(9);
  const flat = new Float64Array(9);
  const colour = new Color();
  /** Instances written into each mesh so far this frame. */
  const used: Record<PropRole, number> = { stone: 0, gold: 0 };

  // The billboard basis is constant — art §2 fixes the camera — so it is built
  // once rather than per part per frame. Same construction as `tankView.ts`'s
  // spawn star: local −z is screen up, local +y points at the camera.
  {
    const c = Math.cos(BILLBOARD_X);
    const s = Math.sin(BILLBOARD_X);
    flat[0] = 1;
    flat[4] = c;
    flat[7] = s;
    flat[5] = -s;
    flat[8] = c;
  }

  function setYaw(yaw: number): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    basis[0] = c;
    basis[1] = 0;
    basis[2] = s;
    basis[3] = 0;
    basis[4] = 1;
    basis[5] = 0;
    basis[6] = -s;
    basis[7] = 0;
    basis[8] = c;
  }

  function meshOf(role: PropRole): InstancedMesh {
    return role === 'stone' ? stone : goldMesh;
  }

  /** Writes every part of `model`, offset to `(cx, y0, cz)` under `basis`. */
  function writeModel(
    model: PropModel,
    cx: number,
    y0: number,
    cz: number,
  ): void {
    const parts = model.parts;
    for (let i = 0; i < parts.length; i++) {
      const p: PropPart = parts[i];
      const mesh = meshOf(p.role);
      const index = used[p.role];
      // Capacity is derived from the very tables being written, so this can
      // only fire if a table grew without `capacityOf` seeing it — but a typed
      // array swallows an out-of-range write silently, and a silently wrong
      // matrix is the hardest kind of render bug to find.
      if (index >= mesh.instanceMatrix.count) continue;
      used[p.role] = index + 1;
      writePartMatrix(
        mesh,
        index,
        p.billboard === true ? flat : basis,
        cx,
        y0,
        cz,
        p.x,
        p.y,
        p.z,
        p.w,
        p.h,
        p.d,
      );
      colour.r = p.tint[0];
      colour.g = p.tint[1];
      colour.b = p.tint[2];
      mesh.setColorAt(index, colour);
    }
  }

  return {
    update(state: GameState, alpha: number, dtMs: number): void {
      void alpha; // neither prop interpolates — see the interface doc
      const dt = animDtOf(state, dtMs);

      used.stone = 0;
      used.gold = 0;

      // --- the eagle --------------------------------------------------------
      const destroyed = !state.eagleAlive || destroyedEvent;
      destroyedEvent = false;
      setYaw(0);
      writeModel(
        destroyed ? EAGLE_MODELS.destroyed : EAGLE_MODELS.intact,
        eagleX,
        0,
        eagleZ,
      );

      // --- the power-up -----------------------------------------------------
      const item = state.powerup;
      if (item === null) {
        shownType = null;
        powerupMs = 0;
      } else {
        if (item.type !== shownType) {
          shownType = item.type;
          powerupMs = 0;
        }
        powerupMs += dt;
        setYaw(powerupYawAt(powerupMs));
        writeModel(
          POWERUP_MODELS[item.type],
          item.x + TILE / 2,
          powerupBobAt(powerupMs),
          item.y + TILE / 2,
        );
      }

      for (const role of ['stone', 'gold'] as const) {
        const mesh = meshOf(role);
        mesh.count = used[role];
        if (mesh.count === 0) continue;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      }
    },

    onEvent(e: GameEvent): void {
      switch (e.t) {
        case 'baseDestroyed':
          destroyedEvent = true;
          break;
        case 'powerupSpawned':
          // Re-arm rather than assign: `update` reads the type off the state,
          // and a replacement drop of the SAME type (fidelity §8 allows it)
          // would otherwise keep the old one's bob phase and never blink.
          shownType = null;
          break;
        case 'powerupCollected':
          shownType = null;
          powerupMs = 0;
          break;
        default:
          break;
      }
    },

    dispose(): void {
      group.removeFromParent();
      stone.dispose();
      goldMesh.dispose();
      geometry.dispose();
    },
  };
}

function makeInstanced(
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  capacity: number,
  emissive: boolean,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, capacity));
  mesh.count = 0;
  // Every matrix is rewritten every frame — the default STATIC_DRAW hint would
  // make each upload a buffer re-allocation.
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // An emissive surface casting a shadow is simply wrong, and it costs a
  // shadow-map draw for a surface the light does not fall on (the same ruling
  // `tankView.ts` applies to the spawn star and the tier tip). The pedestal is
  // ordinary stone and does both.
  mesh.castShadow = !emissive;
  mesh.receiveShadow = !emissive;
  if (emissive) {
    // Art §7 selects bloom **by layer**, so this is what makes the emblem and
    // the power-ups glow rather than merely being bright. `enable`, not `set`:
    // the mesh stays on layer 0 so the beauty pass still draws it.
    mesh.layers.enable(BLOOM_LAYER);
  }
  // The bounding sphere comes from the GEOMETRY — one unit box at the origin —
  // so three would cull both props off the board.
  mesh.frustumCulled = false;
  return mesh;
}
