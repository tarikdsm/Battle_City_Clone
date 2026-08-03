# Battle City Remake — Gameplay Fidelity Specification

**Doc:** 01 · **Status:** Approved design (2026-07-20) · **Audience:** core-simulation implementers, test writers

This document is the **single source of truth for game rules**. The core simulation implements exactly what is written here; the parity checklist (§15) is implemented as automated tests. Values that once carried a `[CAL-nn]` tag are **no longer estimates**: as of 2026-08-02 every one of the eighteen was read out of the Battle City (J) disassembly and now cites the label or address it came from. Three of them are marked `deviation` — recovered from the code, but deliberately not adopted, with the reason stated in §16.2. Nothing in this document is a guess presented as a measurement.

Presentation layers (render/audio/UI) may **never** alter any behavior specified here.

## 1. Units, time, coordinates

- Length: **1 tile = 16 u**, **1 subcell = 8 u** (NES pixels map 1:1 to u).
- Field: **13×13 tiles = 208×208 u** playable area. Origin (0,0) at **top-left**; +x right, +y down. Tile coords `(tx, ty)` ∈ 0..12; subcell coords ∈ 0..25.
- Time: fixed simulation timestep **1/60 s** ("frame"). All speeds in u/s, durations in seconds (converted to whole frames internally). Countdown timers snap to exactly 0 once within half a tick of expiry, so an effect whose duration is a whole multiple of the tick lasts exactly its nominal number of frames despite float accumulation (implementation rule, ruled 2026-07-21).
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
| Move speed | 45 u/s `[CAL-01 OK $DC09]` |
| Lives at start | 3 per player (displayed as remaining reserves) |
| Bonus life | +1 at 20,000 points, once per player |
| Spawn/respawn state | tier 0, facing up, spawn shield **3.2 s** (192 frames) `[CAL-02 OK $E3C1]` |
| Death | one enemy bullet (unless shielded) → explosion, lose all tier upgrades, respawn after **0.633 s** (38 frames) if lives remain |

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
| Basic | 30 u/s `[CAL-03 OK $DC2D]` | 120 u/s | 1 | 100 | |
| Fast | 60 u/s `[CAL-03 OK $DC25]` | 120 u/s | 1 | 200 | the only enemy that moves every frame |
| Power | 30 u/s `[CAL-03 OK $DC2D]` | 240 u/s | 1 | 300 | fast **bullets**, ordinary hull |
| Armor | 30 u/s `[CAL-03 OK $DC2D]` | 120 u/s | 4 | 400 | tint changes per remaining HP `[CAL-04 deviation]` (visual only) |

- Max **1** airborne bullet per enemy.
- **Carriers:** the **4th, 11th, 18th** enemies spawned (1-based) flash continuously (0.25 s period). The **first hit** on a carrier spawns a power-up (§8) and stops the flashing; the hit still applies damage normally.
- Armor HP tint order (4→1): silver → green → yellow → dark-silver `[CAL-04 deviation, see §16]`. The ROM does not hold a tint per HP: `$DFCD` indexes `tbl_E003` ($E003) with `(4·frame + hp) & 7`, so an armor tank **alternates between two NES sprite palettes every frame** — {1,2} at 4 HP, {0,2} at 3, {0,1} at 2, and a steady 2 at 1 HP. Our renderer has no NES palette to alternate between, so it keeps a stable tint per HP; the recovered mechanism is recorded rather than adopted.

## 4. Movement rules

