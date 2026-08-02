// src/render/terrainView.ts — the battlefield: brick, steel, water, trees, ice
// (art §5, arch §5 and §11).
//
// ## The two halves of this file
//
// Everything above `--- The view ---` is **pure**: index maths, a slot map, a
// deterministic hash. It is what `tests/render/terrainView.test.ts` asserts in
// the Vitest node environment, where there is no WebGL. Everything below builds
// geometry and drives `InstancedMesh`es and is verified by screenshot and by
// `npm run calibrate:lighting`.
//
// ## Why instanced, and why the dirty updates are the load-bearing part
//
// A full board is 676 brick subcells. One mesh each would be 676 draw calls
// against arch §11's ~120 budget, so every kind is one `InstancedMesh` — five
// draw calls for the whole battlefield. The consequence is that *removing* a
// piece is not a delete: an `InstancedMesh` draws instances `0 … count-1` with
// no holes, so a destroyed subcell is filled by moving the last active instance
// into its slot and dropping `count`. `createSlotMap` is the bookkeeping that
// makes a later lookup still find that moved instance — without it, damaging the
// same tile twice clears the wrong subcells.
//
// Rebuilding from `state.terrain` each frame is forbidden (and would be ~40 k
// matrix writes a frame). The initial build is the only full pass; after that
// the view is driven entirely by `brickHit` / `steelHit` / `shovelPhase` events
// against its own mirror of the subcell kinds.

import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  SphereGeometry,
} from 'three';

import {
  BASE_RING_TILES,
  FIELD_SUBCELLS,
  FIELD_TILES,
  SUBCELL,
  TILE,
} from '../core/constants';
import type { GameEvent } from '../core/events';
import { Terrain, type GameState, type TerrainKind } from '../core/types';
import { PALETTE, type Materials } from './materials';
import { PITCH_TAN, type SceneRoot } from './sceneRoot';

// ---------------------------------------------------------------------------
// --- Pure placement / index mathematics ------------------------------------
// ---------------------------------------------------------------------------

/** Art §5: "slight per-subcell hue jitter (±3%) for texture". */
export const BRICK_JITTER = 0.03;

/**
 * The **identity** of a subcell instance — the core's own `sy*26+sx` layout, so
 * `state.terrain` can be read straight through it. Not to be confused with the
 * *slot* the instance currently occupies inside an `InstancedMesh`, which moves
 * when a neighbour is destroyed; that is what {@link SlotMap.slotOf} answers.
 */
export function subcellInstanceIndex(sx: number, sy: number): number {
  return sy * FIELD_SUBCELLS + sx;
}

/**
 * Writes the subcell indices selected by a `removedMask` into `out` and returns
 * how many there are. Bit order is the core's: 1 = TL, 2 = TR, 4 = BL, 8 = BR
 * (`buildTerrain`/`damageTile` in `src/core`), so the four masks a bullet can
 * produce are 3 (top row), 12 (bottom row), 5 (left column), 10 (right column),
 * plus 15 for a tier-3 shot that takes the whole tile.
 *
 * `out` is caller-owned and reused: the damage path allocates nothing.
 */
export function maskSubcells(
  tx: number,
  ty: number,
  mask: number,
  out: number[],
): number {
  const sx = tx * 2;
  const sy = ty * 2;
  let n = 0;
  if ((mask & 1) !== 0) out[n++] = subcellInstanceIndex(sx, sy);
  if ((mask & 2) !== 0) out[n++] = subcellInstanceIndex(sx + 1, sy);
  if ((mask & 4) !== 0) out[n++] = subcellInstanceIndex(sx, sy + 1);
  if ((mask & 8) !== 0) out[n++] = subcellInstanceIndex(sx + 1, sy + 1);
  return n;
}

/** What `SlotMap.remove` reports so the caller can move one matrix. */
export interface SlotMove {
  /** The freed slot — where the moved instance must be written. */
  readonly slot: number;
  /** Where it came from. Equal to `slot` when the removed one WAS the last. */
  readonly fromSlot: number;
  /** Identity of the instance that moved (equal to the removed key if none). */
  readonly key: number;
}

/**
 * The index map between a stable instance **identity** (a subcell or tile index)
 * and the **slot** it occupies in an `InstancedMesh`.
 *
 * Both directions are needed and neither is derivable from the other in O(1):
 * `remove` has to know which slot a key sits in, and the swap-with-last has to
 * know which key just moved so its entry can be repointed. Backed by two typed
 * arrays rather than a `Map`, so nothing allocates and nothing is rehashed
 * during a wave of brick hits.
 */
export interface SlotMap {
  /** Number of live instances — exactly what `InstancedMesh.count` must be. */
  readonly count: number;
  /** Appends `key` and returns its slot. Idempotent: re-adding returns the
   *  existing slot (the shovel stamps its ring unconditionally). */
  add(key: number): number;
  /** Removes `key`, back-filling its slot from the last one. `null` if absent. */
  remove(key: number): SlotMove | null;
  /** Slot of `key`, or −1. */
  slotOf(key: number): number;
  /** Identity currently living in `slot`. */
  keyAt(slot: number): number;
  clear(): void;
}

