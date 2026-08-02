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
| Enemy Fast | sand `#c8a05a` + orange `#e08b3a` | slim, long hull |
| Enemy Power | violet `#8f6bd0` | wide barrel shroud |
| Enemy Armor | silver `#c3cad6` layered plates | HP tints below |
| Armor HP 4/3/2/1 | `#c3cad6` / `#9fbb84` / `#b8963c` / `#6e7684` | silver → green → yellow → dark-silver, luminance descending so HP reads in grayscale too |
| Power-up / gold | `#ffd76b` (emissive) | star, pickups, eagle emblem |
| Spawn star / UI accent | `#7fc4ff` (emissive) | spawn, focus rings |
| Danger | `#e24b4a` | carrier flash, base-threat UI |
| Eagle pedestal | `#8d94a3` | granite plinth; the emblem on it uses the gold token above |

*(The pedestal row was added 2026-08-02 with T3.3 — §4 asked the eagle for a "stone pedestal" and §3.1 authored a colour for its emblem but none for the stone it stands on, so the prop shipped as the doc's first unauthored surface. Chosen against its neighbours rather than in isolation: **1.36× `brickTop`** in luminance so the base reads out of its own brick nest, **0.77× `steelTop`** so it is not mistaken for the steel the Shovel stamps around it. Its saturation is 13.5%, i.e. below §6's "≥ 55% to hold hue on a shaded face" threshold, so it reads **warm-sided by design** — the outcome §6 already pre-ruled for near-neutral tokens.)*

## 4. Entity models (all procedural — primitives + bevels, no imported meshes)

Shared proportions: tank footprint 16×16 u, height ~10 u. Parts: track blocks ×2, hull box (beveled), turret (cylinder/box), barrel (cylinder), + per-type trim. Player tier is visible: **+1 thin barrel ring per star tier**; tier 3 adds a gold emissive barrel tip.

| Entity | Silhouette recipe |
|---|---|
| Player | balanced hull, rounded turret, center barrel; P1 gold / P2 green |
| Basic | short hull, small turret set back |
| Fast | narrow hull (12 u wide), elongated, tracks exposed front |
| Power | standard hull, **barrel is the silhouette**: noticeably longer and thicker than any other type, ending in a blocky muzzle brake. Basic-vs-Power measured as the weakest grayscale pair at T2.4 (11% strongly-different area) — the fix is barrel mass, which reads from all four facings, not turret height, which does not. |
| Armor | tall stacked plates (+2 u height), twin exhausts; plates tint by HP |
| Bullet | 4×4 u emissive capsule + short additive tracer trail |
| Eagle base | stone pedestal + gold shield emblem (emissive at low intensity); destroyed → cracked pedestal, fallen dimmed emblem, smoke wisps. **The emblem is billboarded** (ruled 2026-08-02, T3.3): stood upright as §2's camera sees it, a 9 u shield is foreshortened to 53% and measures ~37 × 18 px at 1600×900 — a gold stripe. Turned to face the camera the same geometry is ~40 × 45 px. An emblem is a plaque, so nothing in this recipe fights it, and the doc's own "readability wins" rule is the licence. **"Dimmed" is implemented by leaving the emissive material**: `emissive` is a material property that no per-instance colour can reach, so the fallen emblem is drawn on the *pedestal's* material as a gold-against-stone ratio. |
| Carrier state | whole-tank red emissive pulse at 4 Hz (fidelity §3.2) |
| Spawn star | flat emissive 4-point star billboard, twinkle scale 1.3 s + 2 rising rings |

## 5. Terrain construction