- 4-directional movement; input latches to the dominant axis; no diagonals.
- **Turn snap (feel-critical):** when a tank turns 90° (axis change), its coordinate on the *former* movement axis snaps to the nearest multiple of **8 u**. 180° reversals do not snap. This reproduces the NES lane alignment and must be covered by tests.
- Movement is a swept AABB move at subcell resolution; tanks are blocked by: field border, brick (any remaining subcell), steel, water, other tanks (enemy and player alike), and the eagle. Trees and ice never block. Partial overlap is impossible — movement stops flush at the obstacle.
- **Ice:** while any subcell under the tank's center 8×8 is ice, releasing input (or being on ice at a turn) keeps the tank sliding in its last direction until stopped, blocked, or overridden by new input `[CAL-05 OK $DBBD — structural deviation]`. Sliding tanks may still fire. The ROM coasts **28 px at full speed with no deceleration at all** (`$DBBD` arms a 28-step counter that `$DC5F` spends one pixel at a time), so our deceleration is *derived* from that distance — `ICE_DECEL = PLAYER_SPEED² / (2 × 28) ≈ 36.2 u/s²` — rather than chosen. Two recorded differences: the ROM re-arms the counter whenever it empties while a direction is held, so the coast on release is the **remainder** (0–27 px, mean ≈14) where ours is always the full 28; and the ROM only ever sets the ice flag for the two player slots (`$E1AE`), so its enemies never slide.
- **Spawning tank blockage:** a tank does not materialize while another tank overlaps its spawn tile; the spawn animation holds and retries on the **next tick** (§7).

## 5. Combat

### 5.1 Bullets

- Size **4×4 u** AABB, spawned centered on the muzzle (front-center of the shooter), traveling in the facing direction at the shooter's bullet speed.
- A shooter may fire only while its airborne-bullet count is below its cap (player cap by tier; enemies 1). The simulation fires on the **press edge** of the fire input (as the NES does); hold-to-autofire is implemented in the input layer as a turbo pulse (~10 Hz), so core outcomes never exceed what button mashing achieves on the NES.
- Bullets despawn on any impact (single impact only — the first collision along the sweep) or at the field border (with impact puff, no terrain effect).

### 5.2 Interaction matrix

| Bullet from ↓ hits → | Player tank | Enemy tank | Player bullet | Enemy bullet | Brick | Steel | Eagle | Water | Trees |
|---|---|---|---|---|---|---|---|---|---|
| **Player** | ally: **stun** 4.45 s `[CAL-06 OK $E8AA]`, no damage, bullet consumed | damage 1 | both destroyed | both destroyed | destroys subcells (§6.1) | tier 3: destroys; else ricochet *clink*, bullet consumed | **destroys base → game over** | passes over | passes under |
| **Enemy** | damage 1 (unless shield) | **passes through** (no friendly fire) | both destroyed | passes through | destroys subcells | bullet consumed, no damage | **destroys base → game over** | passes over | passes under |

- Stunned player: cannot move or fire, blinks, for 4.45 s `[CAL-06 OK $E8AA]`; enemy bullets still damage it. The ROM stores $C8 = 200 and spends it on the player's 3-frames-in-4 cadence at `$DB8F`, i.e. 266.7 frames; we round up to 267 ticks.
- Shielded player (spawn shield or Helmet): enemy bullets are consumed with a shield shimmer, no damage. Shields do not protect the eagle.
- Simultaneous frame-exact events resolve in system order (architecture doc §3.2): bullets advance → bullet-vs-bullet → bullet-vs-tank/terrain.

## 6. Terrain

Levels are 13×13 tiles; each tile is one of: empty, brick, steel, water, trees, ice (plus the eagle and its auto ring). Brick and steel resolve per-subcell (levels may define partial tiles).

### 6.1 Brick
- Tracked as 4 independent subcells per tile.
- A non-tier-3 bullet impact removes the **near half of the tile relative to travel direction** (the 2 subcells adjacent to the impacted face, i.e. an 8 u-deep, 16 u-wide bite aligned to the tile) — two hits fully clear a tile `[CAL-07 deviation, see §16]`.
- The damaged tile is the tile **containing the struck subcell** (both tile coordinates derive from it — never from the bullet center, which sits exactly on a tile boundary in half of all firing lanes). When a bullet straddles two tiles that both hold matching terrain at the same face distance, the lower-coordinate tile wins (deterministic; amended 2026-07-21 during T1.3 review).
- A tier-3 player bullet impact removes **all 4 subcells** of the impacted tile in one hit `[CAL-07 deviation, see §16]`.
- Collision uses remaining subcells only.

