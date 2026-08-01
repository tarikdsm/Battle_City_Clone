// src/render/materials.ts — the render layer's two frozen data tables (the
// palette of art §3 and the quality presets of art §7) plus the shared
// `THREE.Material` instances built from them.
//
// The tables are plain data on purpose: `tests/render/materials.test.ts` runs in
// the Vitest **node** environment, where there is no DOM and no WebGL, so
// anything it asserts has to be constructible without a GL context. The
// materials therefore live behind `createMaterials()` rather than being
// module-scope singletons — importing this file costs nothing but the tables.

import {
  Color,
  LineBasicMaterial,
  Material,
  MeshStandardMaterial,
} from 'three';

/**
 * The fixed colour tokens from `docs/03-art-direction.md` §3. **These hex values
 * are binding** — the doc is the spec, `tests/render/materials.test.ts` is the
 * enforcement, and the UI layer will mirror the same keys as CSS custom
 * properties (arch §8), so the names are part of the contract too: keep them
 * stable and role-descriptive rather than colour-descriptive (`player1`, not
 * `gold`).
 *
 * `as const` gives every entry a literal type, so a typo in a *key* is a compile
 * error and a drifted *value* is a test failure.
 */
export const PALETTE = Object.freeze({
  // Board
  board: 0x10121b,
  gridLine: 0x191d2b,
  boardFrame: 0x262b3d,

  // Terrain — brick
  brickTop: 0xbf5a33,
  brickSide: 0x6f3118,
  brickMortar: 0x8f3f20,
  brickTopLip: 0xd9744c,

  // Terrain — steel
  steelTop: 0xb7c0cd,
  steelSide: 0x5c6474,
  steelRivet: 0xdde3ec,

  // Terrain — water
  waterDeep: 0x173f75,
  waterWave: 0x4285d8,
  waterHighlight: 0x7db1ea,

  // Terrain — trees
  treesCanopy: 0x2e7d3a,
  treesDepth: 0x1c5527,
  treesHighlight: 0x46a04f,

  // Terrain — ice (see ICE_ALPHA)
  ice: 0xcadeed,
  iceSheen: 0xe8f4fb,

  // Players
  player1: 0xd99c2b,
  player1Accent: 0xf2c14e,
  player2: 0x3aa655,
  player2Accent: 0x7fd695,

  // Enemies
  enemyBasic: 0x8a8f9c,
  enemyBasicTrim: 0xcf4b4b,
  enemyFast: 0xc8a05a,
  enemyPower: 0x8f6bd0,
  enemyArmor: 0xc3cad6,

  // Emissive / signal
  powerupGold: 0xffd76b,
  spawnAccent: 0x7fc4ff,
  danger: 0xe24b4a,
} as const);

export type PaletteKey = keyof typeof PALETTE;

/**
 * Opacity of the ice decal (art §3: "ice `#cadeed` @ 25%"). Kept out of
 * `PALETTE` so that table stays exactly one thing — 24-bit colours — and a
 * consumer iterating it can never hand an alpha to `Color.setHex`.
 */
export const ICE_ALPHA = 0.25;

/** The three concrete quality levels. `'auto'` is a *settings* value that the
 *  app resolves to one of these before it reaches the renderer (T2.1 report). */
export type Quality = 'low' | 'medium' | 'high';

export interface QualityPreset {
  /** Upper bound on `devicePixelRatio`; the renderer takes the min of the two. */
  readonly dprCap: number;
  /** Whether the key light casts shadows at all. */
  readonly shadows: boolean;
  /** Shadow map edge in texels, or **0** when `shadows` is false. */
  readonly shadowMapSize: number;
}

/**
 * Art §7. Post-processing is deliberately absent: the composer is T2.5 and it
 * will extend this table (bloom/AA/vignette) rather than replace it.
 *
 * `shadowMapSize: 0` on Low encodes "there is no shadow map" as data, so no
 * caller has to decide what size a disabled map would have been.
 */
export const QUALITY_PRESETS: Readonly<Record<Quality, QualityPreset>> =
  Object.freeze({
    high: Object.freeze({ dprCap: 2, shadows: true, shadowMapSize: 2048 }),
    medium: Object.freeze({ dprCap: 1.5, shadows: true, shadowMapSize: 1024 }),
    low: Object.freeze({ dprCap: 1, shadows: false, shadowMapSize: 0 }),
  });

