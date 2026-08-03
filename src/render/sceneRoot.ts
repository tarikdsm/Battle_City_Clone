// src/render/sceneRoot.ts — the scene graph, the camera rig and the lights
// (arch §5, art §2 and §6). It owns everything that is true about the *board*
// and knows nothing about `GameState`: pooled entity views are parented to
// `entities` by `renderer.ts`, and T2.3's terrain instancing joins them there.
//
// ## Coordinate mapping (the one thing to get right in this file)
//
// The core simulates a 208×208 u field with the origin at the **top-left**,
// +x right and **+y down** (`src/core/constants.ts`). Three.js is y-up, so the
// board is laid out in the **XZ plane**:
//
//     world x = core x      (right on screen)
//     world z = core y      (down the board — "south")
//     world y = height above the board
//
// No sign flips, no offset: a core coordinate is a world coordinate. The camera
// is what moves, not the field, so every position in this layer can be read
// straight off the simulation and compared against the fidelity spec by eye.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  OrthographicCamera,
  Scene,
  Vector3,
} from 'three';

import { FIELD_TILES, FIELD_U, TILE } from '../core/constants';
import { CALIBRATION, type Materials, type QualityPreset } from './materials';

// --- Board geometry (art §5 "Board edge", art §2 framing) ---

/** Raised frame wall around the field: 6 u tall (art §5), half a tile thick. */
const FRAME_H = 6;
const FRAME_W = TILE / 2;

/** Outer edge of the visible board — the field plus its frame on both sides. */
const BOARD_U = FIELD_U + 2 * FRAME_W;

/** Art §2: "~0.75-tile margin" of empty board around the framing. */
const MARGIN_U = 0.75 * TILE;

/**
 * Tallest thing the framing has to leave room for: tree canopies float at 14 u
 * (art §5). Height leans *up* the screen under a tilted camera, so this is
 * headroom, not a bounding box.
 */
const SCENE_H = 16;

/** The lattice sits a hair above the ground plane; coplanar would z-fight. */
const GRID_LIFT = 0.06;

/**
 * Nominal width of a lattice line, in **world** units.
 *
 * The lattice used to be a `LineSegments`, which WebGL renders at exactly one
 * *device* pixel however wide you ask: 0.5 CSS px at the High preset's DPR cap
 * of 2. A quad has a width in the world instead, so it scales with resolution.
 *
 * 0.4 u is ~1.6 CSS px at a 1600×900 viewport (the frustum fits 222 u into
 * 900 px, so 1 CSS px ≈ 0.247 u) — legible without turning art §3's "subtle
 * lattice" into a drawn grid. But world units alone are **not** a legibility
 * guarantee: see {@link GRID_MIN_CSS_PX}.
 */
const GRID_QUAD_W = 0.4;

/**
 * Legibility floor for a lattice line, in **CSS** pixels.
 *
 * The parameter that threatens the lattice is viewport **height**, not DPR
 * (T2.3 review, Important 3). `setViewport` fits a fixed world extent to the
 * viewport, so a world-space width converts to a CSS width that shrinks as the
 * viewport does. DPR was never at risk: a world-space width is DPR-invariant by
 * construction, which is why DPR-3 legibility follows from DPR-1.
 *
 * Measured on a 1200×400 viewport with this floor removed, i.e. at the fixed
 * 0.4 u the first cut shipped:
 *
 * | | 1600×900 @1 | 1200×400 @1 | 1200×400 @2 |
 * |---|---|---|---|
 * | fixed 0.4 u | 1.31× contrast | **1.00× — gone** | 1.47×, 1 CSS px |
 * | with this floor | 1.47× | **1.31×** | 1.58×, 2 CSS px |
 *
 * `1.00×` is not a thin line, it is *no* line: the lattice measured exactly the
 * board's own luminance. So the width is
 * `max(GRID_QUAD_W, GRID_MIN_CSS_PX × world-per-CSS-pixel)`, recomputed in
 * `setViewport`.
 *
 * Two notes for whoever tunes this. **2, not 1.5** — at 1.5 the short viewport
 * recovered only to 1.16× (MSAA dilutes a line that straddles a pixel boundary),
 * while 2 puts every measured configuration at or above the 1.31× the canonical
 * 1600×900 view already had. And the floor **governs at ordinary sizes**: it
 * only falls back to `GRID_QUAD_W` above ~1100 px of viewport height, so the
 * world-space constant now acts as the ceiling on a big display and this one is
 * what you see on a normal one.
 */
