// src/core/constants.ts — canonical simulation constants. Lengths in `u`
// (1 tile = 16 u, 1 subcell = 8 u), times in seconds.
//
// --- Calibration status (fidelity spec §16) --------------------------------
//
// The `CAL-nn` values are no longer placeholders. Every one of them was read out
// of the game's own 6502 in the Battle City (J) disassembly
// `cyneprepou4uk/NES-Games-Disassembly@57972cd`, file `Battle City/bank_FF.asm`
// — the same pinned source Phase 7 transcribed the 35 stages from. Each constant
// below carries the label/address it came from; the ones that could NOT be
// closed say why, in place, rather than silently keeping a guess.
//
// Two unit facts make the conversion exact and are worth stating once:
//
//   1 ROM pixel == 1 u. The ROM's playfield origin is (16,16) on the 256-wide
//   NES screen, and its stored spawn coordinates are TANK CENTRES:
//   tbl_E474 = $18/$78/$D8 -> 24/120/216 -> field 8/104/200 = the centres of
//   tile columns 0/6/12; tbl_E47A = $58/$98 -> field 72/136 = tile 4/8 centres;
//   tbl_E47C = $D8 -> field 200 = tile 12 centre. Our field is 208 u wide and
//   those are exactly our spawn tiles, so pixels and `u` are the same unit.
//
//   1 ROM frame == 1 tick. `sub_C2E6_main_battle_script` ($C2E6) is the per-frame
//   script; anything it calls once per frame ticks at our TICK_S. Sub-rate
//   handlers are noted where they matter — several ROM timers count down once
//   per 64 frames (`AND #$3F` on the global frame counter), which is why so many
//   of the "round" second values below are really 64-frame units.
//
// NTSC hardware runs at 60.0988 Hz, not 60. Every frame->second conversion here
// uses our 60 Hz tick, so a 640-frame ROM timer is 10.667 s for us and 10.650 s
// on a CRT. That 0.16 % is below the resolution of anything this spec claims.
import type { EnemyType, PowerupType } from './types';

// --- Grid / geometry ---
export const TILE = 16;
export const SUBCELL = 8;
export const FIELD_TILES = 13;
export const FIELD_SUBCELLS = 26;
export const FIELD_U = 208;
export const TANK_SIZE = 16;
export const BULLET_SIZE = 4;

// --- Time ---
export const TICK_S = 1 / 60;

// Countdowns are stored in SECONDS but stepped one TICK_S at a time, so repeated
// subtraction drifts by a few ULPs — 3 s minus 180 ticks lands on 5.7e-15, not 0.
// HALF_TICK is the ONE shared "this countdown has reached zero" threshold: a still
// running timer is always ≳ TICK_S away from it, a finished one ≲ 0. It is
// determinism-critical (`<=` vs `<` here shifts exact tick counts, and therefore
// every golden replay), so it is defined exactly once and imported by both the
// spawner's cadence comparison and the effect timers below.
export const HALF_TICK = TICK_S / 2;

// One tick off a countdown, snapped to a hard 0 at the end (see HALF_TICK). A
// timer armed with a whole multiple of TICK_S therefore lasts EXACTLY that many
// ticks — never one more because of accumulated float error, and never one fewer.
export function stepDown(t: number): number {
  const next = t - TICK_S;
  return next <= HALF_TICK ? 0 : next;
}

// ROM frame count -> seconds at our fixed 60 Hz tick. Written as a division
// (not `n * TICK_S`) so a whole frame count lands on an exact tick boundary
// instead of one ULP short of it.
const romFrames = (n: number): number => n / 60;

