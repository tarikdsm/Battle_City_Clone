# Battle City Remake — Gameplay Fidelity Specification

**Doc:** 01 · **Status:** Approved design (2026-07-20) · **Audience:** core-simulation implementers, test writers

This document is the **single source of truth for game rules**. The core simulation implements exactly what is written here; the parity checklist (§15) is implemented as automated tests. Where a value could not be confirmed from NES references it carries a `[CAL-nn]` tag and is resolved by the calibration protocol (§16) — implement the stated value now; calibration may adjust constants later without changing structure.

Presentation layers (render/audio/UI) may **never** alter any behavior specified here.

## 1. Units, time, coordinates

- Length: **1 tile = 16 u**, **1 subcell = 8 u** (NES pixels map 1:1 to u).
- Field: **13×13 tiles = 208×208 u** playable area. Origin (0,0) at **top-left**; +x right, +y down. Tile coords `(tx, ty)` ∈ 0..12; subcell coords ∈ 0..25.
- Time: fixed simulation timestep **1/60 s** ("frame"). All speeds in u/s, durations in seconds (converted to whole frames internally).
- Entity positions are stored as the **top-left corner** of their AABB, in float u; collision boxes are axis-aligned.

## 2. Field layout constants

| Item | Value |
|---|---|
| Enemy spawn points (tile x,y) | `(0,0)`, `(6,0)`, `(12,0)` — left, center, right |
| Player 1 spawn | tile `(4,12)`, facing up |
| Player 2 spawn | tile `(8,12)`, facing up |
| Eagle (base) | tile `(6,12)`, 16×16 u, static |
| Base brick ring | tiles `(5,11) (6,11) (7,11) (5,12) (7,12)`, full brick (auto-stamped into every level unless the level opts out) |

## 3. Tanks

All tanks: **16×16 u AABB** (2×2 subcells), 4-way facing (up/down/left/right).

### 3.1 Player

| Property | Value |
|---|---|
| Move speed | 45 u/s `[CAL-01]` |
| Lives at start | 3 per player (displayed as remaining reserves) |
| Bonus life | +1 at 20,000 points, once per player |
| Spawn/respawn state | tier 0, facing up, spawn shield **3.0 s** `[CAL-02]` |
| Death | one enemy bullet (unless shielded) → explosion, lose all tier upgrades, respawn after 1.0 s if lives remain |

**Star tiers** (gained via Star power-up, lost entirely on death):

| Tier | Bullet speed | Max own bullets airborne | Can destroy steel |
|---|---|---|---|
| 0 | 120 u/s | 1 | no |
| 1 | 240 u/s | 1 | no |
| 2 | 240 u/s | 2 | no |
| 3 | 240 u/s | 2 | **yes** |

Collecting a Star at tier 3 keeps tier 3 (score still awarded).

### 3.2 Enemies

20 per stage; composition per stage defined in level data ([05-content-levels.md](05-content-levels.md)).

| Type | Move speed | Bullet speed | HP | Points | Notes |
|---|---|---|---|---|---|
| Basic | 30 u/s `[CAL-03]` | 120 u/s | 1 | 100 | |
| Fast | 60 u/s `[CAL-03]` | 120 u/s | 1 | 200 | |
| Power | 45 u/s `[CAL-03]` | 240 u/s | 1 | 300 | fast bullets |
| Armor | 30 u/s `[CAL-03]` | 120 u/s | 4 | 400 | tint changes per remaining HP `[CAL-04]` (visual only) |

- Max **1** airborne bullet per enemy.
- **Carriers:** the **4th, 11th, 18th** enemies spawned (1-based) flash continuously (0.25 s period). The **first hit** on a carrier spawns a power-up (§8) and stops the flashing; the hit still applies damage normally.
- Armor HP tint order (4→1): silver → green → yellow → dark-silver `[CAL-04]`.

## 4. Movement rules