/**
 * @param keySpace how many distinct **identities** exist — 676 for a subcell
 * map, 169 for a tile map. Not the instance count: the map is indexed by key,
 * so a key at or above this bound reads off the end of a typed array and comes
 * back `undefined` rather than throwing.
 */
export function createSlotMap(keySpace: number): SlotMap {
  // −1 encoded as 0xffffffff; `keys` is only meaningful below `count`.
  const slotByKey = new Int32Array(keySpace).fill(-1);
  const keyBySlot = new Int32Array(keySpace).fill(-1);
  let count = 0;

  return {
    get count(): number {
      return count;
    },

    add(key: number): number {
      const existing = slotByKey[key];
      if (existing !== -1) return existing;
      const slot = count++;
      slotByKey[key] = slot;
      keyBySlot[slot] = key;
      return slot;
    },

    remove(key: number): SlotMove | null {
      const slot = slotByKey[key];
      if (slot === -1) return null;
      const last = count - 1;
      const movedKey = keyBySlot[last];
      keyBySlot[slot] = movedKey;
      slotByKey[movedKey] = slot;
      slotByKey[key] = -1;
      keyBySlot[last] = -1;
      count = last;
      // `fromSlot === slot` when the removed instance was itself the last one:
      // the caller must not copy a matrix onto itself.
      return { slot, fromSlot: last, key: movedKey };
    },

    slotOf(key: number): number {
      return slotByKey[key];
    },

    keyAt(slot: number): number {
      return keyBySlot[slot];
    },

    clear(): void {
      slotByKey.fill(-1);
      keyBySlot.fill(-1);
      count = 0;
    },
  };
}

/**
 * A deterministic value in [−1, 1] from a subcell coordinate.
 *
 * **Deterministic is the requirement, not incidental.** `src/core`'s seeded rng
 * is off-limits to the render layer (arch §2: render never touches simulation
 * state) and `Math.random` would repaint the board on every load — the same
 * stage has to look the same every time. This is a fixed integer hash of the
 * coordinate: two rounds of the murmur3 finaliser over an odd-multiplier mix,
 * chosen because the finaliser alone leaves visible diagonal banding on a
 * 26×26 lattice (adjacent inputs stay adjacent through one round).
 *
 * The two multipliers differ so `(a, b)` and `(b, a)` do not collide; a
 * symmetric hash mirrors the whole board about its diagonal.
 */
