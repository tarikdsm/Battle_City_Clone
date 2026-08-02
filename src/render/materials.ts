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
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
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
 * The lighting rig's calibrated numbers, art §6. **All five move together** —
 * they are the solution to one system of three constraints, not five
 * independent knobs, which is why they live in one frozen table instead of
 * being spread across `sceneRoot.ts` and `renderer.ts` where a reader of either
 * file would see half the mechanism.
 *
 * The constraints (art §6):
 *   1. a fully-lit horizontal surface within ±10% of its token;
 *   2. shadowed ground at 15–35% of lit ground;
 *   3. a vertical face within ±20% of its authored *side* token.
 *
 * Which lever reaches which constraint is not obvious, and is the whole reason
 * a single-number tweak here is never safe:
 *
 * | lever | reaches |
 * |---|---|
 * | `keyIntensity` | every key-lit surface — target 1 |
 * | `fillSky` / `fillIntensity` | shadowed **horizontal** surfaces — target 2 |
 * | `fillGround` | **vertical** faces only — target 3 |
 * | `toneMappingExposure` | the ACES path only (lit 3D), not flat graphics |
 * | `litRoughness` / `litMetalness` | the specular term the exposure was fit through |
 *
 * `fillGround` reaching verticals *without* touching the ground plane is the
 * non-obvious one, and it is what makes targets 2 and 3 independently
 * satisfiable: three blends a hemisphere light by
 * `0.5·dot(normal, up) + 0.5`, so a horizontal surface samples **pure sky**
 * (weight 1) while a vertical face samples a **50/50 sky+ground mix**
 * (weight 0.5). Verified by measurement, not just by reading the shader.
 *
 * **Re-run `npm run calibrate:lighting` after touching anything here.**
 */
export interface Calibration {
  readonly keyIntensity: number;
  readonly fillIntensity: number;
  /** Hemisphere sky colour — reaches horizontal surfaces. */
  readonly fillSky: number;
  /** Hemisphere ground colour — reaches vertical faces (see above). */
  readonly fillGround: number;
  /** ACES exposure. Only affects tone-mapped (lit 3D) materials. */
  readonly toneMappingExposure: number;
  readonly litRoughness: number;
  readonly litMetalness: number;
}

export const CALIBRATION: Calibration = Object.freeze({
  keyIntensity: 3.8,
  fillIntensity: 16.0,
  // Art §6's `#2a3550` desaturated toward neutral at held luminance. The
  // saturation was the defect the third target was written against: a strongly
  // blue fill tints every shaded face toward navy regardless of its own colour
  // (a violet tank's side measured near-pure blue).
  fillSky: 0x303543,
  // Nothing like art §6's `#1a1410`, and the reason is structural rather than
  // aesthetic: this is the *only* lever that reaches vertical faces, so target 3
  // sets it outright. Warm because the two side tokens pull in opposite
  // directions — brick's albedo is warm and steel's is cool, so a neutral fill
  // splits them 41 points apart (wider than the ±20% window) while this warm one
  // closes the spread to 35 and lands both at ±17.5.
  fillGround: 0x8f6b3d,
  toneMappingExposure: 0.7,
  litRoughness: 0.55,
  litMetalness: 0.15,
});

/**
 * Every shared material in the scene, created once and reused. Tank entries are
 * keyed so a pooled view can swap `mesh.material` by reference each frame
 * without allocating (see `renderer.ts`).
 */
export interface MaterialsByRole {
  readonly board: MeshLambertMaterial;
  readonly boardFrame: MeshLambertMaterial;
  readonly gridLine: MeshBasicMaterial;
  readonly terrainBrick: MeshStandardMaterial;
  readonly terrainSteel: MeshStandardMaterial;
  readonly terrainWater: MeshStandardMaterial;
  readonly terrainTrees: MeshStandardMaterial;
  readonly terrainIce: MeshStandardMaterial;
  readonly player1: MeshStandardMaterial;
  readonly player2: MeshStandardMaterial;
  readonly enemyBasic: MeshStandardMaterial;
  readonly enemyFast: MeshStandardMaterial;
  readonly enemyPower: MeshStandardMaterial;
  readonly enemyArmor: MeshStandardMaterial;
  readonly bullet: MeshStandardMaterial;
}