// --- Speeds (u/s) ---
// CAL-01 / CAL-03. Every tank moves +/-1 px per *move tick* (tbl_E46C/tbl_E470 at
// $E46C are the unit direction vectors added straight onto the position at
// $DCA8/$DCB8) — the ROM has no speed field at all. Speed is entirely a matter of
// how often a tank's move tick comes round, decided in `sub_DBF1_tank_movement`:
//
//   players ($DC09): every frame except f%4 == 2   -> 3/4 px per frame -> 45 u/s
//   fast enemies ($DC25, type $A0): every frame    ->   1 px per frame -> 60 u/s
//   all other enemies ($DC2D, index^frame & 1):    -> 1/2 px per frame -> 30 u/s
//
// So the ROM has exactly two enemy speeds, and `power` is NOT one of the fast
// ones: only type $A0 (fast) is tested. Its "fast" trait is its bullet, not its
// hull ($E0C2: type $C0 sets bullet_property bit 0, which is the double step).
export const PLAYER_SPEED = 45; // CAL-01 ($DC09 + tbl_E46C)
export const ENEMY_SPEED: Record<EnemyType, number> = {
  basic: 30,
  fast: 60,
  power: 30,
  armor: 30,
}; // CAL-03 ($DC18..$DC33 + tbl_E46C)
// Not CAL-tagged, but confirmed on the same read: bullets step by 2 px/frame
// ($E063: `tbl_E46C[dir] ASL`), applied a second time for a bullet whose
// property bit 0 is set ($E05F) — 120 and 240 u/s exactly.
export const BULLET_SLOW = 120;
export const BULLET_FAST = 240;

// --- Timers (seconds) ---
// The helmet/shovel/clock timers are stored as counts of 64 FRAMES, not seconds:
// each is decremented only when the global frame counter satisfies `AND #$3F`
// ($E28C helmet, $E2B9 shovel, $DC00 clock). That single fact moves five of the
// six values below — the previous spec read the stored number as seconds.
export const SPAWN_SHIELD_S = romFrames(192); // CAL-02 ($E3C1 #$03 x 64 frames)
// CAL-06. Set to $C8 = 200 at $E8AA when a player is hit by the OTHER player's
// bullet, and decremented inside `sub_DB75` ($DB8F), which runs on the player
// cadence of 3 frames in every 4 — so 200 counts span 800/3 = 266.67 frames.
// Rounded UP to a whole tick: a stun that ends mid-tick would end next tick anyway.
export const STUN_S = romFrames(267); // CAL-06 ($E8AA + $DB8F)
export const HELMET_S = romFrames(640); // CAL-15 ($E9F0 #$0A x 64 frames)
export const CLOCK_S = romFrames(640); // CAL-16 ($E9F5 #$0A x 64 frames)
// CAL-17. One timer of $14 = 20 units of 64 frames ($EA04), and the blink starts
// when it drops below 4 ($E2BF `CMP #$04`) — so the 17 + 3 split was the right
// SHAPE all along, in the wrong unit. 17 units solid, 3 units blinking.
export const SHOVEL_SOLID_S = romFrames(1088); // CAL-17 (17 x 64)
export const SHOVEL_BLINK_S = romFrames(192); // CAL-17 (3 x 64)
// CAL-12. `tank_flags` is set to $F0 at $E3A9 and hand-cranked by two handlers,
// $DE55 ($F0->$FE) and $DE64 ($E0->$EE), 14 increments each; the tank materializes
// on the 28th ($E3B8). Those handlers run on the owning tank's move cadence, so
// for an enemy that is 28 x 2 = 56 frames.
export const SPAWN_ANIM_S = romFrames(56); // CAL-12 ($DE55/$DE64)
// Same 28-crank animation on the PLAYER cadence (3 frames in 4) = 37.33 frames.
// Not CAL-tagged; recovered on the same read and corrected from a flat 1.0 s.
export const PLAYER_RESPAWN_S = romFrames(38);
// The ROM does not throttle a blocked spawn at all: `sub_DB48` ($DB48) reloads
// `ram_enemy_timer_before_spawn` only on a spawn that actually happens ($DB5D),
// so a blocked attempt leaves the timer at 0 and retries on the very next frame.
// Recovered under CAL-11; the old 0.5 s was a guess.
export const SPAWN_RETRY_S = TICK_S;