export function subcellJitter(sx: number, sy: number): number {
  let h = Math.imul(sx, 0x27d4eb2d) ^ Math.imul(sy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * The render layer's private mirror of the subcell kinds. A **copy**: arch §2
 * forbids the render layer writing to simulation state, and the shovel's blink
 * flips kinds that the core deliberately does not.
 */
export function terrainFromState(state: GameState): Uint8Array {
  return Uint8Array.from(state.terrain);
}

/** Stamps all four subcells of every `BASE_RING_TILES` entry to `kind`. */
export function stampBaseRingKinds(kinds: Uint8Array, kind: TerrainKind): void {
  for (const [tx, ty] of BASE_RING_TILES) {
    const sx = tx * 2;
    const sy = ty * 2;
    kinds[subcellInstanceIndex(sx, sy)] = kind;
    kinds[subcellInstanceIndex(sx + 1, sy)] = kind;
    kinds[subcellInstanceIndex(sx, sy + 1)] = kind;
    kinds[subcellInstanceIndex(sx + 1, sy + 1)] = kind;
  }
}

/**
 * The Shovel, mirrored from the core's own behaviour (`stampBaseRing` in
 * `src/core/systems/powerups.ts` and the phase machine in `stageflow.ts`):
 *
 * - `'steel'` — the ring becomes steel, **including subcells a bullet had
 *   already destroyed**. The core stamps rather than repairs, so a hole shot in
 *   the wall before the power-up is picked up comes back solid.
 * - `'blink'` — the wall is still steel. Only its *appearance* alternates
 *   (`BLINK_HZ` below); nothing about the kinds changes, which is why this case
 *   is a no-op here rather than a third stamp.
 * - `'revert'` — a fully repaired **brick** ring, again by stamping.
 */
export function applyShovelPhase(
  kinds: Uint8Array,
  phase: 'steel' | 'blink' | 'revert',
): void {
  if (phase === 'steel') {
    stampBaseRingKinds(kinds, Terrain.Steel);
  } else if (phase === 'revert') {
    stampBaseRingKinds(kinds, Terrain.Brick);
  }
}

/** Instances per kind, indexed by `TerrainKind` — the initial-build census. */
export function countSubcellKinds(kinds: Uint8Array): Uint32Array {
  const counts = new Uint32Array(6);
  for (let i = 0; i < kinds.length; i++) {
    counts[kinds[i]]++;
  }
  return counts;
}

/**
 * Tiles whose top-left subcell holds `kind`. Water, trees and ice are
 * indestructible and therefore always whole tiles, so they instance per tile —
 * a quarter of the instances and a quarter of the triangles of a subcell build.
 */
export function countTileKind(kinds: Uint8Array, kind: TerrainKind): number {
  let n = 0;
  for (let ty = 0; ty < FIELD_TILES; ty++) {
    for (let tx = 0; tx < FIELD_TILES; tx++) {
      if (kinds[subcellInstanceIndex(tx * 2, ty * 2)] === kind) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// --- Geometry (art §5) -----------------------------------------------------
// ---------------------------------------------------------------------------

/** Art §5: brick and steel stand 10 u tall. */
const TERRAIN_H = 10;
/** Art §5: water is "recessed −3 u" — the pit the board is cut away for. */
export const WATER_DEPTH = 3;
/** Art §5: canopies float at 14 u; tanks are 10 u, so they pass underneath. */
const CANOPY_Y = 14;
/** Flush with the board (art §5), lifted only enough not to z-fight it. */
const ICE_LIFT = 0.03;

/** Brick: width of the mortar groove around each subcell's top face. */
const MORTAR_INSET = 1.0;
/** Depth of that groove below the top lip. */
const MORTAR_DROP = 0.8;
/** Steel: how far the beveled top is drawn in from the side faces. */
const STEEL_BEVEL = 0.8;
/** Steel: half-width and height of the centre rivet. */
const RIVET_HALF = 1.1;
const RIVET_H = 0.7;

/**
 * Reference tank height (art §4: "height ~10 u"). Local rather than imported
 * from `renderer.ts`: this is a *presentation* assumption about what a canopy
 * has to hide, and coupling terrain to the entity pool's placeholder box would
 * break the moment T2.4 replaces it.
 */
const TANK_H_REF = 10;

/**
 * How far **south** the cluster is pushed so its screen position registers with
 * its own tile rather than with its plan position (see `PITCH_TAN`).
 *
 * A canopy floating at 14 u draws 14·tan 32° = 8.7 u north of where it sits, so
 * an unshifted cluster left the entire south face of a tank underneath in plain
 * view — measured on the first screenshot of this task, and the reason this
 * constant exists. The shift registers the canopy against the **midpoint of a
 * tank's screen footprint** rather than against the ground, which is why the
 * tank's own height is in the formula: a 10 u tank on tile `t` occupies
 * ground-equivalent depth `[t − 10·tan θ, t + 16]`, whose midpoint sits 5 u of
 * height above the board.
 */
const CANOPY_PARALLAX_Z = (CANOPY_Y - TANK_H_REF / 2) * PITCH_TAN;

/**
 * The cluster, as `[radius, flatten, offsetX, offsetY, offsetZ]` — art §5's
 * "3–5 flattened spheres", here 5.
 *
 * **The size along z is derived from the concealment requirement, not chosen.**
 * A 10 u tank on a 16 u tile covers `16 + 10·tan 32° = 22.3 u` of
 * ground-equivalent depth on screen, so a cluster spanning less than that leaves
 * part of the tank showing however it is placed — and concealment is a
 * gameplay-readable property (art §5), not decoration. Two earlier cuts spanned
 * 18 u and 23.6 u and both left a gold hull plainly visible; this one spans
 * 26.4 u and measures **95% of the tank's silhouette hidden**.
 *
 * Consequences worth knowing before editing:
 * - **The cluster overhangs its tile**, ~5 u north and ~5 u south. That is the
 *   unavoidable price of a *floating* canopy under a tilted camera, and it is
 *   the one place art §5 needs a ruling (see the T2.3 report).
 * - **Satellites must clear the centre blob or they contribute nothing.** The
 *   second cut put them at ±5.6 u where the centre ellipsoid is still 7.2 u tall,
 *   so all four were entirely *inside* it and the tile rendered as a single dome.
 *   At ±6.5 they break the silhouette, which is what art §5 asks them for.
 * - **Nothing may dip below 10 u**, or it intersects the tank it is hiding and
 *   reads as a glitch rather than as cover. Centre underside 10.2 u, satellites
 *   10.8 u.
 * - **Satellites are flatter (0.40) than the centre (0.50)**, which keeps their
 *   tops below the centre blob's 45° meridian — the meridian
 *   {@link CANOPY_PROBE} samples.
 */
const CANOPY_CENTRE = Object.freeze({ r: 8.4, flatten: 0.5, dy: 0.4 });

/**
 * Compensation for an inscribed-polyhedron effect that cost the first two cuts
 * their coverage: a low-poly sphere's surface dips to `cos(180°/segments)` of its
 * radius *between* vertices, so a blob "sized to hide a tank" was 8% narrower
 * than its radius everywhere it mattered. Horizontal radii are built this much
 * larger, which makes the **narrowest** cross-section equal to the nominal
 * radius — and therefore makes `CANOPY_CENTRE.r` the number the coverage
 * arithmetic and {@link CANOPY_PROBE} can both trust. Not applied to the vertical
 * radius: the pole is a vertex, so a blob's height is already exact.
 */
const CANOPY_SEGMENTS = 8;
const CANOPY_FACET_GAIN = 1 / Math.cos(Math.PI / CANOPY_SEGMENTS);

/**
 * `[radiusX, radiusZ, radiusY, offsetX, offsetY, offsetZ]`.
 *
 * The north and south blobs are **elliptical in plan** — wide in x, shallow in
 * z. That is what covers the tank's four corners: a round blob pushed far enough
 * north to reach the top of the tank's screen footprint has already narrowed to
 * nothing in x by the time it gets there, which is what left thin gold slivers
 * at the corners in the third cut (86.5% concealed). Ellipses reach the same
 * depth while still being a tank wide.
 */
const CANOPY_BLOBS: readonly (readonly [
  number,
  number,
  number,
  number,
  number,
  number,
])[] = [
  // rx    rz   ry    ox    oy    oz
  [8.4, 8.4, 4.2, 0, CANOPY_CENTRE.dy, 0],
  [8.2, 5.5, 2.4, 0, -0.6, -6.5],
  [8.4, 5.8, 2.5, 0, -0.6, 6.5],
  [5.0, 5.0, 2.0, -6.4, -0.6, -0.5],
  [5.0, 5.0, 2.0, 6.4, -0.8, 0.8],
];

// An ellipsoid of radius `r` and half-height `r·flatten` has a surface normal
// exactly 45° off vertical where `tan θ = 1 / flatten`.
const CANOPY_45_SIN = 1 / Math.hypot(CANOPY_CENTRE.flatten, 1);
const CANOPY_45_COS =
  CANOPY_CENTRE.flatten / Math.hypot(CANOPY_CENTRE.flatten, 1);

/**
 * Where `scripts/calibrate-lighting.ts` samples a tree canopy, relative to the
 * tile's north-west corner. Exported so the harness measures **this** geometry
 * rather than a stand-in — art §6's "uncovered band" note is about canopy
 * normals specifically, and a probe built from a different sphere would answer a
 * different question. Computed from the constants above rather than written out,
 * so resizing the cluster cannot silently leave the probe sampling thin air —
 * which it already did once: the first run measured the board through a gap and
 * reported it as a −82% "deviation".
 *
 * Three points, because one number does not describe the band. `apex` has a
 * straight-up normal — hemisphere blend weight 1, so art §6 target 1 applies to
 * it unchanged. `flankWest` and `flankSouth` are both 45° normals, the middle of
 * the band, but they differ by ~60 points because the **key** reaches one and
 * not the other: west has `n·l = 0.28`, south has `n·l = 0.17` and sits in the
 * canopy's own shade. Reporting only the lit one would hide exactly the problem
 * art §6's note is about.
 */
export const CANOPY_PROBE = Object.freeze({
  apex: Object.freeze([
    8,
    CANOPY_Y + CANOPY_CENTRE.dy + CANOPY_CENTRE.r * CANOPY_CENTRE.flatten,
    8 + CANOPY_PARALLAX_Z,
  ] as const),
  flankWest: Object.freeze([
    8 - CANOPY_CENTRE.r * CANOPY_45_SIN,
    CANOPY_Y +
      CANOPY_CENTRE.dy +
      CANOPY_CENTRE.r * CANOPY_CENTRE.flatten * CANOPY_45_COS,
    8 + CANOPY_PARALLAX_Z,
  ] as const),
  flankSouth: Object.freeze([
    8,
    CANOPY_Y +
      CANOPY_CENTRE.dy +
      CANOPY_CENTRE.r * CANOPY_CENTRE.flatten * CANOPY_45_COS,
    8 + CANOPY_PARALLAX_Z + CANOPY_CENTRE.r * CANOPY_45_SIN,
  ] as const),
});

/**
 * A per-face colour, expressed as the **ratio** between an art §3.1 detail token
 * and the material's own token.
 *
 * three multiplies `material.color` by the vertex colour, so storing the ratio
 * (rather than the absolute colour) is what lets `material.color` stay equal to
 * the authored token. That matters beyond tidiness: art §3.0's promise and the
 * calibration probe both read `material.color`, so baking absolute colours into
 * the attribute would make the probe measure a surface that is not on screen.
 *
 * Both `Color`s are in the linear working space (three converts on construction
 * from a hex), which is the space the shader multiplies in, so the ratio is
 * correct without any further conversion. Values above 1 are legitimate and
 * expected — `brickTopLip` is *brighter* than `brickTop`.
 */
function faceTint(token: number, base: number): [number, number, number] {
  const t = new Color(token);
  const b = new Color(base);
  const safe = (n: number, d: number): number => (d > 1e-6 ? n / d : 1);
  return [safe(t.r, b.r), safe(t.g, b.g), safe(t.b, b.b)];
}

/** The material's own token, unmodified. */
const PLAIN: [number, number, number] = [1, 1, 1];

/**
 * Accumulates non-indexed triangles with positions, normals and vertex colours.
 * Hand-rolled rather than pulled from `examples/jsm/utils/BufferGeometryUtils`:
 * three's merge helper requires every source to carry the identical attribute
 * set, and these geometries mix hand-written quads with `SphereGeometry`.
 */
class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];

  /**
   * A quad from four corners in counter-clockwise order when viewed from the
   * front. The normal is derived from the winding, so a face that comes out
   * black is a winding bug rather than a lighting one.
   */
  quad(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    tint: readonly number[],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const v of [a, b, c, a, c, d]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(tint[0], tint[1], tint[2]);
    }
  }

  /** Horizontal quad facing +y, spanning `x0…x1` by `z0…z1` at height `y`. */
  top(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    y: number,
    tint: readonly number[],
  ): void {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], tint);
  }

  /** The four outward-facing side walls of an axis-aligned box (no top/bottom). */
  walls(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    y0: number,
    y1: number,
    tint: readonly number[],
  ): void {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], tint); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], tint); // −z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], tint); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], tint); // −x
  }

  /** Appends another geometry, translated and scaled, at one flat colour. */
  add(
    geo: BufferGeometry,
    scale: readonly number[],
    offset: readonly number[],
    tint: readonly number[],
  ): void {
    const src = geo.index === null ? geo : geo.toNonIndexed();
    const p = src.getAttribute('position');
    const n = src.getAttribute('normal');
    // Normals transform by the inverse-transpose, which for a diagonal scale is
    // the reciprocal — spelled out because a flattened sphere lit with unscaled
    // normals is exactly the kind of error that looks "nearly right".
    const inv = [1 / scale[0], 1 / scale[1], 1 / scale[2]];
    for (let i = 0; i < p.count; i++) {
      this.pos.push(
        p.getX(i) * scale[0] + offset[0],
        p.getY(i) * scale[1] + offset[1],
        p.getZ(i) * scale[2] + offset[2],
      );
      const nx = n.getX(i) * inv[0];
      const ny = n.getY(i) * inv[1];
      const nz = n.getZ(i) * inv[2];
      const len = Math.hypot(nx, ny, nz) || 1;
      this.nrm.push(nx / len, ny / len, nz / len);
      this.col.push(tint[0], tint[1], tint[2]);
    }
    if (src !== geo) src.dispose();
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    return geo;
  }
}