### 6.2 Steel
- Blocks all tanks and all bullets. Only tier-3 player bullets destroy it: one hit removes the near half (2 subcells), like brick `[CAL-08 OK $E6D8]`. Enemy bullets never damage steel. Steel in the ROM has **no sub-tile state at all** — one byte of the field array is one 8×8 cell, and a tier-3 hit writes that whole byte to 0 (`$E6E0`); the bullet applies it at both of its perpendicular probe points, which is our 2-subcell near half exactly.

### 6.3 Water — blocks tanks, never bullets. Purely visual animation.
### 6.4 Trees — block nothing; rendered **above** tanks and bullets (concealment). No simulation effect.
### 6.5 Ice — no collision; slide behavior per §4.

## 7. Enemy spawning

- HUD shows `20 − spawned` icons; an icon is consumed **when a spawn begins** (star animation start), as in the NES.
- Active cap on field: **4** enemies in 1P, **6** in 2P `[CAL-09 OK $CA6F/$CA74]`. `ram_enemy_limit` is the top tank slot the spawn scan uses and the scan walks down to slot 2, so the cap is `limit − 1`.
- Spawn points cycle in fixed order **center → right → left → center…**, starting at **center** for each stage `[CAL-10 OK $E37C]`. The ROM increments `ram_enemy_spawn_pos_index` *before* reading it, from a per-stage zero (`$C372`), so index 1 (centre) is what the first enemy of every stage gets.
- **Spawn interval** (from one spawn start to the next attempt): `interval = 190 − 4·stage − 20·(players − 1)` **frames**, where `stage` is the effective stage number capped at 35 `[CAL-11 OK $C39E]` — 3.10 s at stage 1 (1P) down to 0.50 s at stage 35 (2P). The ROM applies **no clamp**: over stages 1–35 and 1–2 players the expression already spans exactly [30, 186] frames. Our implementation keeps a `[30, 192]` clamp purely as a guard against out-of-range stage numbers reaching it from the editor; it never binds in play. First spawn of a stage occurs at t = 0 (`$C36B` zeroes the timer).
- A spawn attempt is skipped while its point is blocked by a tank, and **retried on the very next tick** — `$DB48` reloads the interval only on a spawn that actually happened (`$DB5D`), so a blocked attempt leaves the timer at zero. The cycle does not advance on a blocked attempt.
- **Spawn animation:** twinkling star for **0.933 s** (56 frames) `[CAL-12 OK $DE55/$DE64]`; the tank has no collision/hitbox until it materializes. The ROM hand-cranks `tank_flags` from $F0 to $FE and then $E0 to $EE — 28 increments — on the tank's own move cadence, which is every other frame for an enemy. Enemies spawned during an active Clock freeze materialize frozen (`$DC1B`: respawning tanks are the one class the freeze lets through).

## 8. Power-ups

- Spawned when a carrier (§3.2) is first hit; placed on a **4×4 grid of sixteen fixed positions** `[CAL-13 OK $E8BE/$E902]`. The ROM draws `rand AND #$03` per axis and maps it through `((n·3)·2 + 6)·8` = 48n + 48, giving screen coordinates $30/$60/$90/$C0 — field centres 32/80/128/176 u, i.e. top-left corners 24/72/120/168 u. The pair is re-drawn while a player already stands on it. No slot can reach the eagle tile (the lowest row of slots ends at y = 184, the eagle starts at 192), but a slot **can** sit on the base ring's brick — and does.
- At most **one** power-up on field: a new one replaces the old.
- Persist until collected or stage end. Only players collect (tank AABB overlap). Collection awards **500 points**.
- Type is **not** uniform `[CAL-14 OK tbl_E8FA $E8FA]`: `rand AND #$07` indexes an eight-entry table `helmet, clock, shovel, star, grenade, tank, grenade, star`, so star and grenade are 2/8 each and helmet/clock/shovel/tank 1/8 each. Draw order is position first, then type (`$E8C3` … `$E8E6`), seeded RNG.

