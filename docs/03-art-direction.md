# Battle City Remake — Art Direction

**Doc:** 03 · **Status:** Approved design (2026-07-20) · **Audience:** render/FX/UI implementers

Reference image: [assets/style-mockup.svg](assets/style-mockup.svg) (approved by the owner). The mockup is a static suggestion — the real game is fully dynamic 3D. When this doc and readability conflict, **readability wins** (GDD pillar 2).

## 1. Pillars

1. **A toy diorama under stage lights.** Low-poly, beveled, slightly chunky pieces on a dark board — like a premium board game photographed in a dark room with dramatic lighting.
2. **Light is the spectacle.** Explosions, muzzle flashes, tracers, and power-ups emit real light onto the scene. Emissive surfaces are rationed (bullets, flashes, power-ups, spawn stars, eagle emblem) so bloom stays special.
3. **Silhouette before color.** Every tank type and terrain type is identifiable in grayscale. Color reinforces, never carries alone.
4. **Motion sells the toy.** Track steps, turret recoil, body tilt into turns, debris with gravity — everything reacts physically.

## 2. Camera & framing

- Orthographic. Pitch **32°** from vertical, yaw **0°** (grid axes stay screen-aligned — readability). Board centered with ~0.75-tile margin; HUD docked right (landscape) or bottom (portrait).
- **Shake:** trauma-based (`trauma ∈ [0,1]`, decays 1.2/s; offset = trauma² · max 3 u; roll ≤ 0.3°). Sources: own shot +0.05, nearby explosion +0.25, base +0.6. Disabled by reduced-motion/setting.
- **Stage fly-in:** 600 ms ease from elevated pitch 55° down to 32° while the curtain wipe opens.
- **Base-destruction moment:** 0.6 s at 0.25× presentation speed + slight dolly-in (sim handles the scripted lock; see architecture §5).

## 3. Palette

### 3.0 What a token means (policy — added 2026-07-22 after T2.2 measurements)

A token is **the colour that must appear on screen** for flat graphic elements, and **albedo** for lit 3D surfaces. Two consequences, both binding on every render task:

- **Flat graphic elements** — board plane, grid lattice, frame wall, and any future 2D-reading overlay drawn in the 3D scene — set `toneMapped = false` so the authored hex survives ACES unchanged. Without this the dark tokens crush: T2.2 measured the grid at **1.07×** contrast against the board (invisible); opting out restores **1.88×**.
- **Lit 3D surfaces** — terrain, tanks, props — use the token as base colour and are modulated by lighting. The rig (§6) is calibrated so a **fully-lit horizontal surface reads within ±10% of its authored token**, so the palette still predicts what you see.

When a surface's role is ambiguous, ask whether it reads as *graphic* (part of the board's diagram) or as *object* (something the light falls on). Diagram → opt out; object → light it.

### 3.1 Tokens

Fixed tokens (render constants; UI mirrors via CSS custom properties):

| Token | Hex | Use |
|---|---|---|
| board | `#10121b` | ground plane |
| grid line | `#191d2b` | subtle lattice |
| brick top / side | `#bf5a33` / `#6f3118` | mortar `#8f3f20`, top lip `#d9744c` |
| steel top / side | `#b7c0cd` / `#5c6474` | rivet `#dde3ec` |
| water deep / wave | `#173f75` / `#4285d8` | highlight `#7db1ea` |
| trees canopy / depth | `#2e7d3a` / `#1c5527` | highlight `#46a04f` |
| ice | `#cadeed` @ 25% | sheen `#e8f4fb` |
| P1 tank | `#d99c2b` family | gold; accents `#f2c14e` |
| P2 tank | `#3aa655` family | green; accents `#7fd695` |
| Enemy Basic | gunmetal `#8a8f9c` + red `#cf4b4b` | compact silhouette |
| Enemy Fast | sand `#c8a05a` + orange | slim, long hull |
| Enemy Power | violet `#8f6bd0` | wide barrel shroud |
| Enemy Armor | silver `#c3cad6` layered plates | HP tints per fidelity §3.2 |
| Power-up / gold | `#ffd76b` (emissive) | star, pickups, eagle emblem |
| Spawn star / UI accent | `#7fc4ff` (emissive) | spawn, focus rings |
| Danger | `#e24b4a` | carrier flash, base-threat UI |