/**
 * One brick subcell (art §5): an 8 u box 10 u tall whose top face carries an
 * inset **mortar groove** and a raised lip. Centred on the origin in XZ with its
 * base at y = 0, so the instance matrix is a pure translation.
 *
 * Three colours, one material: sides at `brickTop`, the recessed ring at
 * `brickMortar`, the raised cap at `brickTopLip`. Neighbouring subcells butt
 * together, so two adjacent grooves read as one 2 u mortar line — which is what
 * makes a full brick tile read as brickwork rather than as one flat block.
 */
export function createBrickGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const h = SUBCELL / 2;
  const inner = h - MORTAR_INSET;
  const shoulder = TERRAIN_H - MORTAR_DROP;
  const mortar = faceTint(PALETTE.brickMortar, PALETTE.brickTop);
  const lip = faceTint(PALETTE.brickTopLip, PALETTE.brickTop);

  b.walls(-h, h, -h, h, 0, shoulder, PLAIN);
  // The groove floor, as four quads around the raised cap.
  b.top(-h, h, -h, -inner, shoulder, mortar);
  b.top(-h, h, inner, h, shoulder, mortar);
  b.top(-h, -inner, -inner, inner, shoulder, mortar);
  b.top(inner, h, -inner, inner, shoulder, mortar);
  b.walls(-inner, inner, -inner, inner, shoulder, TERRAIN_H, PLAIN);
  b.top(-inner, inner, -inner, inner, TERRAIN_H, lip);
  return b.build();
}