/**
 * Every shared material in the scene, created once and reused. Tank entries are
 * keyed so a pooled view can swap `mesh.material` by reference each frame
 * without allocating (see `renderer.ts`).
 */
export interface Materials {
  readonly board: MeshStandardMaterial;
  readonly boardFrame: MeshStandardMaterial;
  readonly gridLine: LineBasicMaterial;
  readonly player1: MeshStandardMaterial;
  readonly player2: MeshStandardMaterial;
  readonly enemyBasic: MeshStandardMaterial;
  readonly enemyFast: MeshStandardMaterial;
  readonly enemyPower: MeshStandardMaterial;
  readonly enemyArmor: MeshStandardMaterial;
  readonly bullet: MeshStandardMaterial;
  /** Every material above, once each — for `needsUpdate` sweeps and disposal. */
  readonly all: readonly Material[];
  dispose(): void;
}

/**
 * `new Color(hex)` treats the number as **sRGB** and converts it into the
 * renderer's linear working space (three's colour management has been on by
 * default since r152). That is what makes the art doc's hex values mean what
 * they look like: authoring a colour and reading it back with `getHexString()`
 * round-trips. Spelled out here because passing the raw number to the material
 * constructor would do the same thing silently, and the next person to touch
 * this needs to know it is deliberate rather than incidental.
 */
function srgb(hex: number): Color {
  return new Color(hex);
}

/** Matte, non-metallic surface — the board and everything terrain-like. */
function surface(hex: number, roughness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: srgb(hex),
    roughness,
    metalness: 0,
  });
}

/**
 * Painted-metal look shared by every tank: enough gloss for the key light to
 * pick out a highlight on the top face, not enough to look chrome. The bevels
 * and per-type trim that make these read as *tanks* arrive with the procedural
 * models in T2.4; here they dress plain boxes.
 */
function tankSkin(hex: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: srgb(hex),
    roughness: 0.55,
    metalness: 0.15,
  });
}

export function createMaterials(): Materials {
  const board = surface(PALETTE.board, 0.95);
  const boardFrame = surface(PALETTE.boardFrame, 0.8);

  // `linewidth` is deliberately not set: WebGL renders every line at 1 px
  // regardless, so setting it would only mislead.
  //
  // `toneMapped = false` is the one deliberate departure from "everything goes
  // through ACES", and it is what makes the lattice do its job. Measured on the
  // board at exposure 1.1: tone-mapped, `#191d2b` lands at luminance 15.5
  // against a board of 14.5 — a 7% difference, i.e. invisible, because ACES
  // compresses hardest exactly where these two colours live. Unmapped, the line
  // renders at the authored `#191d2b` (luminance 29) for a 2:1 contrast, which
  // is the ratio art §3 chose when it put `#191d2b` next to `#10121b`.
  //
  // Defensible beyond the numbers: the lattice is a flat readability aid, not a
  // lit surface (GDD pillar 2 — readability wins), and keeping it out of the
  // tone curve also keeps it out of T2.5's bloom, where a glowing grid would be
  // wrong anyway.
  const gridLine = new LineBasicMaterial({ color: srgb(PALETTE.gridLine) });
  gridLine.toneMapped = false;

  const player1 = tankSkin(PALETTE.player1);
  const player2 = tankSkin(PALETTE.player2);
  const enemyBasic = tankSkin(PALETTE.enemyBasic);
  const enemyFast = tankSkin(PALETTE.enemyFast);
  const enemyPower = tankSkin(PALETTE.enemyPower);
  const enemyArmor = tankSkin(PALETTE.enemyArmor);

  // Art §4: bullets are emissive. Without a bloom pass (T2.5) the emissive term
  // just holds the tracer at full brightness whatever the lighting does, which
  // is the readability half of the effect; the glow half lands with the composer.
  const bullet = new MeshStandardMaterial({
    color: srgb(PALETTE.powerupGold),
    emissive: srgb(PALETTE.powerupGold),
    emissiveIntensity: 1,
    roughness: 0.4,
    metalness: 0,
  });

  const all: readonly Material[] = [
    board,
    boardFrame,
    gridLine,
    player1,
    player2,
    enemyBasic,
    enemyFast,
    enemyPower,
    enemyArmor,
    bullet,
  ];

  return {
    board,
    boardFrame,
    gridLine,
    player1,
    player2,
    enemyBasic,
    enemyFast,
    enemyPower,
    enemyArmor,
    bullet,
    all,
    dispose(): void {
      for (const m of all) {
        m.dispose();
      }
    },
  };
}