export interface Materials extends MaterialsByRole {
  /**
   * Every material above, once each — for the `needsUpdate` sweep on a shadow
   * toggle and for disposal. **Derived** from the role record rather than
   * hand-listed: a material that made it into the record but not into this
   * array would compile fine and then fail silently, keeping its stale
   * compiled program across a Low→High switch (so it would never start
   * sampling shadows) and leaking on `dispose()`.
   */
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

/**
 * A **flat graphic element** in the sense of art §3.0 — part of the board's
 * *diagram*, not an object the light falls on.
 *
 * **This is exactly three things and the list is closed** (art §6): the board
 * plane, the grid lattice and the frame wall. Everything else in the game —
 * *all* terrain including brick, steel, water, trees and ice, plus tanks,
 * bullets, props and power-ups — is a lit object and uses {@link litSurface}.
 * (An earlier revision of this comment implied terrain belonged here. It does
 * not; terrain is something the light falls on.)
 *
 * Two decisions, both forced by measurement rather than taste:
 *
 * **`toneMapped = false`** — the stated point of §3.0. A fully-lit patch leaves
 * the shader at its authored token instead of being crushed by the ACES curve.
 * That only works because §6 calibrates the rig so full lighting multiplies
 * albedo by ~1.0: policy (§3.0) and calibration (§6) are two halves of one
 * mechanism, and changing either alone breaks the palette's promise.
 *
 * **`MeshLambertMaterial`, not `MeshStandardMaterial`** — subtle, and the
 * expensive find of T2.2. Standard adds a dielectric specular term that does
 * *not* scale with albedo, so it lifts a dark surface proportionally far more
 * than a light one. Calibrated against the near-black board, the frame wall then
 * landed **27% below** its token — same orientation, same lighting, shadows
 * ruled out by re-measuring with them off. Lambert in this version is pure
 * diffuse (`RE_Direct_Lambert` + `RE_IndirectDiffuse_Lambert`, no specular lobe
 * in the shader at all), so its output is strictly proportional to albedo and
 * one calibration serves all three flat graphics. It still receives shadows and
 * still shades the frame's sides darker than its top, which is what makes the
 * rim read as raised. "Flat" meaning "no gloss" is the right physics for a
 * diagram anyway.
 */
export function graphicSurface(hex: number): MeshLambertMaterial {
  const m = new MeshLambertMaterial({ color: srgb(hex) });
  m.toneMapped = false;
  return m;
}

/**
 * A **lit 3D surface** in the sense of art §3.0 — the token is albedo, and the
 * rig modulates it. Use this for *all* terrain, tanks, bullets, props and
 * power-ups; only the board, grid and frame use {@link graphicSurface}.
 *
 * `roughness`/`metalness` default to {@link CALIBRATION}'s values, and that
 * default is load-bearing rather than cosmetic: `toneMappingExposure` was fit
 * **through** this specular response, so a terrain material that overrides them
 * moves its own calibration off target 1. Overriding is legitimate — water and
 * ice want gloss, art §5 says so — but it is a calibration change, so re-run
 * `npm run calibrate:lighting` and re-measure that token rather than assuming
 * the tank's deviation carries over.
 */
export function litSurface(
  hex: number,
  opts?: { roughness?: number; metalness?: number },
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: srgb(hex),
    roughness: opts?.roughness ?? CALIBRATION.litRoughness,
    metalness: opts?.metalness ?? CALIBRATION.litMetalness,
  });
}

/**
 * The two terrain surfaces art §5 asks to be **glossy** — and therefore the two
 * that override {@link litSurface}'s calibrated response. Exported rather than
 * inlined at the call site because overriding is a *calibration* change: this
 * table is what `scripts/calibrate-lighting.ts` probes, so the harness can never
 * measure a different surface from the one that ships.
 *
 * **Roughness is a luminance lever here, not just a highlight width** — the
 * measurement that decided both numbers, and the opposite of what I assumed
 * going in. Sweeping `waterDeep`'s top face against art §6 target 1:
 *
 * | roughness | 0.22 | 0.28 | 0.32 | **0.34** | 0.36 | 0.40 | 0.55 (default) |
 * |---|---|---|---|---|---|---|---|
 * | vs token | −39.8% | −21.2% | −6.7% | **+0.1%** | +5.9% | +16.0% | +18.0% |
 *
 * Two consequences worth keeping:
 *
 * 1. `waterDeep` **fails target 1 at the calibrated default** (+18.0%). The
 *    gloss override is what brings it back to +0.1%, so for this token the
 *    override is a fix rather than a cost. Art §6's fit is two-point against a
 *    near-black board and a mid-tone gold tank, and this is the doc's own
 *    warning about re-measuring a materially different token coming true.
 * 2. Glossier is **darker** under this rig, steeply. The key's mirror direction
 *    off a horizontal surface misses this camera by ~35°, so narrowing the GGX
 *    lobe removes energy the camera was collecting and returns none. Ice at
 *    0.08 measured −14.1% (outside target 1) while the *broader* 0.34 measures
 *    −8.2% and looks glossier from the camera we actually have. "High specular"
 *    in the art doc is a look, and on this rig a mid roughness delivers it.
 *
 * Metalness stays at the calibrated {@link CALIBRATION.litMetalness} for both:
 * it lerps the diffuse lobe toward zero, so it costs luminance in direct
 * proportion, and at 0.30 ice measured 21% below its token with nothing gained.
 */
export const TERRAIN_GLOSS = Object.freeze({
  water: Object.freeze({
    roughness: 0.34,
    metalness: CALIBRATION.litMetalness,
  }),
  ice: Object.freeze({ roughness: 0.34, metalness: CALIBRATION.litMetalness }),
});