const GRID_MIN_CSS_PX = 2;

/**
 * Depth of a water pit (art §5's "recessed −3 u"). Owned here because the board
 * is what gets cut open; `terrainView.ts` imports it to place the water surface
 * on the pit floor, so the two cannot drift.
 */
export const PIT_DEPTH = 3;

/** Answers "is tile (tx, ty) a hole in the board?" — see `setPits`. */
export type PitTest = (tx: number, ty: number) => boolean;

const NO_PITS: PitTest = () => false;

// --- Camera rig (art §2) ---

/**
 * Pitch is measured **from vertical**: 0° would be a straight top-down view and
 * 90° a ground-level one, so 32° is a shallow tilt that keeps the board close to
 * a square on screen while giving every piece a visible side face.
 */
export const CAMERA_PITCH_RAD = (32 * Math.PI) / 180;
const PITCH_COS = Math.cos(CAMERA_PITCH_RAD);
const PITCH_SIN = Math.sin(CAMERA_PITCH_RAD);

/**
 * How far **south** a point has to move to stay at the same place on screen when
 * it is lifted one unit.
 *
 * The camera's up vector is `(0, sin θ, −cos θ)`, so screen height is
 * `y·sin θ − z·cos θ` and two points coincide on screen when
 * `Δz = Δy·tan θ`. Exported because anything that *floats* over the board —
 * tree canopies today (terrainView.ts), score popups and billboards later — has
 * to be placed in screen registration rather than plan registration, or it lands
 * visibly north of the thing it belongs to.
 */
export const PITCH_TAN = PITCH_SIN / PITCH_COS;

/**
 * Distance from the target. Irrelevant to the framing — this is an orthographic
 * camera, so the frustum size alone sets the scale — but it fixes where the near
 * and far planes have to be, and it is what the shake and fly-in rigs (T2.5)
 * will orbit.
 */
const CAMERA_DIST = 600;
const CAMERA_NEAR = 100;
const CAMERA_FAR = 1200;

/**
 * Half-extents, in world units, that the frustum must contain **measured on
 * screen** — i.e. after the tilt has foreshortened the board's depth axis.
 *
 * With yaw 0 the camera's right vector is world +x, so the horizontal axis is
 * unforeshortened. The camera's up vector is `(0, sin θ, −cos θ)`, so a metre of
 * world z occupies `cos θ` on screen and a metre of world *height* occupies
 * `sin θ`. The board therefore reads as 224 × 190 u, not 224 × 224.
 *
 * Height only ever leans *up* the screen, so the content volume's midpoint sits
 * `SCENE_H·sin θ / 2` above the board plane — which is why the camera aims at
 * `CAMERA_TARGET_Y` rather than at the ground. Without that offset the extra
 * headroom is all reserved at the top and the board renders measurably (1.5% of
 * viewport height) low.
 */
const HALF_X = BOARD_U / 2 + MARGIN_U;
const HALF_Y = (BOARD_U * PITCH_COS) / 2 + (SCENE_H * PITCH_SIN) / 2 + MARGIN_U;
const CAMERA_TARGET_Y = SCENE_H / 2;

// --- Key light (art §6) ---

/**
 * Azimuth is measured from screen-up (world −z) turning towards screen-right
 * (world +x), so the art doc's **−35°** puts the key 35° west of north: the
 * upper-left of the board, throwing every shadow down and to the right.
 */
const KEY_AZIMUTH_RAD = (-35 * Math.PI) / 180;
const KEY_ELEVATION_RAD = (50 * Math.PI) / 180;
const KEY_DIST = 300;
const KEY_COLOR = 0xfff2e0;

// Intensities and fill colours are calibration outputs, not rig geometry, and
// live in `CALIBRATION` (materials.ts) with the rest of the coupled set. Only
// the direction and colour of the key are fixed by art §6 and stay here.

/**
 * Half-width of the key light's shadow frustum. The board's half-diagonal is
 * `sqrt(2)·112 ≈ 158 u`, so 170 covers it from any azimuth with room for the
 * pieces standing on it — and no more, because every wasted unit costs shadow
 * texels.
 */
