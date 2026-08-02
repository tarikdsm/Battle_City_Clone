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
  AdditiveBlending,
  Color,
  DoubleSide,
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
  enemyFastTrim: 0xe08b3a,
  enemyPower: 0x8f6bd0,
  enemyArmor: 0xc3cad6,

  // Armor HP tints, 4 → 1 (art §3.1). `enemyArmor` IS the 4-HP entry, so this
  // table starts at 3. **Luminance-descending on purpose** — art §3.1: remaining
  // HP has to read in grayscale as well as in colour, which a hue-only ramp
  // (silver → green → yellow) would not deliver.
  enemyArmorHp3: 0x9fbb84,
  enemyArmorHp2: 0xb8963c,
  enemyArmorHp1: 0x6e7684,

  // Props (art §4's "stone pedestal"). Added 2026-08-02 with T3.3 — art §3.1
  // authored a colour for the eagle's *emblem* (`powerupGold`) and none for the
  // pedestal it stands on, so the doc gains a row rather than the code an
  // unauthored grey. Cool granite: 1.36× `brickTop` in luminance so the base
  // reads out of its own brick nest, and 0.77× `steelTop` so it is not mistaken
  // for the steel the Shovel stamps around it.
  //
  // Its saturation is 13.5%, i.e. far below art §6's "≥ 55% to hold hue on a
  // shaded face" rule, so this token reads **warm-sided by design** — the doc's
  // own pre-ruled outcome, measured in `docs/calibration/lighting.json`.
  eagleStone: 0x8d94a3,

  // FX (art §8's smoke: dust puffs, explosion smoke, the base's column, the
  // eagle's wisps). Added 2026-08-02 with T4.1/T4.2, by the same rule T3.3
  // established for `eagleStone`: art §8 asks for smoke in five of its twelve
  // rows and §3.1 authors no colour for it, so the doc gains a row rather than
  // the code an unauthored grey.
  //
  // Chosen against its neighbours: 4.4× `board` in luminance so a puff is
  // visible over the darkest thing it can sit on, and 0.83× `eagleStone` so it
  // never reads as a piece of the pedestal it drifts off. Its saturation is
  // 14.7%, i.e. below art §6's "≥ 55% to hold hue on a shaded face" threshold,
  // so it reads **warm-sided by design** — the outcome §6 pre-ruled for
  // near-neutral tokens, and the right one for smoke lit by an explosion.
  smoke: 0x7a808f,

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

// ---------------------------------------------------------------------------
// --- Art §11's high-contrast mode (T6.1) -----------------------------------
// ---------------------------------------------------------------------------

/**
 * ITU-R BT.601 luma of a token, on the **0–255 sRGB byte scale**.
 *
 * This is the scale art §11's finding is quoted on, and naming it matters
 * because three other scales give three other numbers for the same pair:
 * `#d99c2b` against `#8a8f9c` is **18.4** here, 8.1 as WCAG relative luminance
 * (×100), 6.4 as CIE L*, and 6.6 as HSL lightness. Art §11 says "~18", so the
 * doc's basis is this one, and everything measured against §11 must use it or
 * the numbers cannot be compared.
 *
 * Deliberately computed on the **gamma-encoded** bytes rather than on linear
 * light: BT.601 luma is defined that way, and it is also the quantity that
 * predicts what a grayscale print of the frame looks like — which is exactly
 * the colourblind-readability question §11 is asking.
 */