/**
 * One steel subcell (art §5): 8 u box, 10 u tall, **beveled top** and a **centre
 * rivet**. The bevel is what separates steel from brick in grayscale — it turns
 * the flat top into two tones by catching the key light at a different angle,
 * which art §11 asks for ahead of colour.
 */
export function createSteelGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const h = SUBCELL / 2;
  const inner = h - STEEL_BEVEL;
  const shoulder = TERRAIN_H - STEEL_BEVEL;
  const rivet = faceTint(PALETTE.steelRivet, PALETTE.steelTop);

  b.walls(-h, h, -h, h, 0, shoulder, PLAIN);
  // Bevel: four sloped quads from the outer shoulder up to the inset top.
  b.quad(
    [-h, shoulder, h],
    [h, shoulder, h],
    [inner, TERRAIN_H, inner],
    [-inner, TERRAIN_H, inner],
    PLAIN,
  );
  b.quad(
    [h, shoulder, -h],
    [-h, shoulder, -h],
    [-inner, TERRAIN_H, -inner],
    [inner, TERRAIN_H, -inner],
    PLAIN,
  );
  b.quad(
    [h, shoulder, h],
    [h, shoulder, -h],
    [inner, TERRAIN_H, -inner],
    [inner, TERRAIN_H, inner],
    PLAIN,
  );
  b.quad(
    [-h, shoulder, -h],
    [-h, shoulder, h],
    [-inner, TERRAIN_H, inner],
    [-inner, TERRAIN_H, -inner],
    PLAIN,
  );
  b.top(-inner, inner, -inner, inner, TERRAIN_H, PLAIN);
  // Rivet. Its underside is coincident with the top face and deliberately not
  // emitted — an invisible face that would z-fight if it were.
  b.walls(
    -RIVET_HALF,
    RIVET_HALF,
    -RIVET_HALF,
    RIVET_HALF,
    TERRAIN_H,
    TERRAIN_H + RIVET_H,
    rivet,
  );
  b.top(
    -RIVET_HALF,
    RIVET_HALF,
    -RIVET_HALF,
    RIVET_HALF,
    TERRAIN_H + RIVET_H,
    rivet,
  );
  return b.build();
}

