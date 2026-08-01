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
  LineSegments,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';

import { FIELD_TILES, FIELD_U, TILE } from '../core/constants';
import type { Materials, QualityPreset } from './materials';

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

// --- Camera rig (art §2) ---

/**
 * Pitch is measured **from vertical**: 0° would be a straight top-down view and
 * 90° a ground-level one, so 32° is a shallow tilt that keeps the board close to
 * a square on screen while giving every piece a visible side face.
 */
const CAMERA_PITCH_RAD = (32 * Math.PI) / 180;
const PITCH_COS = Math.cos(CAMERA_PITCH_RAD);
const PITCH_SIN = Math.sin(CAMERA_PITCH_RAD);

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
const KEY_INTENSITY = 3.0;

const FILL_SKY = 0x2a3550;
const FILL_GROUND = 0x1a1410;
const FILL_INTENSITY = 0.35;

/**
 * Half-width of the key light's shadow frustum. The board's half-diagonal is
 * `sqrt(2)·112 ≈ 158 u`, so 170 covers it from any azimuth with room for the
 * pieces standing on it — and no more, because every wasted unit costs shadow
 * texels.
 */
const SHADOW_EXTENT = 170;
const SHADOW_NEAR = 100;
const SHADOW_FAR = 520;

export interface SceneRoot {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  /** Parent for pooled entity views (tanks, bullets). Owned by `renderer.ts`. */
  readonly entities: Group;
  /** Re-fit the orthographic frustum to a viewport of `w × h` CSS pixels. */
  setViewport(w: number, h: number): void;
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
  // PlaneGeometry is built in XY facing +z; rotating −90° about x lays it flat
  // with its normal pointing +y.
  const groundGeo = new PlaneGeometry(FIELD_U, FIELD_U);
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new Mesh(groundGeo, materials.board);
  ground.position.copy(center);
  ground.receiveShadow = true;
  scene.add(ground);

  // --- Grid lattice -------------------------------------------------------
  // One `LineSegments` for all 28 lines: 13×13 individual meshes would be 169
  // draw calls for decoration (arch §11 budgets a total of ~120).
  const gridGeo = buildGridGeometry();
  const grid = new LineSegments(gridGeo, materials.gridLine);
  grid.position.set(0, GRID_LIFT, 0);
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
  const key = new DirectionalLight(new Color(KEY_COLOR), KEY_INTENSITY);
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
    new Color(FILL_SKY),
    new Color(FILL_GROUND),
    FILL_INTENSITY,
  );
  // Hemisphere light is directionless in the horizontal, but three still blends
  // sky→ground by the surface normal against the light's own up axis, so it has
  // to sit above the board rather than at the origin inside it.
  fill.position.set(center.x, 200, center.z);
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

  const ownedGeometries: BufferGeometry[] = [
    groundGeo,
    gridGeo,
    frameNS,
    frameEW,
  ];

  return {
    scene,
    camera,
    entities,

    setViewport(w: number, h: number): void {
      // A zero-height viewport happens for real: a hidden tab, a collapsed
      // flex parent, the frame between a CSS change and layout. Dividing by it
      // would put NaN in the projection matrix and blank the canvas for good.
      const aspect = h > 0 ? w / h : HALF_X / HALF_Y;
      // Contain-fit: grow whichever axis has slack so the board is never
      // cropped, at any aspect ratio, in either orientation.
      let halfW = HALF_X;
      let halfH = HALF_Y;
      if (aspect >= HALF_X / HALF_Y) {
        halfW = HALF_Y * aspect;
      } else {
        halfH = HALF_X / aspect;
      }
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
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

/**
 * The 14 × 2 tile lines of the 13×13 field as one non-indexed line list, in
 * world coordinates (the mesh itself sits at the origin, lifted off the ground).
 */
function buildGridGeometry(): BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i <= FIELD_TILES; i++) {
    const at = i * TILE;
    positions.push(at, 0, 0, at, 0, FIELD_U); // running north→south
    positions.push(0, 0, at, FIELD_U, 0, at); // running west→east
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geo;
}