/**
 * Painted-metal preset over {@link litSurface}: enough gloss for the key light
 * to pick out a highlight on the top face, not enough to look chrome. A thin
 * wrapper on purpose — it is the calibrated default, so tanks and terrain share
 * one response. The bevels and per-type trim that make these read as *tanks*
 * arrive with the procedural models in T2.4; here they dress plain boxes.
 */
export function tankSkin(hex: number): MeshStandardMaterial {
  return litSurface(hex);
}

export function createMaterials(): Materials {
  const board = graphicSurface(PALETTE.board);
  const boardFrame = graphicSurface(PALETTE.boardFrame);

  // The lattice is the purest case of art §3.0: a diagram drawn on the board,
  // with no lighting model at all, so `toneMapped = false` puts exactly
  // `#191d2b` on screen. This is the measurement the policy was written from —
  // tone-mapped it landed 1.07× the board's luminance (invisible); unmapped it
  // is 1.6×.
  //
  // **`MeshBasicMaterial`, not `LineBasicMaterial`** (T2.3): the lattice is now
  // thin *quads* rather than lines, because a `LineSegments` renders at exactly
  // 1 **device** pixel whatever `linewidth` says — a hairline at DPR 2 and a
  // third of a CSS pixel at DPR 3, which is the acceptance bar. Basic is the
  // mesh analogue of Line*Basic*: both are unlit, so the rendered pixel is
  // bit-identical to what T2.2 measured and the calibration carries over
  // untouched. It is deliberately NOT `graphicSurface()` (Lambert) — that would
  // put the lattice on the lighting model for the first time and re-open a
  // calibration that currently measures exact.
  const gridLine = new MeshBasicMaterial({ color: srgb(PALETTE.gridLine) });
  gridLine.toneMapped = false;

  // --- Terrain (art §5) ----------------------------------------------------
  // All five are LIT surfaces (art §3.0's definitive list; terrain is something
  // the light falls on, not part of the board's diagram). Sides are deliberately
  // NOT authored from the §3.1 side tokens — see art §5's note: a side token
  // says what a side *reads as*, and feeding it as albedo renders sides at ~20%
  // of the top face. The rig produces the sides, and `calibrate-lighting.ts`
  // scores exactly that.
  //
  // Brick and steel carry `vertexColors`: mortar lines, the brick top lip, the
  // steel bevel and its rivet are per-FACE colours baked into one geometry, so
  // each stays a single draw call instead of one material per detail. The
  // attribute holds a *ratio* against the material colour (see `faceTint` in
  // terrainView.ts), which keeps `material.color` equal to the authored token —
  // the property art §3.0's promise and the calibration probe both rest on.
  const terrainBrick = litSurface(PALETTE.brickTop);
  terrainBrick.vertexColors = true;

  const terrainSteel = litSurface(PALETTE.steelTop);
  terrainSteel.vertexColors = true;

  const terrainWater = litSurface(PALETTE.waterDeep, TERRAIN_GLOSS.water);

  // Art §5: canopies render above tanks at alpha ~0.95 — concealment is a
  // gameplay-readable property, so the 5% is what keeps a hidden tank *hinted*
  // rather than erased. `depthWrite` stays on: the cluster is 4 overlapping
  // spheres and turning it off would let the far ones blend through the near.
  const terrainTrees = litSurface(PALETTE.treesCanopy);
  terrainTrees.vertexColors = true;
  terrainTrees.transparent = true;
  terrainTrees.opacity = 0.95;

  // Art §3: "ice `#cadeed` @ 25%" — a decal over the board, not a solid.
  // `depthWrite: false` because it is flush with the board (art §5) and writing
  // depth would make a 0.03 u decal occlude things standing *on* it.
  const terrainIce = litSurface(PALETTE.ice, TERRAIN_GLOSS.ice);
  terrainIce.vertexColors = true;
  terrainIce.transparent = true;
  terrainIce.opacity = ICE_ALPHA;
  terrainIce.depthWrite = false;

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

  // The single source of truth. `all` below is derived from it, so a new
  // material cannot be half-registered: adding it here without adding it to
  // `MaterialsByRole` is a compile error, and there is no third list to forget.
  const byRole: MaterialsByRole = {
    board,
    boardFrame,
    gridLine,
    terrainBrick,
    terrainSteel,
    terrainWater,
    terrainTrees,
    terrainIce,
    player1,
    player2,
    enemyBasic,
    enemyFast,
    enemyPower,
    enemyArmor,
    bullet,
  };

  // Keyed rather than `Object.values`, which types a plain interface as `any[]`.
  const all: readonly Material[] = Object.freeze(
    (Object.keys(byRole) as (keyof MaterialsByRole)[]).map((k) => byRole[k]),
  );

  return {
    ...byRole,
    all,
    dispose(): void {
      for (const m of all) {
        m.dispose();
      }
    },
  };
}