- 4-directional movement; input latches to the dominant axis; no diagonals.
- **Turn snap (feel-critical):** when a tank turns 90° (axis change), its coordinate on the *former* movement axis snaps to the nearest multiple of **8 u**. 180° reversals do not snap. This reproduces the NES lane alignment and must be covered by tests.
- Movement is a swept AABB move at subcell resolution; tanks are blocked by: field border, brick (any remaining subcell), steel, water, other tanks (enemy and player alike), and the eagle. Trees and ice never block. Partial overlap is impossible — movement stops flush at the obstacle.
- **Ice:** while any subcell under the tank's center 8×8 is ice, releasing input (or being on ice at a turn) keeps the tank sliding in its last direction, decelerating at **240 u/s²** until stopped, blocked, or overridden by new input `[CAL-05]`. Sliding tanks may still fire.
- **Spawning tank blockage:** a tank does not materialize while another tank overlaps its spawn tile; the spawn animation holds and retries every 0.5 s.

## 5. Combat

### 5.1 Bullets

- Size **4×4 u** AABB, spawned centered on the muzzle (front-center of the shooter), traveling in the facing direction at the shooter's bullet speed.
- A shooter may fire only while its airborne-bullet count is below its cap (player cap by tier; enemies 1). The simulation fires on the **press edge** of the fire input (as the NES does); hold-to-autofire is implemented in the input layer as a turbo pulse (~10 Hz), so core outcomes never exceed what button mashing achieves on the NES.
- Bullets despawn on any impact (single impact only — the first collision along the sweep) or at the field border (with impact puff, no terrain effect).

### 5.2 Interaction matrix

| Bullet from ↓ hits → | Player tank | Enemy tank | Player bullet | Enemy bullet | Brick | Steel | Eagle | Water | Trees |
|---|---|---|---|---|---|---|---|---|---|
| **Player** | ally: **stun** 3.0 s `[CAL-06]`, no damage, bullet consumed | damage 1 | both destroyed | both destroyed | destroys subcells (§6.1) | tier 3: destroys; else ricochet *clink*, bullet consumed | **destroys base → game over** | passes over | passes under |
| **Enemy** | damage 1 (unless shield) | **passes through** (no friendly fire) | both destroyed | passes through | destroys subcells | bullet consumed, no damage | **destroys base → game over** | passes over | passes under |

- Stunned player: cannot move or fire, blinks, for 3.0 s `[CAL-06]`; enemy bullets still damage it.
- Shielded player (spawn shield or Helmet): enemy bullets are consumed with a shield shimmer, no damage. Shields do not protect the eagle.
- Simultaneous frame-exact events resolve in system order (architecture doc §3.2): bullets advance → bullet-vs-bullet → bullet-vs-tank/terrain.

## 6. Terrain

Levels are 13×13 tiles; each tile is one of: empty, brick, steel, water, trees, ice (plus the eagle and its auto ring). Brick and steel resolve per-subcell (levels may define partial tiles).

### 6.1 Brick
- Tracked as 4 independent subcells per tile.
- A non-tier-3 bullet impact removes the **near half of the tile relative to travel direction** (the 2 subcells adjacent to the impacted face, i.e. an 8 u-deep, 16 u-wide bite aligned to the tile) — two hits fully clear a tile `[CAL-07]`.
- The damaged tile is the tile **containing the struck subcell** (both tile coordinates derive from it — never from the bullet center, which sits exactly on a tile boundary in half of all firing lanes). When a bullet straddles two tiles that both hold matching terrain at the same face distance, the lower-coordinate tile wins (deterministic; amended 2026-07-21 during T1.3 review).
- A tier-3 player bullet impact removes **all 4 subcells** of the impacted tile in one hit `[CAL-07]`.
- Collision uses remaining subcells only.

### 6.2 Steel
- Blocks all tanks and all bullets. Only tier-3 player bullets destroy it: one hit removes the near half (2 subcells), like brick `[CAL-08]`. Enemy bullets never damage steel.

### 6.3 Water — blocks tanks, never bullets. Purely visual animation.
### 6.4 Trees — block nothing; rendered **above** tanks and bullets (concealment). No simulation effect.
### 6.5 Ice — no collision; slide behavior per §4.

## 7. Enemy spawning