/**
 * The water surface: one tile-sized plane at the bottom of the pit the board is
 * cut away for (`SceneRoot.setPits`). Centred on the origin in XZ.
 *
 * **Static this task, by the brief's permission.** Art §5 asks for two scrolling
 * sine-warped normal layers, fresnel and edge foam; that is a custom shader and
 * belongs with the rest of the water polish in T4.x. What ships here is the
 * `waterDeep` token on a glossy surface, which is the readable half.
 */
export function createWaterGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const h = TILE / 2;
  b.top(-h, h, -h, h, -WATER_DEPTH, PLAIN);
  return b.build();
}

/**
 * A canopy cluster (art §5): four flattened spheres at 14 u over a dark trunk
 * hint. Centred on the tile's origin in XZ.
 *
 * The spheres are the first non-axis-aligned surfaces in the project. Art §6's
 * closing note flags exactly this: the hemisphere blend is `0.5·cos θ + 0.5`, so
 * every normal between vertical and horizontal samples a band no calibration
 * target covers — measured and reported rather than tuned, per the brief.
 */
export function createTreesGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  // The segment count is a coverage decision rather than a smoothness one — see
  // CANOPY_FACET_GAIN. 8×6 costs 80 triangles a blob, 400 a tile, ~68 k on a
  // board that is all trees (the worst case, and not one any stage uses).
  const sphere = new SphereGeometry(1, CANOPY_SEGMENTS, 6);
  const depth = faceTint(PALETTE.treesDepth, PALETTE.treesCanopy);
  const highlight = faceTint(PALETTE.treesHighlight, PALETTE.treesCanopy);

  // Trunk hint: a dark stub the cluster sits on. It is what stops a canopy from
  // reading as a floating blob when no tank is beneath it. Leaned south with
  // height so it meets the (screen-registered) cluster instead of appearing to
  // stand well north of it.
  const trunkTop = CANOPY_Y - 2;
  b.quad(
    [-1.6, 0, 1.6],
    [1.6, 0, 1.6],
    [1.6, trunkTop, 1.6 + CANOPY_PARALLAX_Z],
    [-1.6, trunkTop, 1.6 + CANOPY_PARALLAX_Z],
    depth,
  );
  b.quad(
    [1.6, 0, -1.6],
    [-1.6, 0, -1.6],
    [-1.6, trunkTop, -1.6 + CANOPY_PARALLAX_Z],
    [1.6, trunkTop, -1.6 + CANOPY_PARALLAX_Z],
    depth,
  );
  b.quad(
    [1.6, 0, 1.6],
    [1.6, 0, -1.6],
    [1.6, trunkTop, -1.6 + CANOPY_PARALLAX_Z],
    [1.6, trunkTop, 1.6 + CANOPY_PARALLAX_Z],
    depth,
  );
  b.quad(
    [-1.6, 0, -1.6],
    [-1.6, 0, 1.6],
    [-1.6, trunkTop, 1.6 + CANOPY_PARALLAX_Z],
    [-1.6, trunkTop, -1.6 + CANOPY_PARALLAX_Z],
    depth,
  );

  for (let i = 0; i < CANOPY_BLOBS.length; i++) {
    const [rx, rz, ry, ox, oy, oz] = CANOPY_BLOBS[i];
    b.add(
      sphere,
      [rx * CANOPY_FACET_GAIN, ry, rz * CANOPY_FACET_GAIN],
      [ox, CANOPY_Y + oy, oz + CANOPY_PARALLAX_Z],
      // The centre blob carries the material's own `treesCanopy` token and the
      // satellites alternate brighter/darker, so the cluster has internal value
      // structure rather than reading as one flat mass.
      //
      // Centre = PLAIN is load-bearing for the calibration probe, not just
      // taste: {@link CANOPY_PROBE} samples this blob, and tinting it would make
      // the harness compare a `treesHighlight` surface against the
      // `treesCanopy` token and report a 30% "deviation" that is nothing but
      // the ratio between two authored colours. (Measured — that is exactly
      // what the first run of the probe said.)
      i === 0 ? PLAIN : i % 2 === 1 ? highlight : depth,
    );
  }
  sphere.dispose();
  return b.build();
}

/**
 * An ice decal: a flush tile-sized quad with two faint sheen streaks (art §5),
 * lifted a hair off the board so it does not z-fight. Centred in XZ.
 */
export function createIceGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const h = TILE / 2;
  const sheen = faceTint(PALETTE.iceSheen, PALETTE.ice);
  b.top(-h, h, -h, h, ICE_LIFT, PLAIN);
  // Streaks sit fractionally above the sheet. Both are inside the tile, so a
  // field of ice reads as separate slabs rather than one continuous sheet.
  b.top(-h + 2, h - 5, -3.4, -1.8, ICE_LIFT + 0.01, sheen);
  b.top(-h + 5, h - 2, 2.0, 3.2, ICE_LIFT + 0.01, sheen);
  return b.build();
}

// ---------------------------------------------------------------------------
// --- The view --------------------------------------------------------------
// ---------------------------------------------------------------------------

/** 26×26 subcells: the worst case for brick and for steel. */
const SUBCELL_CAP = FIELD_SUBCELLS * FIELD_SUBCELLS;
/** 13×13 tiles: the worst case for water, trees and ice. */
const TILE_CAP = FIELD_TILES * FIELD_TILES;