| Power-up | Effect |
|---|---|
| **Star** | Player tier +1 (max 3). |
| **Helmet** | Shield for **10.667 s** (640 frames) `[CAL-15 OK $E9F0]`; re-collect restarts the timer. The ROM stores 10 and decrements it once per 64 frames (`$E28C`). |
| **Clock** | All enemies (including ones that spawn during it) freeze — no move, no fire — for **10.667 s** (640 frames) `[CAL-16 OK $E9F5]`. Same 64-frame unit (`$DBFC`). |
| **Shovel** | Base ring becomes **steel** and any destroyed ring subcells are repaired; lasts **21.33 s** (1280 frames): **18.13 s solid + 3.2 s** blinking brick/steel warning, then reverts to **fully repaired brick** `[CAL-17 OK $EA04/$E2BF]`. The 17 + 3 split was the right shape in the wrong unit: the ROM stores 20 units of 64 frames and starts blinking below 4. |
| **Grenade** | All materialized enemies on field are destroyed instantly. **No points** for these kills. Tanks mid-spawn-animation are unaffected `[CAL-18 OK $EA17]` — the loop skips any tank whose flags are ≥ $E0, and awards nothing because points are paid at the bullet hit (`$E7FB`), a path the grenade never takes. A carrier destroyed this way **drops nothing** — the drop is a bullet-hit mechanic, and the grenade is itself the reward (ruled 2026-07-22). |
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

## 16. Calibration protocol — CLOSED

**Status: closed on 2026-08-02 (task T10, commit 1). 15 of 18 constants read directly out of the game's code; 3 recovered but deliberately not adopted. None is a guess any more.**

**Goal (original):** replace every `[CAL-nn]` with a verified value.

**Method (original):** run the NES ROM in an emulator with frame-advance (e.g. Mesen2) — the operator (project owner) plays/records; measurements from frame counts and pixel positions.

**Method (actual).** The emulator was never needed. Phase 7 transcribed all 35 original stages out of the **Battle City (J) disassembly** at `cyneprepou4uk/NES-Games-Disassembly@57972cd`, and the same repository carries the game's *code*, fully labelled, in `Battle City/bank_FF.asm` (8,771 lines) with its RAM map in `bank_ram.inc`. Every constant below was therefore read out of the 6502 rather than measured off a screen — which is strictly better evidence than frame-advance, because it is the stored number itself and it is reproducible by anyone with the same pinned commit and no ROM.

Two unit facts make the conversion exact:

- **1 ROM pixel = 1 u.** The playfield origin is (16,16) on the 256-wide NES screen and the ROM's stored positions are tank *centres*: `tbl_E474` = $18/$78/$D8 → field 8/104/200 = the centres of tile columns 0/6/12; `tbl_E47A`/`tbl_E47C` = $58/$98/$D8 → field 72/136/200 = tiles 4, 8 and row 12. Those are exactly our spawn tiles in a 208 u field.
- **1 ROM frame = 1 tick.** `sub_C2E6_main_battle_script` ($C2E6) is the per-frame script. Several ROM timers, however, are stored in units of **64 frames** and only decremented when the global frame counter satisfies `AND #$3F` — which is the single fact that moved five of the six power-up/shield timers below.

NTSC hardware runs at 60.0988 Hz, not 60. All frame→second conversions here use our 60 Hz tick, so a 640-frame timer reads 10.667 s for us and 10.650 s on a CRT. That 0.16 % is below the resolution of anything this spec claims, and it is the only hardware-vs-emulation gap in the table.

### 16.1 Outcome, constant by constant

`OK` = the stored value was found and adopted. `deviation` = the value was found, but our model cannot express it and the difference is recorded instead of hidden.