## 4. Entity models (all procedural — primitives + bevels, no imported meshes)

Shared proportions: tank footprint 16×16 u, height ~10 u. Parts: track blocks ×2, hull box (beveled), turret (cylinder/box), barrel (cylinder), + per-type trim. Player tier is visible: **+1 thin barrel ring per star tier**; tier 3 adds a gold emissive barrel tip.

| Entity | Silhouette recipe |
|---|---|
| Player | balanced hull, rounded turret, center barrel; P1 gold / P2 green |
| Basic | short hull, small turret set back |
| Fast | narrow hull (12 u wide), elongated, tracks exposed front |
| Power | standard hull, oversized barrel shroud (muzzle brake) |
| Armor | tall stacked plates (+2 u height), twin exhausts; plates tint by HP |
| Bullet | 4×4 u emissive capsule + short additive tracer trail |
| Eagle base | stone pedestal + gold shield emblem (emissive at low intensity); destroyed → cracked pedestal, fallen dimmed emblem, smoke wisps |
| Carrier state | whole-tank red emissive pulse at 4 Hz (fidelity §3.2) |
| Spawn star | flat emissive 4-point star billboard, twinkle scale 1.3 s + 2 rising rings |

## 5. Terrain construction

| Terrain | Build |
|---|---|
| Brick | 4 subcell boxes per tile, h = 10 u, per-subcell removal; mortar inset lines; slight per-subcell hue jitter (±3%) for texture |
| *(all terrain)* | **Author side faces explicitly** with their §3.1 side tokens rather than relying on the fill to produce them (ruled 2026-07-22). The rig satisfies the §6 vertical target with only ~2.4 points of margin, and that margin is bounded by the brick/steel hue spread rather than by tuning effort — a third side token outside that span would not fit. Per-face materials cost nothing here (the geometry is already split) and make the palette authoritative instead of emergent. The grid lattice is also a 1-device-pixel line, i.e. a hairline at DPR 2 — replace it with thin quads while you are laying terrain. |
| Steel | subcell boxes h = 10 u, beveled top, center rivet; brighter roughness contrast |
| Water | plane recessed −3 u with animated shader: two scrolling sine-warped normal layers + fresnel tint + soft edge foam against neighbors |
| Trees | canopy clusters (3–5 flattened spheres) floating at h = 14 u over a dark trunk hint; canopy renders **above tanks/bullets**; alpha ~0.95 with soft shadow blob |
| Ice | flush glossy decal, high specular, faint sheen streaks; skid marks fade in 2 s |
| Board edge | thin raised frame wall (h = 6 u) in `#262b3d` |

## 6. Lighting rig