// --- Stage-flow beats (seconds) ---
// Presentation timing, not calibration: these are the design's own beats (GDD §5
// / fidelity §11), not measurements of the NES build, so they carry no CAL tag.
// They are still simulation state — the phase machine counts them in whole ticks
// and a golden replay records the tick a phase flips — so they live here rather
// than in the app layer.
export const STAGE_INTRO_S = 2; // "STAGE N" curtain before control is handed over
// Beat between the last enemy dying and the tally. The core only counts `phaseT`
// through it — 'cleared' is terminal down here, and the app layer is what reads
// this constant to know when to raise the tally and load the next stage.
export const STAGE_CLEAR_S = 2;
export const GAME_OVER_DELAY_S = 3; // eagle explosion → game-over sequence

// --- Physics ---
// CAL-05. The ROM does not decelerate on ice at all — it coasts at full speed for
// a fixed number of steps. `sub_DB75` arms `ram_0103_plr_flags` with $9C ($DBBD)
// whenever a player drives on ice with the previous coast spent; the low 5 bits
// ($1C = 28) are a step counter that `ofs_000_DC52_80` ($DC5F) decrements — and
// moves the tank one pixel for — on every player move tick. So: 28 px of coast at
// 45 u/s, constant velocity, and bit 4 ($10) makes the first 12 of those 28 steps
// un-steerable.
//
// Two differences we do NOT reproduce, recorded rather than hidden:
//   * the ROM re-arms the counter to 28 each time it reaches 0 while a direction
//     is held, so the coast you actually get on release is the REMAINDER (0..27,
//     mean ~14). Ours always coasts the full distance, i.e. the ROM's maximum.
//   * the ROM's ice flag is only ever set for tank slots 0-1 ($E1AE) — enemies
//     never slide. Ours would slide any tank that stops on ice; in practice the
//     AI always supplies a direction, so no enemy has ever slid.
// The stored ROM number is the 28, so that is what is calibrated here; the decel
// is derived from it rather than guessed.
export const ICE_COAST_U = 28; // CAL-05 ($DBBD #$9C, low 5 bits)
export const ICE_DECEL = (PLAYER_SPEED * PLAYER_SPEED) / (2 * ICE_COAST_U);

// --- Spawning ---
// CAL-09. `ram_enemy_limit` is the highest tank slot the spawn scan will use, and
// the scan walks down to slot 2 ($DB53..$DB72). It is loaded with 5 for one player
// ($CA6F, `con_max_tanks - $02`) and 7 for two ($CA74, `con_max_tanks`) — slots
// 2..5 and 2..7 — so the on-field cap is FOUR in 1P and SIX in 2P, not four in
// both. Slots 0 and 1 belong to the players and are never spawned into.
export const ENEMY_CAP_1P = 4; // CAL-09 ($CA6F)
export const ENEMY_CAP_2P = 6; // CAL-09 ($CA74)
// Pool-sizing bound for anything that must allocate for the worst case.
export const ENEMY_CAP_MAX = ENEMY_CAP_2P;
export function enemyCap(players: 1 | 2): number {
  return players === 2 ? ENEMY_CAP_2P : ENEMY_CAP_1P;
}
export const ENEMY_TOTAL = 20; // $C353 #$14
// $E393: the carrier test compares `ram_enemy_spawn_cnt` (which counts DOWN from
// 20) against $11, $0A and $03 — the 4th, 11th and 18th spawns. Confirmed exactly.
export const CARRIER_ORDINALS: readonly number[] = [4, 11, 18]; // 1-based spawn ordinals

// --- Power-ups ---
// The canonical order of the six types. Replay-canonical: it is the index order
// the state hash writes. Reordering it changes every seeded run, so it lives here
// once rather than in each consumer. It is NOT the drop distribution — see below.
export const POWERUP_TYPES: readonly PowerupType[] = [
  'star',
  'helmet',
  'clock',
  'shovel',
  'grenade',
  'tank',
];