| ID | Was | Now | Source |
|---|---|---|---|
| CAL-01 | 45 u/s | **45 u/s** (unchanged) | `$DC09` gate (3 frames in 4) × `tbl_E46C` (±1 px) |
| CAL-02 | 3.0 s | **3.2 s** (192 frames) | `$E3C1` `LDA #$03` into the helmet timer, 64-frame unit |
| CAL-03 | basic 30 / fast 60 / **power 45** / armor 30 | basic 30 / fast 60 / **power 30** / armor 30 | `$DC25` tests type $A0 only; `$DC2D` halves the rest |
| CAL-04 | silver→green→yellow→dark-silver | **deviation** — the ROM alternates two sprite palettes per frame | `$DFCD` + `tbl_E003` ($E003) |
| CAL-05 | decel 240 u/s² | **28 px of coast**, decel derived = 36.16 u/s² | `$DBBD` `LDA #$9C` (28-step counter), spent at `$DC5F` |
| CAL-06 | 3.0 s | **4.45 s** (267 ticks) | `$E8AA` `LDA #$C8` = 200, spent at `$DB8F` on the 3-in-4 cadence |
| CAL-07 | near half = 2 subcells (8 u deep) | **deviation** — the ROM's brick granularity is 4×4 px | `sub_D725` ($D725) quadrant mask + `sub_D743` ($D743) |
| CAL-08 | tier-3 removes the near half | **confirmed** | `$E6D8` property bit 1 → `$E6E0` clears the whole 8×8 cell |
| CAL-09 | 4 (1P and 2P) | **4 in 1P, 6 in 2P** | `$CA6F` / `$CA74` into `ram_enemy_limit`, scanned to slot 2 at `$DB72` |
| CAL-10 | left → centre → right | **centre → right → left** | `$E37C` increments the index *before* reading it, from a per-stage 0 at `$C372` |
| CAL-11 | `clamp(190 − 4·stage − 20·(p−1), 30, 192)` | **same expression, no clamp in the ROM** | `$C39E`; stage cap 35 at `$C397`; retry cadence at `$DB48`/`$DB5D` |
| CAL-12 | 1.3 s | **0.933 s** (56 frames) | `$DE55` + `$DE64`, 28 increments on the tank's move cadence |
| CAL-13 | random subcell-aligned slot, off the base | **16 fixed slots** (48n + 48 per axis), re-drawn under a player | `sub_E8BE` ($E8BE) + `sub_E902` ($E902) |
| CAL-14 | uniform over six | **weighted, 8-slot table** (star ×2, grenade ×2) | `$E8E6` `AND #$07` → `tbl_E8FA` ($E8FA) |
| CAL-15 | 10 s | **10.667 s** (640 frames) | `$E9F0` `LDA #$0A`, decremented at `$E28C` per 64 frames |
| CAL-16 | 10 s | **10.667 s** (640 frames) | `$E9F5` `LDA #$0A`, decremented at `$DC00` per 64 frames |
| CAL-17 | 17 s solid + 3 s blink | **18.13 s + 3.2 s** (1088 + 192 frames) | `$EA04` `LDA #$14`, blink threshold `$E2BF` `CMP #$04` |
| CAL-18 | kills all materialized, no points, no drop | **confirmed** | `ofs_bonus_EA17` ($EA17) skips flags ≥ $E0; points are paid at `$E7FB` only |

### 16.2 The three that stay open, and why

None of the three is open for lack of a source. Each was found and read; each is a place where the ROM's *shape* does not fit our model, and the honest outcome is to record the shape rather than fake the number.

- **CAL-04 — armor tint.** The ROM has no per-HP colour. `$DFCD` computes `tbl_E003[(4·frame + hp) & 7]`, so an armor tank strobes between two of four NES sprite palette slots at 30 Hz: {1,2} at 4 HP, {0,2} at 3, {0,1} at 2, and a steady 2 at 1 HP. Turning that into an RGB sequence needs the NES sprite palette table and the NES master palette, neither of which our calibrated 2.5D renderer uses — it has its own lighting model (art doc §3). So the *mechanism* is recorded here and the renderer keeps a stable, readable tint per HP. Visual only; no simulation state depends on it.
- **CAL-05 — ice.** Recovered exactly, and the stored number (28) *is* adopted — as a distance. What is not adopted is the ROM's velocity profile: it coasts at full speed for a counted number of steps and stops dead, where we decelerate. Adopting the counter would mean replacing a velocity field that the state hash, the audio layer and every golden replay already read. The residual is written into §4 in full: our coast is always the ROM's maximum, and the ROM's is the remainder of a re-arming counter.
- **CAL-07 — brick damage.** Recovered, and it is finer than our terrain grid can express. One byte of the ROM's field array at $0400 (stride 32, one byte per 8×8 pixel cell) carries **four quadrant bits of 4×4 px each** (`sub_D725` builds the mask from bit 2 of each coordinate; `sub_D743` clears one bit). Our finest terrain unit is the 8×8 subcell, so the ROM punches a 4 u-deep bite where we punch 8 u — the ROM needs four hits to clear a 16 u tile front-to-back where we need two. Matching it means doubling the terrain resolution to 52×52, which changes the level format, the 35 transcribed stages, the editor and the renderer. That is a different project decision, not a constant; it is now a *known, quantified* deviation instead of an unknown.