- **Key:** directional, from top-left (azimuth −35°, elevation 50°), warm white (#fff2e0), shadow map 2048, `PCFShadowMap` (High preset). *(`PCFSoftShadowMap` is deprecated in the pinned three 0.185.1 — it silently falls back and warns every frame.)*
- **Fill:** hemisphere (cool sky #2a3550 / warm ground #1a1410).
- **Calibration targets replace fixed intensities** (amended 2026-07-22 — the original 3.0 / 0.35 pair measured a **1550:1** key:fill ratio and clipped every shadow to pure black, reading as holes punched in the board rather than shadow):
  1. A fully-lit horizontal surface reads **within ±10%** of its authored token (§3.0).
  2. Shadowed ground reads **15–35%** of lit ground luminance — dark enough to shape, light enough to keep the surface present.
  Tune key and fill to hit both, and record the measured values in the task report so later tasks inherit calibrated numbers rather than re-deriving them.
- **Calibrated values (T2.2, measured):** key 3.8, hemisphere fill 16.0, sky `#303543`, ground `#8f6b3d`, **tone-mapping exposure 0.70**. The fill colours are calibration *outputs*, not the authored `#2a3550`/`#1a1410` — see the lever note below.
- **The lever for vertical faces is `FILL_GROUND`, not sky saturation** (measured, T2.2 — my predicted lever was wrong). Three blends a hemisphere light by `0.5·dot(n, up) + 0.5`, so a horizontal surface samples **pure sky** while a vertical samples a **50/50 sky/ground mix**. Sweeping ground therefore moves vertical response (brick side −85% → +123%) while board, frame, tank and shadow stay **bit-identical at every step** — an orthogonal lever, which is what makes the three targets simultaneously satisfiable. Warmth is also load-bearing: a *neutral* ground splits brick and steel by 41.6 points, wider than the ±20% window, so no neutral value passes both. Exposure is a calibration *output*, not a fixed input: because §3.0 takes flat graphics off ACES, the two paths respond differently and no key/fill pair satisfies both — exposure is the only lever that reaches the lit path alone. Results: board +2.0%, frame +1.0%, tank +3.9%, grid exact, shadow at 23.1% of lit (4.3:1).
- **Material choice is part of the policy.** Flat graphics use a **Lambert** (pure diffuse) surface: a standard material's specular term does not scale with albedo, so calibrating on the near-black board left the frame 26.9% dark. Lit objects keep the standard material. The render layer **exports** two factories — `graphicSurface()` and `litSurface()` — and picking the wrong one is a calibration bug, not a style choice.
- **Which path each thing takes (definitive — this list settles it):** *graphic* = board plane, grid lattice, frame wall. *lit* = *all* terrain (brick, steel, water, trees, ice), tanks, bullets, props, power-ups. Terrain is an object the light falls on, not part of the board's diagram; an earlier code comment suggesting otherwise was wrong.
- `HemisphereLight.position` is a **direction**, not a location (a T2.2 bug had it tilting the sky axis 36° off vertical). Keep it `(0, 1, 0)`.
- The fit is two-point against a near-black board and a mid-tone tank; the ACES curve is non-linear, so **re-measure when introducing a materially different token** rather than assuming the deviation carries over.
- **Dynamic point-light pool (max 8, priority by proximity/importance):** muzzle flash (range 40 u, 60 ms), bullet glow (tiny, attached, Low: off), explosion (range 90 u, 400 ms, quadratic decay), base explosion (range 160 u, 1.2 s), power-up idle pulse (range 24 u, 1.2 s sine), spawn star (range 30 u).
- ACES tone mapping; **exposure is the calibrated 0.70 recorded above** — the original 1.1 predated the §3.0 split and is superseded.
- **Third target — vertical faces** (added after T2.2 measurement): a vertical face reads **within ±20%** of its authored side token. The first two targets constrain only horizontal, key-lit surfaces; shade sides are lit almost purely by the hemisphere fill, and at the calibrated intensity that fill is a saturated navy. Measured across five tank tokens the side response ranged **9.5%–20%** of the lit top and hue-shifted toward navy (a violet tank's side sampled near-pure blue) — i.e. shading depth tracked each token's blue content rather than the lighting. §3.1 authors *separate side tokens* for brick (`#6f3118`) and steel (`#5c6474`), so terrain depends on this directly. The expected lever is desaturating `FILL_SKY` while holding its luminance; re-measure rather than assuming.

## 7. Post-processing per quality preset

| Preset | Effects |
|---|---|
| High | UnrealBloom (strength 0.55, radius 0.4, threshold 0.85) + SMAA + vignette 0.25 + grade (slight teal shadows / warm highlights); DPR ≤ 2; shadows on |
| Medium | Bloom (0.4) + FXAA + vignette; DPR ≤ 1.5; shadows on (1024) |
| Low | FXAA only; DPR 1; shadows off; lights pool halved; particle budgets halved |

## 8. VFX event table (budgets are hard caps; pooled)

| Event | Recipe | Budget |
|---|---|---|
| Shot fired | muzzle star sprite 60 ms + point light + barrel recoil + 3 spark motes | 3 particles |
| Brick hit | 6–10 brick-colored chunk boxes, gravity 600 u/s², 1 bounce, 0.7 s life + dust puff | 10 |
| Steel hit (no damage) | 5 white-hot sparks, ricochet cone opposite bullet + *clink* light 40 ms | 5 |
| Steel destroyed | 8 metal shards + sparks | 12 |
| Tank explosion | flash sphere scale 1→2.2 over 120 ms, 12 debris chunks (hull-colored), 4 smoke puffs 1.2 s, expanding ground ring, point light | 20 |
| Player explosion | tank explosion + 200 ms white screen-edge flash (respect flash-reduction) | 20 |
| Base explosion | slow-mo beat + double ring shockwave + 5 gold emblem shards + tall smoke column + long light | 30 |
| Power-up spawn/pickup | gold burst 8 motes / ring + rising sparkles | 8 |
| Enemy spawn | star twinkle + 2 rising rings | 6 |
| Ice skid | 2 skid-mark decals + frost motes | 4 |
| Tree rustle (tank under canopy) | 3 leaf motes + canopy jiggle 150 ms | 3 |
| Stun (friendly fire) | yellow ring + orbiting stars over stunned tank | 4 |

Global cap ~180 live particles (High); FxSystem drops lowest-priority when exceeded.

## 9. Animation

| Thing | Spec |
|---|---|
| Tracks | stepped scroll, 8 u per visual step, rate ∝ speed; stationary = still |
| Turret recoil | 2 u back, 80 ms out-back ease per shot |
| Turn | hull yaw snaps logically; visual eases 100 ms with 2.5° lean into the turn |
| Engine idle | 0.3 u vertical vibration @ 9 Hz while moving (pairs with engine hum audio) |
| Power-up | bob ±2 u @ 1.2 s + 0.5 rps yaw + light pulse |
| Water | UV flow 0.05/s + secondary 0.023/s counter-flow |
| Trees | vertex sway noise, amplitude 0.6 u, frequency 0.4 Hz |
| Carrier flash | emissive pulse 4 Hz square (reads at small size) |
| Armor HP tint | crossfade 150 ms on hit + white hit-flash 60 ms (all tanks) |

## 10. HUD & UI style

- **Fonts (bundled OFL, woff2):** Orbitron (display: title, stage number, scores) + Inter (body/menus). Tabular numerals for scores.
- **HUD (right dock, landscape):** enemy-remaining icon grid (4×5 mini tank glyphs, dimming as consumed), per-player card (lives as tank pips, live score, tier stars), stage flag+number. Portrait/touch: slim top bar + bottom control zone.
- **Menus:** dark translucent panels (`#10121b` @ 92%) with 1 px `#262b3d` borders, gold accent for selection, cyan focus ring (gamepad/keyboard), 150 ms slide/fade transitions.
- **Curtain transition:** the NES gray curtain reimagined — twin steel shutters wipe in/out (300 ms each) synced with the camera fly-in.
- **Score popups:** world-space billboards (`+100`), Orbitron 10 u, float up 12 u, fade 700 ms.
- **Title screen:** logo built from beveled 3D letters on the board, attract-mode camera drift, tank silhouettes rolling by under rim light.

## 11. Readability & accessibility rules

- Type silhouettes distinct in grayscale (§4); carrier flash also modulates scale ±4% for colorblind visibility.
- Optional high-contrast mode: 1 px dark outlines on all tanks + brighter bullet tracers.
- Effects never cover the player's own tank for >100 ms; smoke max alpha 0.35 over playfield.
- `prefers-reduced-motion` or settings toggle: no shake, no slow-mo, no screen flash; all gameplay information preserved.
- Minimum contrast for HUD text 4.5:1 against its panel.