- HUD shows `20 − spawned` icons; an icon is consumed **when a spawn begins** (star animation start), as in the NES.
- Active cap on field: **4** enemies (1P and 2P) `[CAL-09]`.
- Spawn points cycle in fixed order **left → center → right → left…**, starting at **left** for each stage `[CAL-10]`.
- **Spawn interval** (from one spawn start to the next attempt): `interval = clamp((190 − 4·stage − 20·(players − 1)) / 60, 0.5, 3.2)` seconds, where `stage` is the effective stage number capped at 35 `[CAL-11]`. Matches observed ≈3 s at stage 1 → <1 s at stage 35. First spawn of a stage occurs at t = 0.
- A spawn attempt is skipped (retried next 0.5 s) while its point is blocked by a tank; the cycle does not advance on a blocked attempt.
- **Spawn animation:** twinkling star for **1.3 s** `[CAL-12]`; the tank has no collision/hitbox until it materializes. Enemies spawned during an active Clock freeze materialize frozen.

## 8. Power-ups

- Spawned when a carrier (§3.2) is first hit; placed at a random position aligned to the subcell grid, fully inside the field, not overlapping the eagle ring `[CAL-13]`.
- At most **one** power-up on field: a new one replaces the old.
- Persist until collected or stage end. Only players collect (tank AABB overlap). Collection awards **500 points**.
- Type is rolled uniformly among the six `[CAL-14]`, seeded RNG.

| Power-up | Effect |
|---|---|
| **Star** | Player tier +1 (max 3). |
| **Helmet** | Shield for **10 s** `[CAL-15]`; re-collect restarts the timer. |
| **Clock** | All enemies (including ones that spawn during it) freeze — no move, no fire — for **10 s** `[CAL-16]`. |
| **Shovel** | Base ring becomes **steel** and any destroyed ring subcells are repaired; lasts **20 s**: 17 s solid + 3 s blinking brick/steel warning, then reverts to **fully repaired brick** `[CAL-17]`. |
| **Grenade** | All materialized enemies on field are destroyed instantly. **No points** for these kills. Tanks mid-spawn-animation are unaffected `[CAL-18]`. |
| **Tank** | +1 life to the collector. |

## 9. Enemy AI `[FEEL]`

The NES AI is not publicly documented at instruction level; this model is a perceived-equivalent reconstruction. It is deterministic given the seed (§14) and tunable via constants; the calibration pass (§16) adjusts weights against reference footage until behavior is indistinguishable in blind side-by-side review.

- Each enemy holds a direction and a decision timer drawn uniform from **0.5–2.0 s**.
- A new direction is chosen when: the timer expires, the tank is blocked, or it crosses a tile-lattice line (25% chance to reconsider at crossings).
- Direction choice weights: keep current **40%**, turn toward base **20% + 0.5%·stage** (cap 40%), turn toward nearest player **10%**, uniform random **remainder**. Blocked directions are excluded before rolling; if all blocked, reverse.
- **Firing:** if facing and axis-aligned (lateral offset ≤ 6 u) with a player or the eagle → fire with probability **0.9/s**; otherwise random fire at **0.4/s**. Both respect the 1-bullet cap.
- Frozen (Clock) enemies make no decisions; timers resume where they paused.

## 10. Two-player rules

- Shared field, shared 20-enemy pool, shared power-ups; separate scores and lives.
- Friendly fire: player bullet vs player → stun (§5.2), never kills.
- A player with 0 lives is out (no stealing); play continues while one remains. Game over when both are out **or** the eagle is destroyed.
- Spawn interval uses the 2-player term while both are alive (§7).

## 11. Stage flow

1. **Stage intro** ("STAGE N"): ~2 s, then curtain-open into gameplay; first enemy spawn at t = 0.
2. **Stage clear:** 20th enemy destroyed → 2 s beat → tally screen (per-player counts per type × points, totals) → next stage. Progress (highest stage reached) persists.
3. **Base destroyed:** eagle explodes (slow-mo presentation moment), controls lock, 3 s → game over sequence. Score is kept for high-score entry.
4. **All lives lost (both players in 2P):** same game-over sequence.
5. After stage 35 the campaign **loops to stage 1**; the internal stage counter keeps rising for the spawn formula but is capped at 35 (§7).
6. **Pause** freezes the simulation entirely (timers included).

## 12. Scoring & tally

| Event | Points |
|---|---|
| Basic / Fast / Power / Armor destroyed | 100 / 200 / 300 / 400 (to the player whose bullet landed the killing hit) |
| Power-up collected | 500 |
| Grenade kills | 0 |
| Bonus life | at 20,000 cumulative points, once per player |