| Terrain | Build |
|---|---|
| Brick | 4 subcell boxes per tile, h = 10 u, per-subcell removal; mortar inset lines; slight per-subcell hue jitter (±3%) for texture |
| *(all terrain)* | **Side appearance stays emergent — do NOT author side faces as albedo.** (An earlier ruling of mine said the opposite; it was reversed on measurement 2026-07-22.) A §3.1 side token describes *the colour a side reads as*, not a base colour: `brickSide` is already 41% of `brickTop` in luminance, so feeding it as albedo and then applying the rig's ~0.5 vertical-face response renders brick sides at roughly **20% of the top face** — darker than the palette intends and outside every §6 target. Taken literally, authoring sides makes the tokens *less* faithful. The emergent path currently reproduces both side tokens to within 17.5%. Revisit only if a third side token falls outside the brick–steel hue span, and if so pre-divide by the rig's vertical gain rather than assigning the token directly. The grid lattice is a 1-device-pixel line, i.e. a hairline at DPR 2 — replace it with thin quads while you are laying terrain (bar: legible at DPR 3). |
| Steel | subcell boxes h = 10 u, beveled top, center rivet; brighter roughness contrast |
| Water | plane recessed −3 u with animated shader: two scrolling sine-warped normal layers + fresnel tint + soft edge foam against neighbors. **The board plane must be cut open** where water sits (`SceneRoot.setPits`) — a recessed plane under an unbroken ground plane renders to nothing. The resulting pit walls are vertical flat graphics and are currently unmeasured (see §6's fourth note). Gloss is not optional: `waterDeep` fails §6 target 1 by **+18.0%** at the calibrated default roughness and lands at **+0.1%** with `roughness 0.34`. |
| Trees | canopy clusters (3–5 flattened spheres) floating at h = 14 u over a dark trunk hint; canopy renders **above tanks/bullets**; alpha ~0.95 with soft shadow blob. **The cluster overhangs its tile, deliberately** (ruled 2026-07-22): under the §2 32° tilt a tank's screen footprint is 22.3 u deep, so a canopy confined to its 16 u tile cannot cover it — concealment is a gameplay-readable property and wins over tile-tidiness. Measured 96.3% of the silhouette hidden at 26.4 u cluster depth. Note this couples to the camera pitch, which §2's stage fly-in animates: concealment is weaker at the intro's 55° pitch, which is harmless because player intents are gated for the whole intro (fidelity §11). |
| Ice | flush glossy decal, high specular, faint sheen streaks; skid marks fade in 2 s |
| Board edge | thin raised frame wall (h = 6 u) in `#262b3d` |

## 6. Lighting rig

- **Key:** directional, from top-left (azimuth −35°, elevation 50°), warm white (#fff2e0), shadow map 2048, `PCFShadowMap` (High preset). *(`PCFSoftShadowMap` is deprecated in the pinned three 0.185.1 — it silently falls back and warns every frame.)*
- **Fill:** hemisphere. Its colours are **calibration outputs**, not authored values — currently sky `#303543`, ground `#8f6b3d` (the authored `#2a3550`/`#1a1410` are superseded; see the calibration bullets below).
- **Calibration targets replace fixed intensities** (amended 2026-07-22 — the original 3.0 / 0.35 pair measured a **1550:1** key:fill ratio and clipped every shadow to pure black, reading as holes punched in the board rather than shadow):
  1. A fully-lit horizontal surface reads **within ±10%** of its authored token (§3.0).
  2. Shadowed ground reads **15–35%** of lit ground luminance — dark enough to shape, light enough to keep the surface present.
  Tune key and fill to hit both, and record the measured values in the task report so later tasks inherit calibrated numbers rather than re-deriving them.
- **Calibrated values (T2.2, measured):** key 3.8, hemisphere fill 16.0, sky `#303543`, ground `#8f6b3d`, **tone-mapping exposure 0.70**. The fill colours are calibration *outputs*, not the authored `#2a3550`/`#1a1410` — see the lever note below.
- **The lever for vertical faces is `FILL_GROUND`, not sky saturation** (measured, T2.2 — my predicted lever was wrong). Three blends a hemisphere light by `0.5·dot(n, up) + 0.5`, so a horizontal surface samples **pure sky** while a vertical samples a **50/50 sky/ground mix**. Sweeping ground therefore moves vertical response (brick side −85% → +123%) while board, frame, tank and shadow stay **bit-identical at every step** — an orthogonal lever, which is what makes the three targets simultaneously satisfiable. Warmth is also load-bearing: a *neutral* ground splits brick and steel by 41.6 points, wider than the ±20% window, so no neutral value passes both. Exposure is a calibration *output*, not a fixed input: because §3.0 takes flat graphics off ACES, the two paths respond differently and no key/fill pair satisfies both — exposure is the only lever that reaches the lit path alone. Results: board +1.17%, frame +0.82%, tank +4.11%, grid exact, shadow at 22.89% of lit. **All figures in this doc are the committed artifact `docs/calibration/lighting.json`** — regenerate with `npm run calibrate:lighting`; if the doc and the file disagree, the file wins and the doc gets corrected.
- **Material choice is part of the policy.** Flat graphics use a **Lambert** (pure diffuse) surface: a standard material's specular term does not scale with albedo, so calibrating on the near-black board left the frame 26.9% dark. Lit objects keep the standard material. The render layer **exports** two factories — `graphicSurface()` and `litSurface()` — and picking the wrong one is a calibration bug, not a style choice.
- **Which path each thing takes (definitive — this list settles it):** *graphic* = board plane, grid lattice, frame wall. *lit* = *all* terrain (brick, steel, water, trees, ice), tanks, bullets, props, power-ups. Terrain is an object the light falls on, not part of the board's diagram; an earlier code comment suggesting otherwise was wrong.
- `HemisphereLight.position` is a **direction**, not a location (a T2.2 bug had it tilting the sky axis 36° off vertical). Keep it `(0, 1, 0)`.
- The fit is two-point against a near-black board and a mid-tone tank; the ACES curve is non-linear, so **re-measure when introducing a materially different token** rather than assuming the deviation carries over.
- **Dynamic point-light pool (max 8, priority by proximity/importance):** muzzle flash (range 40 u, 60 ms), bullet glow (tiny, attached, Low: off), explosion (range 90 u, 400 ms, quadratic decay), base explosion (range 160 u, 1.2 s), power-up idle pulse (range 24 u, 1.2 s sine), spawn star (range 30 u).
- ACES tone mapping; **exposure is the calibrated 0.70 recorded above** — the original 1.1 predated the §3.0 split and is superseded.
- **Third target — vertical faces** (added after T2.2 measurement): a vertical face reads **within ±20%** of its authored side token. The first two targets constrain only horizontal, key-lit surfaces; shade sides are lit almost purely by the hemisphere fill, and at the calibrated intensity that fill is a saturated navy. Measured across five tank tokens the side response ranged **9.5%–20%** of the lit top and hue-shifted toward navy (a violet tank's side sampled near-pure blue) — i.e. shading depth tracked each token's blue content rather than the lighting. §3.1 authors *separate side tokens* for brick (`#6f3118`) and steel (`#5c6474`), so terrain depends on this directly. **The lever is `FILL_GROUND`, not sky saturation** — desaturating the sky fixes hue but moves the level essentially not at all (brick measured −85.2% before and after). After calibration the side response spans **43.4% (Power) – 64.1% (Armor)** across all six tank tokens (was 9.5%–20%): shading depth now tracks the lighting rather than each token's blue content. *(An earlier revision quoted 44.5%–57.4% "across five tokens" — those two figures were P1 and P2 alone; corrected against `docs/calibration/lighting.json`.)*
- **The vertical target measures emergent side appearance** — the probe applies the *top* token as albedo and scores the resulting shaded face against the *side* token. Any change to how sides get their colour must change the probe (`scripts/calibrate-lighting.ts`) and this target together, or the harness will print PASS against its own fixture while real geometry sits off target.
- **Uncovered band:** the blend weight is `0.5·cos θ + 0.5`, so surfaces that are neither horizontal nor vertical sample the mid-range — and `FILL_GROUND` is now **22× brighter** than the authored value, so deviation from vertical costs far more than it used to. Tree canopies (§5, flattened spheres) and bevelled model edges live in that band, and a downward-facing normal samples pure ground at full fill intensity. No target covers it yet; measure when the first such surface exists.
- **The flat-graphic path has no vertical probe.** The frame wall's vertical faces measure −34.3% against `boardFrame` — the one place §3.0's "the authored hex appears" promise is not kept. T2.3's water pit walls join it. Add a vertical flat-graphic probe when convenient.
- **Target 1 does not generalise across tokens by inspection.** The gold tank's +4.1% led to an assumption that mid-tones carry; `waterDeep` (dark, saturated) failed by +18.0% at the same settings. **Probe each new material rather than assuming**, especially dark or saturated tokens. Measured so far: board +1.2%, frame +0.8%, tank +4.1%, water (glossed) +0.1%, ice −8.2%, tree apex +1.0%, **eagle pedestal +5.4%** (T3.3, the one token added since).
- **Target 3 constrains luminance, not hue. The trigger fired at T2.4 and the trade is now permanent — this is the rig's signature.** With seven data points the failure is a clean function of the token's **saturation**, not its hue: above ~55% saturation the shaded face holds its hue (P1, P2, Fast all within 11° — P1 is −10.09°); below ~50% `FILL_GROUND`'s warmth dominates and near-neutral tokens invert to warm tan (Basic +162.2°, Armor +171.0°, Power +53.1°, steel likewise).
  **Decision (2026-08-02): keep the warm ground.** A neutral ground was measured at T2.2 to split brick and steel side luminance by 41.6 points — wider than the ±20% window — so no neutral value satisfies target 3 at all. The effect is physically coherent (a warm ground bounce tinting shaded faces), and it does not touch §11's actual requirement, which is **grayscale** separation.
  **The rule that follows:** a token that must hold its hue on shaded faces needs **saturation ≥ 55%** — raise the token, never retune the rig. Any new token below that threshold will read warm-sided by design.
  **The rule made a prediction and T3.3 tested it.** `eagleStone` `#8d94a3` is the first token authored *after* the rule, at 13.5% saturation, and its shaded wall measures **50.4% of its lit top at Δhue +165°** — warm tan, exactly as predicted and within a few degrees of Basic (+162°) and Armor (+171°). The rule is now confirmed rather than merely inferred, and a near-neutral prop token is a choice made with its consequence known.
- **Curved surfaces fall off, and that is physics, not miscalibration.** A tree canopy measures +1.0% at its apex (target 1 applies and passes) but spans **−6.5% to −54.7%** around its 45° band as the key falls off the curve. Do not tune the rig to flatten this.

## 7. Post-processing per quality preset

| Preset | Effects |
|---|---|
| High | Selective bloom (strength 0.55, radius 0.4, **threshold 0.0** — see below) + SMAA + vignette 0.25 + grade (slight teal shadows / warm highlights); DPR ≤ 2; shadows on |
| Medium | Bloom (0.4) + FXAA + vignette; DPR ≤ 1.5; shadows on (1024) |
| Low | FXAA only; DPR 1; shadows off; lights pool halved; particle budgets halved |

**Selection is done by layer, not by threshold** (measured, T2.5). The bloom source is a render of a dedicated emissive layer alone, with lights culled out — so only what is *put* on that layer can glow, and the threshold becomes redundant. It ships at **0.0** because the authored value of 0.85 was unreachable in either direction: emissive materials measure 0.512/0.497 linear in the source pass, while the brightest non-emissive pixel in a High frame reaches 0.817. A threshold-based selection would therefore have glowed almost nothing while sitting only 4% below a bright terrain highlight — the fragility §7 was warned about, quantified. Proof of the arrangement: with brick, steel, six tank bodies, a pulsing carrier and two bullets with tracers on screen and nothing on the layer, adding the bloom pass changes **0 pixels**.

**Calibration measures the raw render, before the chain** — the chain is a strictly-after authored layer. All art §6 targets were re-measured *through* each preset and still pass. Low is bit-identical across every field. **Medium moves 15 fields**, the largest being target-1 probes — P1 tank top **−3.11 pp** and armor top **−2.98 pp** — with the frame at −2.31 pp only third; the mover there is **FXAA smoothing a silhouette edge under the sample point**, not the vignette, which cannot reach a probe near frame centre. High's worst target-probe move is the frame at −2.47 pp. *(An earlier revision of this paragraph said Medium moved one probe and blamed the vignette; corrected against `lighting.json`.)* Recorded in `docs/calibration/lighting.json` (raw + one row per chain) and `docs/calibration/post.json`.

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

**The entity-material budget is retired; the real budget is scene draw calls** (ruled 2026-08-02, T3.3). Counting entity *materials* was always a proxy, and at 12 of 12 it now blocks T4.x for no measured reason: the shipped game draws **39 calls** at High in the real loop against arch §11's ~120 cap. Replace the proxy with the thing it stood for — **total scene draw calls ≤ 60 at High in the play loop**, asserted from a committed capture artifact, not a material count. Particles must still be pooled and instanced (art §8's ~180 live cap should cost 1–3 calls, never 180); a task that adds a material now justifies it against the scene number instead of a quota.

**The spawn star belongs on the flat-graphic path** (ruled 2026-08-02, implement in T4.x with the other overlays). It currently ships *lit and emissive*, so ACES desaturates it before bloom ever runs — 12.7° of its measured 27.7° hue gap from `#7fc4ff` is that, not the chain. Apply §3.0's own test: a spawn star is part of the board's diagram, not an object the light falls on. Moving it to an unlit, `toneMapped = false` material that stays on the bloom layer recovers the token exactly and removes the last hue lever from the rig. The tier-3 tip is the opposite case — it is part of a tank — so it stays lit and emissive.

**Emissive budget (ruled 2026-08-02).** §1 pillar 2 rations emissive surfaces so bloom stays special, and T2.4 found `emissive` is a *material* property, so per-instance glow is impossible without extra materials. The ruling: the **spawn star** and the **tier-3 barrel tip** each get **one shared emissive material** (both are uniform in colour across every tank that shows them), and the **carrier pulse stays diffuse** because it tints a whole tank per instance and already reads as the strongest overlay on the board. That is +2 materials, not +6. The entity draw-call budget rises from 8 to **12** to absorb them — arch §11 caps the whole scene near 120 and a full board currently measures 24, so the constraint was a brief's round number, not an architectural limit. Bullets and tracers blooming while the spawn star does not would have inverted §4's intent exactly.

**T3.3 spent the last two, and the budget is now exactly consumed: 12 of 12.** The two static props cost one material each — `propStone` for the pedestal in both its states, and one shared emissive `propGold` for the eagle's emblem **and all six power-ups**, which is §3.1's own grouping ("Power-up / gold … star, pickups, eagle emblem") rather than an economy measure. The pedestal is the item the emissive ruling did not anticipate: a non-emissive stone surface that no existing material could carry, and the reason 10 + emblem + power-ups did not add up to 12 on its own. The next entity material is therefore an owner's decision, and the argument for raising the number again is the same one made here — arch §11 caps the scene near 120 and a *populated* board with the props measures **37** GL draws at High (`docs/calibration/post.json → cost`, which is +3 on the identical board before them: two beauty draws plus one shadow draw, since the pedestal casts and the emissive gold does not).

## 9. Animation

| Thing | Spec |
|---|---|
| Tracks | stepped scroll, 8 u per visual step, rate ∝ speed; stationary = still |
| Turret recoil | 2 u back, 80 ms out-back ease per shot |
| Turn | hull yaw snaps logically; visual eases 100 ms with 2.5° lean into the turn |
| Engine idle | 0.3 u vertical vibration @ 9 Hz while moving (pairs with engine hum audio) |
| Power-up | bob ±2 u @ 1.2 s + 0.5 rps yaw + light pulse. *(Bob and yaw ship with T3.3; the pulse is §6's dynamic point light and lands with T4.x. The bob is measured from a **hover height of 2.5 u**, so the item is between 0.5 u and 4.5 u off the board and never rests on it.)* |
| Water | UV flow 0.05/s + secondary 0.023/s counter-flow |
| Trees | vertex sway noise, amplitude 0.6 u, frequency 0.4 Hz |
| Carrier flash | emissive pulse 4 Hz square (reads at small size) |
| Armor HP tint | crossfade 150 ms on hit + white hit-flash 60 ms (all tanks) |

**Every animation in this table freezes while `state.paused` is true** (ruled 2026-08-02, T3.3). The loop hands the renderer a real `dtMs` even on a paused frame — that is T2.1's contract, so overlays *outside* the board may still move — but the field itself is a still picture: the simulation is frozen, `prevX` equals `x`, and `alpha` is pinned to exactly 1. Tracks that keep scrolling over a stopped board read as a bug, and did: it shipped that way through T3.1 and was found by playing, not by testing. `alpha` is **not** clamped as part of this; clamping it is the separate failure T2.1's own comment warns about.

*That change also uncovered a second one, in the loop rather than the art: a moving picture over a frozen board was hiding the fact that **the pause could not be undone**. See arch §3.4.*

## 10. HUD & UI style

- **Fonts (bundled OFL, woff2):** Orbitron (display: title, stage number, scores) + Inter (body/menus). Tabular numerals for scores.
- **HUD (right dock, landscape):** enemy-remaining icon grid (4×5 mini tank glyphs, dimming as consumed), per-player card (lives as tank pips, live score, tier stars), stage flag+number. Portrait/touch: slim top bar + bottom control zone.
- **Menus:** dark translucent panels (`#10121b` @ 92%) with 1 px `#262b3d` borders, gold accent for selection, cyan focus ring (gamepad/keyboard), 150 ms slide/fade transitions.
- **Curtain transition:** the NES gray curtain reimagined — twin steel shutters wipe in/out (300 ms each) synced with the camera fly-in.
- **Score popups:** world-space billboards (`+100`), Orbitron 10 u, float up 12 u, fade 700 ms.
- **Title screen:** logo built from beveled 3D letters on the board, attract-mode camera drift, tank silhouettes rolling by under rim light.

## 11. Readability & accessibility rules

- Type silhouettes distinct in grayscale (§4); carrier flash also modulates scale +4% for colorblind visibility.
- **High-contrast mode is required, not optional** (upgraded 2026-08-02): 1 px dark outlines on all tanks + brighter bullet tracers. T2.4 measured player-gold `#d99c2b` against enemy-gunmetal `#8a8f9c` at only ~18 luminance points, and Basic-vs-P1 at 14.6% strongly-different area at its worst facing. Type silhouettes clear the bar among *enemies*; player-vs-enemy separation currently leans on hue, which is exactly what a colourblind player does not get. This mode is the fallback that makes that acceptable — ship it in Phase 6 with the other settings.
- Effects never cover the player's own tank for >100 ms; smoke max alpha 0.35 over playfield.
- `prefers-reduced-motion` or settings toggle: no shake, no slow-mo, no screen flash; all gameplay information preserved.
- Minimum contrast for HUD text 4.5:1 against its panel.