/**
 * Shovel blink rate while the wall is about to fail (art §8 uses 4 Hz for the
 * carrier flash; the same rate reads at this size). Two stamps a second over 20
 * subcells — not a rebuild.
 */
const BLINK_HZ = 4;

/** Trees draw after entities so a tank underneath is concealed, not revealed. */
const CANOPY_RENDER_ORDER = 20;

export interface TerrainView {
  /** One-time build from `state.terrain`. Idempotent per state object. */
  build(state: GameState): void;
  /** Dirty updates. Ignores every event that is not terrain damage. */
  onEvent(e: GameEvent): void;
  /** Advances the shovel blink. Allocation-free; a no-op when not blinking. */
  update(dtMs: number): void;
  dispose(): void;
}

export function createTerrainView(
  materials: Materials,
  sceneRoot: SceneRoot,
): TerrainView {
  const group = new Group();
  sceneRoot.scene.add(group);

  const geometries = {
    brick: createBrickGeometry(),
    steel: createSteelGeometry(),
    water: createWaterGeometry(),
    trees: createTreesGeometry(),
    ice: createIceGeometry(),
  };

  const brick = makeInstanced(geometries.brick, materials.terrainBrick, {
    cap: SUBCELL_CAP,
    castShadow: true,
    receiveShadow: true,
  });
  const steel = makeInstanced(geometries.steel, materials.terrainSteel, {
    cap: SUBCELL_CAP,
    castShadow: true,
    receiveShadow: true,
  });
  const water = makeInstanced(geometries.water, materials.terrainWater, {
    cap: TILE_CAP,
    castShadow: false,
    receiveShadow: true,
  });
  const trees = makeInstanced(geometries.trees, materials.terrainTrees, {
    cap: TILE_CAP,
    castShadow: true,
    receiveShadow: false,
    renderOrder: CANOPY_RENDER_ORDER,
  });
  const ice = makeInstanced(geometries.ice, materials.terrainIce, {
    cap: TILE_CAP,
    castShadow: false,
    receiveShadow: false,
  });
  group.add(brick, steel, water, trees, ice);

  const brickSlots = createSlotMap(SUBCELL_CAP);
  const steelSlots = createSlotMap(SUBCELL_CAP);

  /** The render layer's own copy of the subcell kinds — never core's array. */
  let kinds: Uint8Array = new Uint8Array(SUBCELL_CAP);
  let built = false;

  // Scratch, reused for the whole life of the view: the damage path must not
  // allocate (arch §11 asks for near-zero steady-state allocation in render).
  const scratchCells: number[] = [];
  const mat = new Matrix4();
  const swap = new Matrix4();
  const tint = new Color();

  let blinkT = 0;
  let blinkSteel = true;
  let blinking = false;

  // --- instance plumbing ---------------------------------------------------

  function placeSubcell(mesh: InstancedMesh, slot: number, key: number): void {
    const sx = key % FIELD_SUBCELLS;
    const sy = (key - sx) / FIELD_SUBCELLS;
    mat.makeTranslation(
      sx * SUBCELL + SUBCELL / 2,
      0,
      sy * SUBCELL + SUBCELL / 2,
    );
    mesh.setMatrixAt(slot, mat);
    if (mesh === brick) {
      // ±3% around the token, split slightly warm/cool so the variation reads
      // as brick texture rather than as a brightness ramp. Written straight into
      // r/g/b: `instanceColor` is a multiplier in the working space, not a
      // colour to be converted.
      const v = 1 + BRICK_JITTER * subcellJitter(sx, sy);
      const w = 1 + BRICK_JITTER * 0.5 * subcellJitter(sy, sx);
      tint.r = v * w;
      tint.g = v;
      tint.b = v / w;
      mesh.setColorAt(slot, tint);
    }
  }

  function placeTile(
    mesh: InstancedMesh,
    slot: number,
    tx: number,
    ty: number,
  ): void {
    mat.makeTranslation(tx * TILE + TILE / 2, 0, ty * TILE + TILE / 2);
    mesh.setMatrixAt(slot, mat);
  }

  function addSubcell(mesh: InstancedMesh, slots: SlotMap, key: number): void {
    const slot = slots.add(key);
    placeSubcell(mesh, slot, key);
    mesh.count = slots.count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  function removeSubcell(
    mesh: InstancedMesh,
    slots: SlotMap,
    key: number,
  ): void {
    const move = slots.remove(key);
    if (move === null) return;
    if (move.fromSlot !== move.slot) {
      // Back-fill: copy the last instance's matrix (and colour) into the hole
      // the removal left. The slot map has already repointed `move.key`.
      mesh.getMatrixAt(move.fromSlot, swap);
      mesh.setMatrixAt(move.slot, swap);
      if (mesh.instanceColor !== null) {
        const c = mesh.instanceColor;
        c.setXYZ(
          move.slot,
          c.getX(move.fromSlot),
          c.getY(move.fromSlot),
          c.getZ(move.fromSlot),
        );
        c.needsUpdate = true;
      }
    }
    mesh.count = slots.count;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Moves one subcell between the brick and steel meshes (or to nothing). */
  function setSubcellKind(key: number, kind: TerrainKind): void {
    const was = kinds[key];
    if (was === kind) return;
    if (was === Terrain.Brick) removeSubcell(brick, brickSlots, key);
    else if (was === Terrain.Steel) removeSubcell(steel, steelSlots, key);
    kinds[key] = kind;
    if (kind === Terrain.Brick) addSubcell(brick, brickSlots, key);
    else if (kind === Terrain.Steel) addSubcell(steel, steelSlots, key);
  }

  function stampRing(kind: TerrainKind): void {
    for (const [tx, ty] of BASE_RING_TILES) {
      const sx = tx * 2;
      const sy = ty * 2;
      setSubcellKind(subcellInstanceIndex(sx, sy), kind);
      setSubcellKind(subcellInstanceIndex(sx + 1, sy), kind);
      setSubcellKind(subcellInstanceIndex(sx, sy + 1), kind);
      setSubcellKind(subcellInstanceIndex(sx + 1, sy + 1), kind);
    }
  }

  return {
    build(state: GameState): void {
      if (built) return;
      built = true;
      kinds = terrainFromState(state);

      // Cut the board open under the water tiles and skip the lattice over
      // them, so the recess of art §5 is actually visible: a plane at −3 u under
      // an unbroken ground plane renders to nothing at all.
      sceneRoot.setPits(
        (tx, ty) =>
          kinds[subcellInstanceIndex(tx * 2, ty * 2)] === Terrain.Water,
      );

      for (let sy = 0; sy < FIELD_SUBCELLS; sy++) {
        for (let sx = 0; sx < FIELD_SUBCELLS; sx++) {
          const key = subcellInstanceIndex(sx, sy);
          const kind = kinds[key];
          if (kind === Terrain.Brick) {
            placeSubcell(brick, brickSlots.add(key), key);
          } else if (kind === Terrain.Steel) {
            placeSubcell(steel, steelSlots.add(key), key);
          }
        }
      }

      let nWater = 0;
      let nTrees = 0;
      let nIce = 0;
      for (let ty = 0; ty < FIELD_TILES; ty++) {
        for (let tx = 0; tx < FIELD_TILES; tx++) {
          switch (kinds[subcellInstanceIndex(tx * 2, ty * 2)]) {
            case Terrain.Water:
              placeTile(water, nWater++, tx, ty);
              break;
            case Terrain.Trees:
              placeTile(trees, nTrees++, tx, ty);
              break;
            case Terrain.Ice:
              placeTile(ice, nIce++, tx, ty);
              break;
            default:
              break;
          }
        }
      }

      brick.count = brickSlots.count;
      steel.count = steelSlots.count;
      water.count = nWater;
      trees.count = nTrees;
      ice.count = nIce;
      for (const m of [brick, steel, water, trees, ice]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
      }
    },

    onEvent(e: GameEvent): void {
      switch (e.t) {
        case 'brickHit':
        case 'steelHit': {
          const n = maskSubcells(e.tx, e.ty, e.removedMask, scratchCells);
          for (let i = 0; i < n; i++) {
            setSubcellKind(scratchCells[i], Terrain.Empty);
          }
          break;
        }
        case 'shovelPhase':
          if (e.phase === 'steel') {
            blinking = false;
            stampRing(Terrain.Steel);
          } else if (e.phase === 'blink') {
            // The wall is still steel (the core never changes the kind here);
            // only its appearance alternates, as the warning that it is about
            // to revert.
            blinking = true;
            blinkT = 0;
            blinkSteel = true;
          } else {
            blinking = false;
            stampRing(Terrain.Brick);
          }
          break;
        default:
          break;
      }
    },

    update(dtMs: number): void {
      if (!blinking) return;
      blinkT += dtMs;
      const period = 1000 / (2 * BLINK_HZ);
      while (blinkT >= period) {
        blinkT -= period;
        blinkSteel = !blinkSteel;
        stampRing(blinkSteel ? Terrain.Steel : Terrain.Brick);
      }
    },

    dispose(): void {
      group.removeFromParent();
      for (const g of Object.values(geometries)) {
        g.dispose();
      }
      for (const m of [brick, steel, water, trees, ice]) {
        m.dispose();
      }
    },
  };
}

function makeInstanced(
  geo: BufferGeometry,
  material: Material,
  opts: {
    cap: number;
    castShadow: boolean;
    receiveShadow: boolean;
    renderOrder?: number;
  },
): InstancedMesh {
  const mesh = new InstancedMesh(geo, material, opts.cap);
  mesh.count = 0;
  // The matrices change on damage, not per frame, but they DO change — the
  // default STATIC_DRAW hint makes each re-upload a buffer re-allocation.
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.castShadow = opts.castShadow;
  mesh.receiveShadow = opts.receiveShadow;
  // An InstancedMesh's bounding sphere comes from its GEOMETRY, which here is
  // one 8 u block at the origin. Left on, three would cull the entire board the
  // moment the camera stopped looking at the top-left corner.
  mesh.frustumCulled = false;
  if (opts.renderOrder !== undefined) mesh.renderOrder = opts.renderOrder;
  return mesh;
}