// CAL-14. The drop is NOT a uniform roll over six. $E8E6 draws `rand AND #$07`
// and indexes `tbl_E8FA` ($E8FA), an EIGHT-entry table in which star and grenade
// each appear twice:
//
//   helmet clock shovel star grenade tank grenade star
//
// so P(star) = P(grenade) = 2/8 and P(helmet) = P(clock) = P(shovel) = P(tank)
// = 1/8. (The ROM has a seventh bonus id, $06 "pistol", whose handler at $EA48 is
// a bare RTS; it is unreachable from this table and has no effect if forced.)
export const POWERUP_ROLL_TABLE: readonly PowerupType[] = [
  'helmet',
  'clock',
  'shovel',
  'star',
  'grenade',
  'tank',
  'grenade',
  'star',
];

// CAL-13. The drop position is not a free lattice point: `sub_E8BE` ($E8BE) draws
// `rand AND #$03` for each axis and pushes it through
// `sub_E902_convert_random_number_to_position` ($E902), which computes
// `((n*3)*2 + 6) * 8` = 48n + 48 — that is, one of FOUR screen coordinates
// $30/$60/$90/$C0. Subtracting the playfield origin gives field CENTRES of
// 32/80/128/176 u, and our power-up stores a 16x16 top-left, so 24/72/120/168.
// Sixteen possible positions in total, all subcell-aligned and all clear of the
// eagle ring by construction — the "not overlapping the base" rule the old spec
// carried is an emergent property of this grid, not a separate check.
export const POWERUP_SLOTS: readonly number[] = [24, 72, 120, 168];

// --- Scoring ---
// `tbl_E8BA_points_for_killing_enemy` ($E8BA) = $10/$20/$30/$40 through
// `sub_D9E1_calculate_decimal_number`, indexed by `(type >> 5) - 4`; the power-up
// pickup adds $50 at $E9B6. Confirmed, unchanged.
export const SCORE: Record<EnemyType, number> & { powerup: number } = {
  basic: 100,
  fast: 200,
  power: 300,
  armor: 400,
  powerup: 500,
};
export const BONUS_LIFE_AT = 20000;
export const START_LIVES = 3;
// $E3F4: an armor tank ($E0) is spawned with `ORA #$03` in the low bits of its
// type byte, and each hit decrements it ($E7E8) until `AND #$03` reads 0 and the
// tank dies ($E7F2) — four hits. An armor CARRIER is spawned $E7 and immediately
// clamped to $E4 ($E3FE) so it does not read as damaged while flashing; its first
// hit drops the bonus and bumps it back to $E3 ($E7E0) before the decrement, so a
// flashing armor tank still takes four hits in total. Confirmed, unchanged.
export const ARMOR_HP = 4;

// --- Field layout (tile coords) ---
// Geometric order, left to right. `tbl_E474_enemy_spawn_pos_X` ($E474) holds
// $18/$78/$D8 = field centres 8/104/200 = these three tile columns; the Y table
// ($E477) is $18 three times = tile row 0.
export const ENEMY_SPAWN_TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [6, 0],
  [12, 0],
];
// CAL-10. The cycle does NOT start at the left. `sub_E363_tank_spawn_handler`
// INCREMENTS `ram_enemy_spawn_pos_index` BEFORE using it ($E37C), and the index is
// zeroed once per stage at $C372 — so the first enemy of every stage appears at
// index 1 (centre), the second at 2 (right), the third wraps to 0 (left).
// Indices into ENEMY_SPAWN_TILES, in the order the ROM visits them.
export const SPAWN_CYCLE_ORDER: readonly number[] = [1, 2, 0]; // C -> R -> L
export const P1_SPAWN_TILE: readonly [number, number] = [4, 12];
export const P2_SPAWN_TILE: readonly [number, number] = [8, 12];
export const EAGLE_TILE: readonly [number, number] = [6, 12];
export const BASE_RING_TILES: readonly (readonly [number, number])[] = [
  [5, 11],
  [6, 11],
  [7, 11],
  [5, 12],
  [7, 12],
];