const SHADOW_EXTENT = 170;
const SHADOW_NEAR = 100;
const SHADOW_FAR = 520;

/**
 * The orthographic half-extents that contain the board at a viewport of `w × h`
 * CSS pixels.
 *
 * Contain-fit: grow whichever axis has slack so the board is never cropped, at
 * any aspect ratio, in either orientation. Extracted from `setViewport` at the
 * T9 follow-up so {@link tileCssPx} derives from the *same* arithmetic the
 * camera uses — a readability metric computed from a re-stated formula would
 * measure the re-statement.
 *
 * A zero-height viewport happens for real (a hidden tab, a collapsed flex
 * parent, the frame between a CSS change and layout); dividing by it would put
 * NaN in the projection matrix and blank the canvas for good.
 */
export function frustumHalfExtents(w: number, h: number): [number, number] {
  const aspect = h > 0 ? w / h : HALF_X / HALF_Y;
  if (aspect >= HALF_X / HALF_Y) {
    return [HALF_Y * aspect, HALF_Y];
  }
  return [HALF_X, HALF_X / aspect];
}

/**
 * How many CSS pixels **one field tile** spans horizontally at a viewport of
 * `w × h`.
 *
 * This is the project's readability number, and it is the one the T9 follow-up
 * argued about: the board is 13 × 13 (`FIELD_TILES`) and the game asks a player
 * to tell five tank silhouettes and six terrain types apart at a glance, so the
 * question "is this layout playable" is really "how big is a tile". Horizontal,
 * because the vertical axis is foreshortened by the camera pitch and the
 * unforeshortened axis is the honest one to quote.
 */
export function tileCssPx(w: number, h: number): number {
  const [, halfH] = frustumHalfExtents(w, h);
  if (h <= 0 || halfH <= 0) {
    return 0;
  }
  // Contain-fit makes the two axes' scales equal by construction, so either
  // one answers; the vertical is used because `h` is the axis that binds in
  // every landscape case this was written for.
  return (h / (2 * halfH)) * TILE;
}