Tally screen shows per-type destroyed counts per player; totals carry across stages within a run. High-score table: local top-10 (score, initials, stage reached); seed entry 20,000 pts as the NES default `HI` value.

## 13. Game over & high scores

Game over → if score beats table's 10th entry, arcade initials entry (3 characters, gamepad/keyboard/touch navigable) → high-score table display → title.

## 14. Determinism & RNG

- Single seeded PRNG (**mulberry32**) per run, owned by the core; **all** randomness (AI rolls, power-up type/position, decision timers) draws from it. `Math.random` is forbidden in `src/core/`.
- Replays: `(levelId, seed, per-frame intent log)` reproduces a run bit-exactly; golden-replay fixtures are part of the test suite.

## 15. Parity test checklist

Each row becomes at least one automated test (IDs are stable for traceability):

| ID | Invariant |
|---|---|
| P-01 | Turn snap: 90° turn snaps former-axis coordinate to nearest 8 u; 180° does not |
| P-02 | Tier table: bullet speed/cap/steel-destruction per tier exactly as §3.1 |
| P-03 | Death resets tier to 0 and applies 3.0 s spawn shield |
| P-04 | Brick: non-tier-3 hit removes exactly the near half; two hits clear the tile |
| P-05 | Tier-3 hit clears a full brick tile in one hit; destroys steel half-tile |
| P-06 | Enemy bullets pass through enemy tanks; damage players |
| P-07 | Player bullet + enemy bullet mutually annihilate |
| P-08 | Player bullet stuns (not kills) the other player for the spec'd duration |
| P-09 | Water blocks tanks, not bullets; trees block nothing; ice slides per §4 |
| P-10 | Eagle destroyed by any bullet incl. player's → game over |
| P-11 | Spawn cap 4; icons decrement on spawn start; interval follows §7 formula |
| P-12 | Spawn points cycle L→C→R; blocked spawn holds and retries without advancing |
| P-13 | Carriers are the 4th/11th/18th spawns; first hit drops power-up and stops flash |
| P-14 | Single power-up on field; replacement removes the old one |
| P-15 | Star/Helmet/Clock/Shovel/Grenade/Tank effects and durations per §8 |
| P-16 | Shovel repairs ring, converts to steel, blinks, reverts to full brick |
| P-17 | Clock freezes existing and newly spawned enemies for full duration |
| P-18 | Grenade kills award no points; mid-spawn enemies unaffected |
| P-19 | Armor takes 4 hits; scoring 100/200/300/400/500 per §12 |
| P-20 | Bonus life exactly once at 20,000 per player |
| P-21 | 2P: shared enemy pool, separate scores/lives, out-player stays out, game continues |
| P-22 | Player fire cap: no fire while at airborne-bullet cap; refire when freed |
| P-23 | Same seed + same intent log ⇒ identical final state hash (golden replay) |
| P-24 | Max 1 airborne bullet per enemy |
| P-25 | Stage loop after 35; spawn formula stage term caps at 35 |
| P-26 | Pause freezes all simulation timers |

## 16. Calibration protocol

**Goal:** replace every `[CAL-nn]` with a verified value. **When:** dedicated task in the QA/polish phase (implementation may proceed with stated values — they are structured as constants in `src/core/constants.ts`, one named constant per CAL ID).

**Method:** run the NES ROM in an emulator with frame-advance (e.g. Mesen2) — the operator (project owner) plays/records; measurements from frame counts and pixel positions:

1. Speeds (CAL-01, 03): px moved over 60 frames for each tank type and bullet class.
2. Timers (CAL-02, 05, 06, 12, 15, 16, 17): frame counts between visible state changes.
3. Rules (CAL-07, 08, 09, 10, 13, 14, 18): scripted in-game experiments (e.g. count brick subcells after angled shots; observe 20 spawn orders; sample ≥60 power-up rolls for distribution).
4. Formula (CAL-11): measure spawn intervals at stages 1, 10, 20, 35 in 1P and 2P; fit.
5. AI `[FEEL]`: record 5 minutes of stage 3 and stage 20 play; tune §9 weights until blind A/B review cannot distinguish remake footage from NES footage at the behavioral level (direction-change frequency, base-rush tendency, fire cadence).

Each calibration outcome updates: the constant, this doc's value + tag removal, and any affected test expectations — in one commit per batch.