// The campaign loops after stage 35 but the internal counter keeps rising, so
// every stage-scaled formula clamps its stage term here (fidelity §7, §9, §11).
export const STAGE_CAP = 35;

// Ticks between enemy spawn attempts. CAL-11 — confirmed instruction for
// instruction at $C39E:
//
//   LDA ram_stage      (or #$23 = 35 on the second loop, $C397)
//   ASL ASL            ; stage * 4
//   LDA #$BE / SBC     ; 190 - that
//   ...if 2p: SBC #$14 ; - 20
//
// so `190 - 4*min(stage,35) - 20*(players-1)` FRAMES, and the reload lands in
// `ram_enemy_timer_before_spawn` which `sub_DB48` decrements once per frame — our
// ticks and the ROM's frames are the same unit, so the numbers transfer directly.
// The ROM has NO clamp: over stages 1..35 and 1..2 players the expression already
// spans exactly [30, 186], so the clamp below can never bind for a real stage. It
// is kept only as a guard for out-of-range stage numbers reaching here from the
// editor, and its bounds are ours, not the ROM's.
export function spawnIntervalTicks(stage: number, players: 1 | 2): number {
  const raw = 190 - 4 * Math.min(stage, STAGE_CAP) - 20 * (players - 1);
  return Math.min(192, Math.max(30, raw));
}

// --- Enemy AI ---
// [FEEL] fidelity §9. Still [FEEL] after the ROM read, and now for a documented
// reason rather than for lack of a source. The disassembly DOES contain the AI,
// and it is far cruder than this model:
//
//   * direction: `ofs_000_DC7C_A0` ($DC80) reconsiders only when the tank sits on
//     an 8 px lattice point AND `rand AND #$0F` == 0, then `sub_DE72` ($DE72)
//     compares `spawn_interval / 4` against the high byte of the frame counter to
//     decide between hunting the eagle and hunting a player; a blocked move
//     re-rolls with `rand AND #$03` ($DD17).
//   * fire: `sub_E162` ($E171) draws once per frame per enemy and fires on
//     `rand AND #$1F` == 0 — a flat 1-in-32, with NO aiming term at all.
//
// Adopting that wholesale would mean adopting the ROM's LCG and its frame-counter
// coupling, which is a different determinism model from ours, so these weights
// stay a perceived-equivalent reconstruction. They are a design choice, not a
// measurement, and the release notes say so.
// What is NOT tunable is the structure they plug into: the
// per-tick rng draw order (lattice roll → weighted pick → uniform fallback →
// timer reset → fire roll) is what every golden replay bakes in, so changing a
// value here rewrites recorded runs while changing the order breaks them.
export const AI_W_KEEP = 0.4; // weight: keep the current direction
export const AI_W_BASE_BASE = 0.2; // weight: turn toward the eagle, at stage 0
export const AI_W_BASE_PER_STAGE = 0.005; // …+ per stage (stage term capped at STAGE_CAP)
export const AI_W_BASE_MAX = 0.4; // …and never above this
export const AI_W_PLAYER = 0.1; // weight: turn toward the nearest player
// Everything left over goes to a uniform pick among the open directions.

export const AI_LATTICE_RECONSIDER = 0.25; // P(reconsider) when a tile line is crossed
export const AI_TIMER_MIN = 0.5; // decision timer = MIN + rand*SPAN → 0.5..2.0 s
export const AI_TIMER_SPAN = 1.5;

export const AI_FIRE_ALIGNED_PS = 0.9; // shots/s while lined up on a target
export const AI_FIRE_RANDOM_PS = 0.4; // shots/s otherwise
export const AI_ALIGN_TOLERANCE = 6; // max lateral centre offset (u) to count as lined up