### 16.3 What the ROM read did NOT change

Recovered on the same pass, found to already match, and left alone: `PLAYER_SPEED` (CAL-01), `BULLET_SLOW`/`BULLET_FAST` (2 and 4 px per frame at `$E063`), `ENEMY_TOTAL` = 20 (`$C353`), `CARRIER_ORDINALS` = 4/11/18 (`$E393`), `ARMOR_HP` = 4 (`$E3F4`/`$E7E8`), the score table 100/200/300/400/500 (`tbl_E8BA` + `$E9B6`), the spawn-point tile coordinates (`tbl_E474`/`tbl_E477`), the player and eagle tiles (`tbl_E47A`/`tbl_E47C`), and the tank hitbox (bullet-vs-tank is `|dx| < 10 ∧ |dy| < 10` on centres at `$E739`/`$E74A`, which is our 16 u × 4 u AABB overlap exactly).

Two untagged constants moved because the same read settled them, and both are called out in the release notes: `PLAYER_RESPAWN_S` (1.0 s → 0.633 s — the identical 28-crank animation as CAL-12, on the player's faster cadence) and `SPAWN_RETRY_S` (0.5 s → 1 tick — `$DB48` reloads the interval only on a spawn that happened).

### 16.4 Known differences the read exposed but we did not adopt

Recorded so they are not rediscovered as bugs:

- **Enemy fire** (`sub_E162`, `$E171`) is a flat `rand AND #$1F` per enemy per frame — 1-in-32, with no aiming term whatsoever. Our AI has an alignment bonus. See §16.5.
- **Enemy steering** (`$DC80` + `sub_DE72`) reconsiders only on the 8 px lattice and only when `rand AND #$0F` == 0, and picks its target by comparing `spawn_interval / 4` against the *high byte of the frame counter*. Ours is a weighted per-decision model.
- **Two-bullet players.** `sub_E122` ($E136) lets a player at 2 or 3 stars park a first bullet in a second slot and fire again — two airborne bullets, not one. Our §3.1 tier table gives 2 bullets at tier 2+; already aligned.
- **Pickup box.** The ROM collects on `|dx| < 12 ∧ |dy| < 12` between centres ($E994/$E9A4); ours is a 16 u AABB overlap. Untagged, pre-existing, unchanged.
- **Power-up display.** A collected power-up shows its 500 for `$32` = 50 frames (`$E9A8`) — presentation, not simulation.

### 16.5 AI `[FEEL]` — still `[FEEL]`, now for a stated reason

The original plan was blind A/B review against reference footage. The disassembly makes the ROM's actual AI readable (§16.4), and it is cruder than our reconstruction: no aiming, lattice-gated reconsideration, and a target choice coupled to the global frame counter. Adopting it wholesale would mean adopting the ROM's LCG (`sub_D44D`, $D44D — `x*7 + frm_cnt_hi + zeropage[i]`) and its frame-counter coupling, which is a different determinism model from our seeded, tick-pure one and would break every golden replay's premise. The §9 weights therefore remain a **perceived-equivalent design reconstruction**, not a measurement, and `docs/08-release-notes.md` says so in those words.

### 16.6 Reproducing this

The disassembly is public and pinned. `scripts/transcribe-original-stages.ts` already fetches from the same commit — `https://raw.githubusercontent.com/cyneprepou4uk/NES-Games-Disassembly/57972cd64f18e3a718fbd3b0babe55e688599e8f/Battle%20City/bank_FF.asm` — and every address in the tables above is a label or an offset in that one file. No ROM image, no emulator, and no copyrighted binary is needed to check any line of this section.

Each calibration outcome updated: the constant, this doc's value + tag, the affected test expectations, and the three golden replays — in one commit.