export function luma601(hex: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Scale a token's sRGB bytes by `k`, preserving hue, clamped to 0…255. */
export function scaleToken(hex: number, k: number): number {
  const ch = (shift: number): number =>
    Math.min(255, Math.max(0, Math.round(((hex >> shift) & 0xff) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Art §11's high-contrast mode — **required, not optional**.
 *
 * ## What §11 asks for, and why this is not literally it
 *
 * §11 prescribes "1 px dark outlines on all tanks + brighter bullet tracers".
 * The tracers are here. The outlines are **not**, and the reason is structural
 * rather than a shortcut: a tank in this renderer is one `InstancedMesh` whose
 * *instances are parts* (`tankView.ts`), so the usual inverted-hull outline
 * would trace every one of the ~20 boxes a tank is assembled from, not the
 * tank's silhouette — it would draw a dark grid over each tank instead of a rim
 * around it. A correct silhouette outline is a screen-space depth/normal edge
 * pass in the post chain, i.e. a task of its own.
 *
 * ## What this does instead, and why it is the stronger fix
 *
 * §11's *stated problem* is a value problem: "player-vs-enemy separation
 * currently leans on hue, which is exactly what a colourblind player does not
 * get". An outline does not move either body's value at all — it adds a dark
 * edge between a tank and the board. So this mode attacks the value directly,
 * with two rules and one number each:
 *
 * - **Players wear their own authored accent token** (`player1Accent`,
 *   `player2Accent`, art §3.1). Not an invented colour: it is the brightest
 *   value the palette already authors for that tank's family, so the tank keeps
 *   its hue and moves to the top of its own range.
 * - **Every enemy token is scaled by {@link ENEMY_SCALE}**, one uniform factor
 *   for all four. Uniform is the whole point: it preserves hue exactly, it
 *   preserves the *order* of the four enemy values, and it preserves the Armor
 *   HP ramp — `ARMOR_HP_TINT` is a ratio table against the `enemyArmor` token,
 *   so scaling the material colour scales all four HP tints with it.
 *
 * Measured (BT.601, 0–255), the worst player-vs-enemy pair goes from **2.6**
 * (P1 gold 161.4 vs Fast sand 164.0 — worse than the 18.4 §11 quotes) to
 * **59.8** (P2 accent 180.6 vs Armor 120.8). `docs/calibration/high-contrast.json`
 * carries the full matrix and `tests/render/materials.test.ts` pins it.
 */
export const HIGH_CONTRAST = Object.freeze({
  /**
   * 0.6. Chosen as the single factor that lands all four enemy tokens inside
   * 77…121 luma while the two player tokens sit at 181…195 — i.e. the widest
   * uniform separation available before the darkest enemy (Power, 77.6) stops
   * being comfortably above the `board` token's own 18.5.
   */
  ENEMY_SCALE: 0.6,
  /** Art §11's "brighter bullet tracers": the trail's alpha, 0.55 → 0.9. */
  TRACER_OPACITY: 0.9,
  /** …and its emissive term, 0.35 → 0.75, so it also blooms harder at High. */
  TRACER_EMISSIVE: 0.75,
});

/** The hex a tank skin wears in the given mode. Pure — this is what is measured. */
export function tankToken(key: TankMaterialKey, highContrast: boolean): number {
  if (!highContrast) {
    return PALETTE[key];
  }
  switch (key) {
    case 'player1':
      return PALETTE.player1Accent;
    case 'player2':
      return PALETTE.player2Accent;
    default:
      return scaleToken(PALETTE[key], HIGH_CONTRAST.ENEMY_SCALE);
  }
}

/** Every tank skin, in the order the separation matrix is reported in. */
export const TANK_SKIN_KEYS: readonly TankMaterialKey[] = Object.freeze([
  'player1',
  'player2',
  'enemyBasic',
  'enemyFast',
  'enemyPower',
  'enemyArmor',
]);

/**
 * The worst player-vs-enemy luma gap in a mode — the number art §11 is about.
 * A minimum over all four enemies × both players, so a single bad pair cannot
 * hide behind a good average.
 */
export function worstPlayerEnemySeparation(highContrast: boolean): number {
  let worst = Infinity;
  for (const p of ['player1', 'player2'] as const) {
    for (const e of [
      'enemyBasic',
      'enemyFast',
      'enemyPower',
      'enemyArmor',
    ] as const) {
      const gap = Math.abs(
        luma601(tankToken(p, highContrast)) -
          luma601(tankToken(e, highContrast)),
      );
      if (gap < worst) {
        worst = gap;
      }
    }
  }
  return worst;
}

/**
 * Switches the mode on the live materials. Idempotent, and a pure function of
 * the flag — toggling off restores the authored tokens exactly, because every
 * value is recomputed from `PALETTE` rather than remembered.
 *
 * Colour and opacity are **uniforms**, so nothing here needs a shader recompile
 * (unlike the shadow toggle in `renderer.ts`, which does).
 */
export function applyHighContrast(m: Materials, on: boolean): void {
  for (const key of TANK_SKIN_KEYS) {
    m[key].color.setHex(tankToken(key, on));
  }
  m.bulletTrail.opacity = on ? HIGH_CONTRAST.TRACER_OPACITY : 0.55;
  m.bulletTrail.emissiveIntensity = on ? HIGH_CONTRAST.TRACER_EMISSIVE : 0.35;
}

/**
 * Art §11: "smoke max alpha **0.35** over playfield". A readability constraint,
 * not a look — and it is delivered by *construction* here rather than by
 * per-particle tuning, because `InstancedMesh` has no per-instance alpha in
 * three 0.185.1: every smoke puff on the board shares this one number, so no
 * combination of events can push a single puff past §11's cap. (Puffs still
 * overlap, which is why they also disappear by shrinking rather than by
 * lingering — see `sizeFactorAt` in `fx/fxSystem.ts`.)
 */
export const SMOKE_ALPHA = 0.35;

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
  readonly bulletTrail: MeshStandardMaterial;
  readonly spawnStar: MeshStandardMaterial;
  readonly tierTip: MeshStandardMaterial;
  readonly propStone: MeshStandardMaterial;
  readonly propGold: MeshStandardMaterial;
  // --- FX (art §8), one material per particle kind ------------------------
  readonly fxDebris: MeshStandardMaterial;
  readonly fxSpark: MeshBasicMaterial;
  readonly fxSmoke: MeshStandardMaterial;
  readonly fxRing: MeshBasicMaterial;
  readonly fxFlash: MeshBasicMaterial;
  readonly fxScreenFlash: MeshBasicMaterial;
  // --- Camera FX (art §2, §10) — T4.3 -------------------------------------
  readonly curtain: MeshBasicMaterial;
  readonly popup: MeshBasicMaterial;
}

/**
 * Art §8's entity draw-call budget — the main-pass draws the tank and bullet
 * views may produce between them, one per `InstancedMesh`.
 *
 * **12, raised from 8 on 2026-08-02** to absorb the two emissive materials §8's
 * emissive ruling requires. Arch §11 caps the whole scene near 120 and a full
 * six-kind board measures 24, so this is a discipline rather than a hardware
 * limit: it exists so that adding an entity material is a *decision*.
 * `tests/render/models.test.ts` pins the current count against it, which is why
 * `bulletTrail` slipping in unnoticed at T2.4 cannot happen again.
 *
 * **T3.3 spent the last two**, and the budget is now exactly consumed: 12 of 12
 * (six tank skins, bullet head, tracer, spawn star, tier tip, `propStone`,
 * `propGold`). The next entity material is a budget decision for an owner, not
 * an implementation detail — art §8 raised this number once already and the
 * argument for raising it again is the same one (arch §11 caps the scene near
 * 120 and a populated board with the props measures **37** GL draws at High,
 * `docs/calibration/post.json → cost`), but it has to be *made*.
 */
export const ENTITY_DRAW_BUDGET = 12;

/**
 * The six skins a tank can wear — the subset of {@link MaterialsByRole} that
 * `models.ts` is allowed to name. Narrower than `keyof MaterialsByRole` on
 * purpose: it makes "a tank wears a tank material" a compile-time fact, and it
 * gives `mats[model.material]` a single concrete type rather than a union that
 * includes the board's Lambert.
 */
export type TankMaterialKey =
  | 'player1'
  | 'player2'
  | 'enemyBasic'
  | 'enemyFast'
  | 'enemyPower'
  | 'enemyArmor';

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
 * A per-detail colour, expressed as the **ratio** between an art §3.1 detail
 * token and the surface's own token.
 *
 * three multiplies `material.color` by the vertex colour **and** by an
 * `InstancedMesh`'s `instanceColor`, so storing the ratio (rather than the
 * absolute colour) is what lets `material.color` stay equal to the authored
 * token. That matters beyond tidiness: art §3.0's promise and
 * `scripts/calibrate-lighting.ts` both read `material.color`, so baking an
 * absolute colour into the attribute would make the probe measure a surface
 * that is not on screen.
 *
 * Both `Color`s are in the linear working space (three converts on construction
 * from a hex), which is the space the shader multiplies in, so the ratio is
 * correct without any further conversion. **Values well above 1 are legitimate
 * and expected** — the ratio that puts a gold tier tip on a green P2 tank is 23
 * in the red channel, because P2's red is 0.043 and gold's is 1.0. The
 * invariant is not "the ratio is small", it is "token × ratio is a real
 * colour"; `tests/render/models.test.ts` asserts exactly that.
 *
 * Lives here rather than in a view because both `terrainView.ts` (vertex
 * colours) and `models.ts` (instance colours) need it, and a second copy is how
 * two files drift apart.
 */
export function faceTint(
  token: number,
  base: number,
): [number, number, number] {
  const t = new Color(token);
  const b = new Color(base);
  const safe = (n: number, d: number): number => (d > 1e-6 ? n / d : 1);
  return [safe(t.r, b.r), safe(t.g, b.g), safe(t.b, b.b)];
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
 * one response.
 *
 * **`vertexColors` stays off, and that is load-bearing** (T2.4). Every tank is
 * one `InstancedMesh` per type whose *instances are parts*, and all per-part
 * trim plus every dynamic tint rides on `instanceColor`. Turning `vertexColors`
 * on would make three declare an `attribute vec3 color` that the shared part
 * geometry does not carry, and an unbound attribute reads (0, 0, 0) in WebGL2 —
 * every tank would render black. `instanceColor` alone is enough: it defines
 * `USE_COLOR` in the **fragment** prefix (`WebGLProgram.js`), which is where
 * `diffuseColor *= vColor` lives.
 */
export function tankSkin(hex: number): MeshStandardMaterial {
  return litSurface(hex);
}

/**
 * An **additive light graphic** — the FX layer's sparks, rings and flashes.
 *
 * Art §8's spawn-star ruling is the precedent, and the reasoning transfers
 * exactly: a surface that *is* light must not be lit, and must not be tone
 * mapped, or the ACES curve desaturates it before art §7's bloom can see it.
 * `AdditiveBlending` is what makes fading to black mean fading to nothing,
 * which is how every one of these disappears — `InstancedMesh` has no
 * per-instance alpha in three 0.185.1, so colour is the only per-particle
 * channel there is.
 *
 * `depthWrite` is off (an additive surface has no ordering requirement, but
 * writing depth would let one spark occlude the next) while `depthTest` stays
 * **on**, so a spark behind a steel wall is still behind it.
 */
export function additiveSurface(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({ color: 0xffffff });
  m.toneMapped = false;
  m.transparent = true;
  m.blending = AdditiveBlending;
  m.depthWrite = false;
  return m;
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

  // Art §4's "short **additive** tracer trail". It needs its own material and
  // cannot share the bullet's, for a reason that is easy to get wrong: three
  // applies vertex/instance colour to `diffuseColor` only — `emissive` is added
  // afterwards and is untouched by it (`color_fragment.glsl`). A trail drawn as
  // extra instances of the bullet mesh would therefore glow at exactly the
  // head's brightness however it was tinted, and read as a solid rod rather
  // than as a tracer. Dimmer emissive + additive blending is the falloff.
  //
  // `depthWrite: false` because the trail overlaps its own head and the tank
  // that fired it; additive blending has no ordering requirement, but writing
  // depth would let the near half of the trail occlude the far half.
  const bulletTrail = new MeshStandardMaterial({
    color: srgb(PALETTE.powerupGold),
    emissive: srgb(PALETTE.powerupGold),
    emissiveIntensity: 0.35,
    roughness: 0.4,
    metalness: 0,
  });
  bulletTrail.transparent = true;
  bulletTrail.opacity = 0.55;
  bulletTrail.blending = AdditiveBlending;
  bulletTrail.depthWrite = false;

  // Art §8's emissive ruling (2026-08-02). `emissive` is a **material**
  // property, so per-instance glow is impossible — and after T2.5's bloom lands,
  // bullets glowing while art §4's "flat emissive 4-point star billboard" does
  // not would invert §4's intent exactly. Both of these are uniform in colour
  // across every tank that shows them, so one shared material each covers the
  // whole field: +2 materials, not +6.
  //
  // The carrier pulse deliberately stays diffuse (an `instanceColor` blend
  // toward `danger`): it tints a whole tank per instance, which no shared
  // material can express, and it already reads as the strongest overlay on the
  // board.
  //
  // Neither carries `instanceColor`, so `material.color` IS the authored token
  // for both — art §3.0's promise kept by construction rather than by ratio.
  const spawnStar = new MeshStandardMaterial({
    color: srgb(PALETTE.spawnAccent),
    emissive: srgb(PALETTE.spawnAccent),
    emissiveIntensity: 1,
    roughness: 0.4,
    metalness: 0,
  });
  const tierTip = new MeshStandardMaterial({
    color: srgb(PALETTE.powerupGold),
    emissive: srgb(PALETTE.powerupGold),
    // Art §4 calls it "gold emissive"; §1 pillar 2 rations emissive so bloom
    // stays special, and a tier pip is a status read rather than a spectacle —
    // hence dimmer than a bullet in flight.
    emissiveIntensity: 0.7,
    roughness: 0.4,
    metalness: 0,
  });

  // --- Props (art §4's eagle base, fidelity §8's power-ups) — T3.3 ---------
  //
  // TWO materials for two props and seven objects, which is the whole reason
  // they fit: `propStone` carries the pedestal in both its states, and
  // `propGold` carries the eagle's emblem *and* all six power-up shapes,
  // because art §3.1 authors them the **same token** ("Power-up / gold …
  // star, pickups, eagle emblem"). One shared emissive material, not seven.
  const propStone = litSurface(PALETTE.eagleStone);

  // Art §4 calls the emblem "emissive at low intensity" and art §1 pillar 2
  // lists power-ups among the rationed emissives, so both belong on this one
  // material — and `emissive` is a *material* property, so they necessarily
  // share an intensity. A power-up reads as the brighter of the two by AREA
  // instead (a whole 12 u object against a 10 u plate) and, once T4.x lands
  // art §6's dynamic point light, by the light it throws.
  //
  // **0.40, measured down from 0.55.** At 0.55 the emblem blew to a white core
  // under art §7's High bloom and took its own stepped relief with it — the
  // boss and the shoulders vanished into one glowing blob, which is the exact
  // opposite of §11's "silhouette before colour". 0.40 keeps the gold reading
  // as gold, still blooms, and sits between the tracer's 0.35 and the tier
  // pip's 0.7 — right for something that is on screen for a whole stage.
  const propGold = new MeshStandardMaterial({
    color: srgb(PALETTE.powerupGold),
    emissive: srgb(PALETTE.powerupGold),
    emissiveIntensity: 0.4,
    roughness: 0.4,
    metalness: 0,
  });

  // --- FX (art §8) — T4.1/T4.2 ---------------------------------------------
  //
  // Six materials for the whole VFX layer, and the count is the point: art §8
  // retired the entity-material quota in favour of **total scene draw calls
  // ≤ 60 at High**, and one material per particle *kind* is what turns §8's
  // ~180 live-particle cap into five draws instead of 180. See the header of
  // `fx/fxSystem.ts` for which effect lands on which kind.
  //
  // **Their base colour is white, deliberately, and it is the one place in this
  // file where `material.color` is not an authored token.** Every other surface
  // in the game wears one §3.1 colour for its whole life; a debris chunk wears
  // `brickTop` on one frame and `enemyArmor` on the next, so there is no token
  // for "debris" to be faithful to. The tokens ride on `instanceColor` instead
  // — `diffuseColor = color × instanceColor`, so a white base makes the
  // instance colour *be* the linear token rather than a ratio against one, and
  // the palette still predicts what appears. Nothing here is probed by
  // `scripts/calibrate-lighting.ts`; art §3.0's promise is about the surfaces
  // that are.
  const fxDebris = litSurface(0xffffff);
  const fxSmoke = litSurface(0xffffff);
  fxSmoke.transparent = true;
  fxSmoke.opacity = SMOKE_ALPHA;
  // A puff is a soft volume, not a solid: writing depth would let the near half
  // of a cluster occlude the far half and turn the smoke into cut-out shapes.
  fxSmoke.depthWrite = false;

  // Sparks, rings and flashes take art §8's **spawn-star ruling** (2026-08-02),
  // which is the closest precedent this doc has: an emissive overlay that must
  // read as its authored token goes *unlit*, `toneMapped = false`, and stays on
  // the bloom layer. These are light, not objects the light falls on — ACES at
  // the calibrated 0.70 exposure would desaturate a spark before bloom ever ran
  // — so they are `MeshBasicMaterial` on the flat-graphic path.
  //
  // Only two of the three go on `BLOOM_LAYER` (`fx/fxSystem.ts` decides):
  // art §1 pillar 2 rations the glow and names "flashes" among the rationed
  // set, so sparks and flashes bloom and the rings — which can span two tiles —
  // do not. A blooming shockwave washes the board out at exactly the moment
  // art §11 needs it readable.
  const fxSpark = additiveSurface();
  // The ring and the flash carry a **radial falloff in their vertex colours**
  // (`fx/fxSystem.ts`), which is what makes them read as light rather than as
  // solid shapes: an additive surface with no texture and no lighting has a
  // hard edge, and the first capture of this task photographed a "flash sphere"
  // as a flat gold hexagon two tiles wide. `instanceColor` multiplies on top,
  // so a recipe's own colour and the kind's fade both still apply.
  //
  // The spark deliberately does NOT carry the flag: its geometry is the shared
  // box and has no `color` attribute, and an unbound attribute reads (0, 0, 0)
  // in WebGL2 — every spark would render black (the same trap `tankSkin`
  // documents for tanks).
  const fxRing = additiveSurface();
  fxRing.vertexColors = true;
  const fxFlash = additiveSurface();
  fxFlash.vertexColors = true;

  // Art §8's player-explosion row: "200 ms white screen-edge flash". One quad
  // parented to the camera, so its opacity is a *material* value and needs no
  // per-instance channel; the edge falloff is baked into vertex colours
  // (`fx/fxSystem.ts`). `depthTest` off because it is drawn over the finished
  // board rather than into it.
  const fxScreenFlash = additiveSurface();
  fxScreenFlash.vertexColors = true;
  fxScreenFlash.depthTest = false;
  fxScreenFlash.opacity = 0;

  // --- Camera FX (art §2, §10) — T4.3 --------------------------------------
  //
  // Art §10's "NES gray curtain reimagined — twin steel shutters". A flat
  // graphic in the strictest sense of §3.0 (it is not in the world at all; it
  // is parented to the camera), so `toneMapped = false` puts the steel token on
  // screen unchanged. Opaque and `depthTest = false`: a shutter that let the
  // board through would not be a shutter.
  const curtain = new MeshBasicMaterial({ color: srgb(PALETTE.steelTop) });
  curtain.toneMapped = false;
  curtain.depthTest = false;
  curtain.depthWrite = false;
  // **`transparent`, despite being fully opaque** — and this is the bug it was
  // written for. three renders the opaque list before the transparent one, so
  // an opaque shutter at `renderOrder 9000` still draws *under* every
  // transparent object in the scene: the tree canopies (α 0.95) and the FX
  // hung in front of a shut curtain. Joining the transparent list is what makes
  // `renderOrder` mean "last".
  curtain.transparent = true;
  curtain.opacity = 1;
  // The two panels are the same quad with a flipped y scale, so one of them is
  // wound backwards. A screen-space plate has no inside.
  curtain.side = DoubleSide;
  // The body is a shaded plate and the leading edge a bright lip, both baked
  // into the quad's vertex colours — that lip is the only thing that makes two
  // steel shutters read as *two shutters* rather than as a blank grey screen.
  curtain.vertexColors = true;

  // Art §10's score popups. Additive for the same reason the FX flashes are —
  // fading a colour to black on an additive surface IS fading to nothing, and
  // `InstancedMesh` has no per-instance alpha — and because a glowing `+100`
  // over a near-black board is legible at 10 u without a font, which is what
  // §10's Orbitron becomes once T6.3 bundles it.
  const popup = additiveSurface();

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
    bulletTrail,
    spawnStar,
    tierTip,
    propStone,
    propGold,
    fxDebris,
    fxSpark,
    fxSmoke,
    fxRing,
    fxFlash,
    fxScreenFlash,
    curtain,
    popup,
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