export interface SceneRoot {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  /** Parent for pooled entity views (tanks, bullets). Owned by `renderer.ts`. */
  readonly entities: Group;
  /** Re-fit the orthographic frustum to a viewport of `w × h` CSS pixels. */
  setViewport(w: number, h: number): void;
  /**
   * Rebuilds the ground plane and the lattice with a **hole** at every tile
   * `isPit` accepts, plus a skirt down to the pit floor.
   *
   * This exists because art §5's water is "recessed −3 u" and a plane below an
   * unbroken ground plane is simply invisible — the board occludes it from
   * every angle this camera can take. Cutting the board is the only way the
   * recess reads, and the cut belongs here rather than in the terrain view: the
   * ground and the lattice are the board's own geometry, and the skirt is board
   * colour, so a pit reads as a hole dug in the board rather than as a separate
   * object sitting in one.
   *
   * Called once per level by `terrainView.build`, not per frame.
   */
  setPits(isPit: PitTest): void;
  /**
   * Re-pose the camera rig — art §2's shake, stage fly-in and dolly, all of
   * which `cameraFx.ts` drives and none of which may re-derive the rig itself.
   *
   * The rig math stays here because it is *this* file's: `CAMERA_DIST`, the
   * target point and the fact that the camera's up vector is
   * `(0, sin θ, −cos θ)` are all local facts, and a second copy in the camera
   * layer is how two files drift apart. `cameraFx.ts` supplies the numbers.
   *
   * @param pitchRad from **vertical**, like {@link CAMERA_PITCH_RAD}: 0 is
   * straight down and art §2's rest value is 32°. The stage fly-in eases from
   * 55° to that.
   * @param offsetX,offsetY the shake, in world units measured **on screen** —
   * along the camera's own right and up, so a given offset moves the image by
   * the same amount at any pitch.
   * @param roll about the view axis, in radians. Art §2 caps it at 0.3°.
   * @param zoom orthographic dolly. An ortho camera cannot dolly by moving —
   * distance does not change its framing — so art §2's "slight dolly-in" is a
   * frustum scale, which is the same image.
   */
  setCameraPose(
    pitchRad: number,
    offsetX: number,
    offsetY: number,
    roll: number,
    zoom: number,
  ): void;
  /** Apply a preset's shadow configuration to the key light. */
  setShadowQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createSceneRoot(materials: Materials): SceneRoot {
  const scene = new Scene();

  // The board sits in field coordinates (0…208), so the camera aims at its
  // centre rather than the world origin. Everything else — light rig, shadow
  // frustum — hangs off the same point.
  const center = new Vector3(FIELD_U / 2, 0, FIELD_U / 2);

  // --- Ground plane -------------------------------------------------------
  // Built tile by tile rather than as one quad, so `setPits` can leave holes in
  // it without a different code path. Still one mesh and one draw call; 169
  // quads is 676 vertices, which is noise.
  const ground = new Mesh(buildGroundGeometry(NO_PITS), materials.board);
  ground.receiveShadow = true;
  scene.add(ground);

  // --- Grid lattice -------------------------------------------------------
  // One mesh for all 28 lines: 13×13 individual meshes would be 169 draw calls
  // for decoration (arch §11 budgets a total of ~120).
  const grid = new Mesh(
    buildGridGeometry(NO_PITS, GRID_QUAD_W),
    materials.gridLine,
  );
  scene.add(grid);

  // --- Frame wall ---------------------------------------------------------
  // Four boxes off two shared geometries. Not merged: four draw calls is noise
  // against the budget, and keeping them as siblings means the editor's board
  // resize (if it ever lands) is a scale, not a rebuild.
  const frameNS = new BoxGeometry(BOARD_U, FRAME_H, FRAME_W);
  const frameEW = new BoxGeometry(FRAME_W, FRAME_H, FIELD_U);
  const frame = new Group();
  const y = FRAME_H / 2;
  frame.add(
    frameMesh(frameNS, materials, FIELD_U / 2, y, -FRAME_W / 2), // north
    frameMesh(frameNS, materials, FIELD_U / 2, y, FIELD_U + FRAME_W / 2), // south
    frameMesh(frameEW, materials, -FRAME_W / 2, y, FIELD_U / 2), // west
    frameMesh(frameEW, materials, FIELD_U + FRAME_W / 2, y, FIELD_U / 2), // east
  );
  scene.add(frame);

  // --- Lights (art §6) ----------------------------------------------------
  const key = new DirectionalLight(
    new Color(KEY_COLOR),
    CALIBRATION.keyIntensity,
  );
  key.position.set(
    center.x +
      KEY_DIST * Math.sin(KEY_AZIMUTH_RAD) * Math.cos(KEY_ELEVATION_RAD),
    center.y + KEY_DIST * Math.sin(KEY_ELEVATION_RAD),
    center.z -
      KEY_DIST * Math.cos(KEY_AZIMUTH_RAD) * Math.cos(KEY_ELEVATION_RAD),
  );
  // A DirectionalLight aims from its position at `target.position`, and the
  // target is only evaluated if it is in the scene — a detail that silently
  // lights the board from the wrong angle if you forget it.
  key.target.position.copy(center);
  scene.add(key.target);

  const shadowCam = key.shadow.camera;
  shadowCam.left = -SHADOW_EXTENT;
  shadowCam.right = SHADOW_EXTENT;
  shadowCam.top = SHADOW_EXTENT;
  shadowCam.bottom = -SHADOW_EXTENT;
  shadowCam.near = SHADOW_NEAR;
  shadowCam.far = SHADOW_FAR;
  shadowCam.updateProjectionMatrix();
  // Depth bias in shadow-map units and an offset along the surface normal in
  // world units. `normalBias` is what kills acne on the large flat board
  // without the peter-panning a big `bias` alone would cause.
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.7;
  // `shadow.radius` is deliberately NOT set: in this version it only drives the
  // VSM blur pass, and the PCF path takes its softness from the map resolution.
  // Setting it would look like a knob that does nothing.
  scene.add(key);

  const fill = new HemisphereLight(
    new Color(CALIBRATION.fillSky),
    new Color(CALIBRATION.fillGround),
    CALIBRATION.fillIntensity,
  );
  // `HemisphereLight.position` is read as a **direction from the world origin**,
  // not as a place: three normalises it and blends sky→ground by
  // `0.5·dot(normal, dir) + 0.5`. Putting it "above the board" at
  // (104, 200, 104) therefore tilted the sky axis 36° off vertical and left the
  // ground plane picking up 10% ground colour it should not see. Straight up is
  // the whole intent, and (0, 1, 0) is how you say it.
  fill.position.set(0, 1, 0);
  scene.add(fill);

  // --- Camera -------------------------------------------------------------
  // Frustum bounds are placeholders; `setViewport` sets the real ones before
  // the first frame and on every resize.
  const camera = new OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
  const camTarget = new Vector3(center.x, CAMERA_TARGET_Y, center.z);
  camera.position.set(
    camTarget.x,
    camTarget.y + CAMERA_DIST * PITCH_COS,
    camTarget.z + CAMERA_DIST * PITCH_SIN,
  );
  camera.lookAt(camTarget);
  scene.add(camera);

  const entities = new Group();
  scene.add(entities);

  const ownedGeometries: BufferGeometry[] = [frameNS, frameEW];

  // The lattice depends on two things that change independently — where the pits
  // are (per level) and how wide a CSS pixel is (per resize) — so both are
  // remembered and either can trigger the rebuild.
  let pitTest: PitTest = NO_PITS;
  let gridW = GRID_QUAD_W;

  function rebuildGrid(): void {
    grid.geometry.dispose();
    grid.geometry = buildGridGeometry(pitTest, gridW);
  }

  return {
    scene,
    camera,
    entities,

    setViewport(w: number, h: number): void {
      const [halfW, halfH] = frustumHalfExtents(w, h);
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();

      // Hold the lattice above its CSS-pixel floor (see GRID_MIN_CSS_PX). Only
      // rebuilt when the width actually moves, so a resize that does not cross a
      // threshold costs nothing; `h === 0` keeps the last known width rather
      // than dividing by zero.
      if (h > 0) {
        const worldPerCssPx = (2 * halfH) / h;
        const wanted = Math.max(GRID_QUAD_W, GRID_MIN_CSS_PX * worldPerCssPx);
        if (wanted !== gridW) {
          gridW = wanted;
          rebuildGrid();
        }
      }
    },

    setCameraPose(
      pitchRad: number,
      offsetX: number,
      offsetY: number,
      roll: number,
      zoom: number,
    ): void {
      const cos = Math.cos(pitchRad);
      const sin = Math.sin(pitchRad);
      // Orbit the fixed target at the fixed distance, then aim back at it.
      // Position first, orientation second: `lookAt` reads `position`.
      camera.position.set(
        camTarget.x,
        camTarget.y + CAMERA_DIST * cos,
        camTarget.z + CAMERA_DIST * sin,
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(camTarget);
      // The shake, applied AFTER `lookAt` so it slides the image rather than
      // re-aiming it — an orthographic camera translated perpendicular to its
      // own view axis shifts the whole frame by exactly that much. Right is
      // world +x at yaw 0; up is `(0, sin θ, −cos θ)`, the same vector
      // `PITCH_TAN` is derived from.
      camera.position.x += offsetX;
      camera.position.y += offsetY * sin;
      camera.position.z += offsetY * -cos;
      // Local z is the view axis (pointing back at the viewer), so this is roll.
      if (roll !== 0) {
        camera.rotateZ(roll);
      }
      if (camera.zoom !== zoom) {
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
      }
    },

    setPits(isPit: PitTest): void {
      pitTest = isPit;
      ground.geometry.dispose();
      ground.geometry = buildGroundGeometry(isPit);
      rebuildGrid();
    },

    setShadowQuality(preset: QualityPreset): void {
      key.castShadow = preset.shadows;
      if (!preset.shadows) {
        return;
      }
      if (key.shadow.mapSize.width !== preset.shadowMapSize) {
        key.shadow.mapSize.setScalar(preset.shadowMapSize);
        // The render target was sized from the *old* mapSize. Disposing it is
        // what makes three allocate a new one at the new resolution on the next
        // frame; assigning mapSize alone changes nothing that is already built.
        key.shadow.dispose();
      }
    },

    dispose(): void {
      ground.geometry.dispose();
      grid.geometry.dispose();
      for (const g of ownedGeometries) {
        g.dispose();
      }
      key.shadow.dispose();
      key.dispose();
      fill.dispose();
    },
  };
}

function frameMesh(
  geo: BufferGeometry,
  materials: Materials,
  x: number,
  y: number,
  z: number,
): Mesh {
  const mesh = new Mesh(geo, materials.boardFrame);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Appends one upward-facing quad (two triangles) in world coordinates. */
function pushTop(
  pos: number[],
  nrm: number[],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
): void {
  pos.push(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0);
  for (let i = 0; i < 6; i++) {
    nrm.push(0, 1, 0);
  }
}

/**
 * The board's ground: one quad per tile, minus the pits, plus an **inward**
 * facing skirt on every pit edge that borders solid board.
 *
 * Inward is the whole trick. The skirt wall on the *near* (south) side of a pit
 * faces north, away from this camera, so it is back-face culled and the player
 * sees down into the hole; the far wall faces the camera and closes it off.
 * Emitting outward normals instead would render a solid black lid over every
 * pond, which is exactly what it looks like when the winding is wrong.
 *
 * Skirts are skipped between two adjacent pits, so a lake is one basin rather
 * than a grid of wells.
 */
function buildGroundGeometry(isPit: PitTest): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const solid = (tx: number, ty: number): boolean =>
    tx < 0 ||
    ty < 0 ||
    tx >= FIELD_TILES ||
    ty >= FIELD_TILES ||
    !isPit(tx, ty);

  for (let ty = 0; ty < FIELD_TILES; ty++) {
    for (let tx = 0; tx < FIELD_TILES; tx++) {
      const x0 = tx * TILE;
      const x1 = x0 + TILE;
      const z0 = ty * TILE;
      const z1 = z0 + TILE;
      if (!isPit(tx, ty)) {
        pushTop(pos, nrm, x0, x1, z0, z1, 0);
        continue;
      }
      const y0 = -PIT_DEPTH;
      if (solid(tx, ty - 1)) {
        // North wall, facing south (+z) into the pit.
        pos.push(x0, y0, z0, x1, y0, z0, x1, 0, z0, x0, y0, z0, x1, 0, z0, x0, 0, z0); // prettier-ignore
        for (let i = 0; i < 6; i++) nrm.push(0, 0, 1);
      }
      if (solid(tx, ty + 1)) {
        pos.push(x1, y0, z1, x0, y0, z1, x0, 0, z1, x1, y0, z1, x0, 0, z1, x1, 0, z1); // prettier-ignore
        for (let i = 0; i < 6; i++) nrm.push(0, 0, -1);
      }
      if (solid(tx - 1, ty)) {
        pos.push(x0, y0, z1, x0, y0, z0, x0, 0, z0, x0, y0, z1, x0, 0, z0, x0, 0, z1); // prettier-ignore
        for (let i = 0; i < 6; i++) nrm.push(1, 0, 0);
      }
      if (solid(tx + 1, ty)) {
        pos.push(x1, y0, z0, x1, y0, z1, x1, 0, z1, x1, y0, z0, x1, 0, z1, x1, 0, z0); // prettier-ignore
        for (let i = 0; i < 6; i++) nrm.push(-1, 0, 0);
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  return geo;
}

/**
 * The 14 × 2 tile lines of the 13×13 field as **thin quads** — see
 * {@link GRID_QUAD_W} for why they are no longer lines.
 *
 * Built segment by segment (one per tile edge) so a segment with a pit on both
 * sides can be dropped: a lattice line stretched across an open pond would hang
 * in mid-air 3 u above the water. A segment on the *shore* is kept, where it
 * doubles as the pit's rim.
 */
function buildGridGeometry(isPit: PitTest, quadW: number): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const half = quadW / 2;
  const pit = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < FIELD_TILES && ty < FIELD_TILES && isPit(tx, ty);

  for (let i = 0; i <= FIELD_TILES; i++) {
    const at = i * TILE;
    for (let j = 0; j < FIELD_TILES; j++) {
      const from = j * TILE;
      const to = from + TILE;
      // Running north→south at x = at: drop it where both flanking tiles are pit.
      if (!(pit(i - 1, j) && pit(i, j))) {
        pushTop(pos, nrm, at - half, at + half, from, to, GRID_LIFT);
      }
      // Running west→east at z = at.
      if (!(pit(j, i - 1) && pit(j, i))) {
        pushTop(pos, nrm, from, to, at - half, at + half, GRID_LIFT);
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  return geo;
}
