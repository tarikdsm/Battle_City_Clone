# Battle City Remake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Tasks use checkbox (`- [ ]`) syntax for tracking. **Executor agents run on Claude Opus 4.8** (orchestrator: Claude Fable 5).

**Goal:** Build the complete Battle City remake specified in docs 00–05: NES-faithful simulation, 2.5D Three.js presentation, synthesized audio, 35+12 stages, editor, 2P local, PWA.

**Architecture:** Pure deterministic core simulation (`src/core`, zero deps, 60 Hz fixed step, seeded RNG, event queue) consumed read-only by Three.js render, WebAudio audio, and DOM UI layers; app composes them under a fixed-timestep loop with interpolation. See [02-architecture.md](02-architecture.md).

**Tech Stack:** TypeScript (strict) · Vite · Three.js (pinned exact) · Web Audio API · Vitest · Playwright · ESLint flat + Prettier · vite-plugin-pwa · npm · Node ≥ 20.

## Global Constraints

Every task inherits these. Violations fail review.

- `src/core/` imports **nothing** and never touches `window`, `document`, `performance`, `Date`, or `Math.random` (ESLint-enforced; all randomness via `core/rng`).
- All gameplay values live in `src/core/constants.ts` as named constants; `[CAL-nn]` values carry a `// CAL-nn` comment (source: [01-fidelity-spec.md](01-fidelity-spec.md)).
- Fidelity spec **is law**: presentation layers may never alter simulation behavior; parity tests P-01…P-26 must stay green from the moment they exist.
- TDD: failing test first, then implementation. Tests live under `tests/` mirroring `src/`.
- No new runtime dependencies beyond `three` without orchestrator approval. Dev deps allowed: vitest, playwright, eslint/prettier stack, vite-plugin-pwa, tsx.
- Steady-state allocation-free sim; pooled render/FX objects (budgets: [02-architecture.md](02-architecture.md) §11, [03-art-direction.md](03-art-direction.md) §8).
- All UI copy in English, sentence case.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `content:`, `docs:`); one commit per task minimum, ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (executor) — orchestrator commits use its own trailer.
- **Definition of Done (every task):** listed tests written and green · `npm run check` clean (typecheck + lint + unit tests) · no console errors in `npm run dev` smoke · budgets respected · docs updated if an interface changed.

---

## 1. Orchestration protocol

- **Dispatch:** the orchestrator sends each task to a fresh Opus 4.8 subagent. The task brief = this plan's task block + §Global Constraints + §2 Contract Zero + the doc sections listed under *Spec*. The executor must read those repo docs before coding.
- **Standard TDD cycle (referenced by every task as "Steps: standard cycle"):**
  1. Read the listed *Spec* sections and *Contract Zero*.
  2. Write the failing tests listed under *Tests* (exact file path given).
  3. `npm run test -- <testfile>` → expect the listed failures (red).
  4. Implement minimally per *Build notes* until green.
  5. `npm run check` → all green.
  6. Commit with the given message.
  Any deviation/blocker → report back to orchestrator instead of improvising around the contract.
- **Review loop per task:** executor reports → orchestrator runs spec-compliance review + code review (fresh reviewer subagent for risky tasks) → fixes if needed → integrate.
- **Sequential execution (owner mandate, 2026-07-20):** exactly one executor agent runs at a time — no parallel dispatch of any kind. `Lane` letters remain in task headers as *dependency documentation only*; all tasks execute in plan order on the `dev` branch, merged to `main` by the orchestrator at each gate.
- **Phase gates:**
  - **G1** after Phase 1: all parity tests + golden replays green; sim step < 2 ms.
  - **G2** after Phase 3: first playable — owner plays stage 1 in browser and approves feel.
  - **G3** after Phase 6: full game loop (title → campaign → game over → hi-score) approved.
  - **G4** after Phase 9: mobile/touch/gamepad/PWA verified on real devices (owner assists).
  - **G5** after Phase 10: release approval.

## 2. Contract Zero — shared interfaces (locked)

Every executor uses these exact names/shapes. Extending is allowed; renaming/removing requires orchestrator approval. Introduced by T0.2/T1.1, then frozen.

```ts
// ---- core/types.ts ----
export type Dir = 0 | 1 | 2 | 3;                      // Up, Right, Down, Left (clockwise)
export const DIR_VECS: readonly (readonly [number, number])[]; // [[0,-1],[1,0],[0,1],[-1,0]]
export type EnemyType = 'basic' | 'fast' | 'power' | 'armor';
export type PowerupType = 'star' | 'helmet' | 'clock' | 'shovel' | 'grenade' | 'tank';
export const Terrain: { Empty: 0; Brick: 1; Steel: 2; Water: 3; Trees: 4; Ice: 5 };
export type TerrainKind = 0 | 1 | 2 | 3 | 4 | 5;

export interface PlayerIntent { dir: Dir | null; fire: boolean; pause: boolean }
export const NULL_INTENT: PlayerIntent;

export interface Tank {
  id: number; alive: boolean; kind: 'player' | 'enemy';
  playerIndex?: 0 | 1;            // players only
  enemyType?: EnemyType;          // enemies only
  spawnOrdinal?: number;          // enemies, 1-based
  carrier?: boolean;              // true while flashing (drops power-up on first hit)
  x: number; y: number;           // AABB top-left, units; size TANK_SIZE
  prevX: number; prevY: number;   // previous tick (render interpolation)
  dir: Dir; moving: boolean; sliding: boolean;
  hp: number; tier: 0 | 1 | 2 | 3;            // tier meaningful for players (0 for enemies)
  shieldT: number; stunT: number; frozenT: number; spawningT: number; // seconds remaining, 0 = inactive
  bulletsAirborne: number;
}

export interface Bullet {
  id: number; alive: boolean;
  x: number; y: number; prevX: number; prevY: number; // AABB top-left, size BULLET_SIZE
  dir: Dir; speed: number;
  fromTankId: number; byPlayer: boolean; playerIndex?: 0 | 1;
  canHurtSteel: boolean;
}

export interface PlayerMeta { lives: number; score: number; nextBonusAt: number;
  destroyedByType: Record<EnemyType, number>; active: boolean }

export type StagePhase = 'intro' | 'playing' | 'cleared' | 'baseLost' | 'gameOver';

export interface GameState {
  tick: number; rng: { s: number };
  stageNumber: number; phase: StagePhase; phaseT: number; paused: boolean;
  terrain: Uint8Array;            // 26*26 subcell kinds, index = sy*26+sx
  eagleAlive: boolean;
  shovel: { phase: 'off' | 'steel' | 'blink'; t: number };
  clockT: number;
  tanks: Tank[]; bullets: Bullet[];
  powerup: { type: PowerupType; x: number; y: number } | null;
  players: [PlayerMeta, PlayerMeta];
  spawner: { queue: EnemyType[]; nextOrdinal: number; cyclePos: number; timerT: number; retryT: number };
  events: GameEvent[];            // cleared at the start of each stepGame
}

// ---- core/events.ts ---- (exhaustive; presentation switches on `t`)
export type GameEvent =
  | { t: 'shotFired'; tankId: number; x: number; y: number; dir: Dir; byPlayer: boolean }
  | { t: 'bulletsCanceled'; x: number; y: number }
  | { t: 'bulletDespawned'; x: number; y: number; reason: 'border' | 'hit' }
  | { t: 'brickHit'; tx: number; ty: number; removedMask: number; x: number; y: number; dir: Dir }
  | { t: 'steelHit'; tx: number; ty: number; removedMask: number; destroyed: boolean; x: number; y: number; dir: Dir }
  | { t: 'tankHit'; tankId: number; hpLeft: number }
  | { t: 'tankDestroyed'; tankId: number; kind: 'player' | 'enemy'; enemyType?: EnemyType;
      byPlayerIndex?: 0 | 1; points: number; x: number; y: number }
  | { t: 'playerStunned'; playerIndex: 0 | 1; durS: number }
  | { t: 'playerSpawned'; playerIndex: 0 | 1; x: number; y: number }
  | { t: 'enemySpawnStarted'; spawnOrdinal: number; x: number; y: number; enemyType: EnemyType; carrier: boolean }
  | { t: 'enemySpawned'; tankId: number }
  | { t: 'powerupSpawned'; type: PowerupType; x: number; y: number }
  | { t: 'powerupCollected'; type: PowerupType; playerIndex: 0 | 1; x: number; y: number }
  | { t: 'tierChanged'; playerIndex: 0 | 1; tier: 0 | 1 | 2 | 3 }
  | { t: 'shovelPhase'; phase: 'steel' | 'blink' | 'revert' }
  | { t: 'clockStarted' } | { t: 'clockEnded' }
  | { t: 'grenadeUsed'; kills: number }
  | { t: 'extraLife'; playerIndex: 0 | 1 }
  | { t: 'scoreAwarded'; playerIndex: 0 | 1; points: number; x: number; y: number }
  | { t: 'iceSkidStarted'; tankId: number }
  | { t: 'treeEntered'; tankId: number }
  | { t: 'baseDestroyed' } | { t: 'stageCleared' } | { t: 'gameOver' }
  | { t: 'pauseToggled'; paused: boolean };

// ---- core/game.ts ----
export function createGame(level: LevelData, opts: { players: 1 | 2; seed: number; stageNumber: number }): GameState;
export function stepGame(state: GameState, intents: readonly [PlayerIntent, PlayerIntent]): void; // one 60Hz tick
export function hashState(state: GameState): number;    // FNV-1a 32-bit over canonical fields

// ---- levels/schema.ts ---- (format: 05-content-levels.md §1)
export interface LevelData { version: 1; id: string; name: string; author?: string;
  terrain: string[]; partials?: { tx: number; ty: number; mask: number }[];
  enemies: EnemyType[]; noAutoBase?: boolean }
export function validateLevel(data: unknown): { ok: true; level: LevelData } | { ok: false; errors: string[] };

// ---- layer factories (app wires these) ----
// render/renderer.ts
export function createRenderer(canvas: HTMLCanvasElement, quality: Quality): Renderer;
export interface Renderer { render(state: GameState, alpha: number, dtMs: number): void;
  onEvent(e: GameEvent): void; setQuality(q: Quality): void; resize(w: number, h: number): void; dispose(): void }
export type Quality = 'low' | 'medium' | 'high';
// audio/audio.ts
export function createAudio(): AudioSystem;
export interface AudioSystem { onEvent(e: GameEvent): void; update(state: GameState, dtMs: number): void;
  setVolumes(v: { music: number; sfx: number }): void; resume(): void; suspend(): void }
// input/input.ts
export function createInput(bindings: Bindings): InputSystem;
export interface InputSystem { poll(): [PlayerIntent, PlayerIntent]; dispose(): void }
```

**Key constants (core/constants.ts — canonical names; values + CAL ids from fidelity spec):**
`TILE=16` `SUBCELL=8` `FIELD_TILES=13` `FIELD_U=208` `TANK_SIZE=16` `BULLET_SIZE=4` `TICK_S=1/60`,
`PLAYER_SPEED=45` (CAL-01), `ENEMY_SPEED: {basic:30, fast:60, power:45, armor:30}` (CAL-03),
`BULLET_SLOW=120` `BULLET_FAST=240`, `SPAWN_SHIELD_S=3` (CAL-02), `STUN_S=3` (CAL-06),
`HELMET_S=10` (CAL-15), `CLOCK_S=10` (CAL-16), `SHOVEL_SOLID_S=17` `SHOVEL_BLINK_S=3` (CAL-17),
`SPAWN_ANIM_S=1.3` (CAL-12), `ICE_DECEL=240` (CAL-05), `ENEMY_CAP=4` (CAL-09),
`CARRIER_ORDINALS=[4,11,18]` (1-based), `SCORE: {basic:100, fast:200, power:300, armor:400, powerup:500}`,
`BONUS_LIFE_AT=20000`, `START_LIVES=3`, `ARMOR_HP=4`,
`spawnIntervalTicks(stage, players) = clamp(190 - 4*min(stage,35) - 20*(players-1), 30, 192)` (CAL-11),
spawn points `[(0,0),(6,0),(12,0)]` cycle order L→C→R (CAL-10), `P1_SPAWN=(4,12)` `P2_SPAWN=(8,12)` `EAGLE_TILE=(6,12)`.

**npm scripts (fixed names):** `dev` `build` `preview` `test` `test:watch` `e2e` `lint` `typecheck` `format` `check` (typecheck+lint+test) `levels:preview`.

## 3. File structure

```
index.html                    · canvas + UI root, font preloads
src/app/main.ts               · boot, composition root
src/app/loop.ts               · fixed-timestep accumulator + interpolation alpha
src/app/screens.ts            · screen state machine (GDD §5 names)
src/app/session.ts            · campaign/run state (stage progression, players)
src/app/storage.ts            · versioned localStorage (arch §4.2)
src/core/constants.ts|types.ts|events.ts|rng.ts|grid.ts
src/core/game.ts              · createGame/stepGame/hashState + system order
src/core/systems/*.ts         · movement, bullets, spawner, powerups, ai, players, stageflow
src/levels/schema.ts          · LevelData + validateLevel + base auto-stamp
src/levels/original/stageNN.json (35) · src/levels/neo/neoNN.json (12)
src/render/renderer.ts        · createRenderer, composer, quality
src/render/sceneRoot.ts       · board, camera rig, lights
src/render/terrainView.ts     · instanced terrain + dirty updates
src/render/tankView.ts|bulletView.ts · pooled entity views + model factories
src/render/models.ts          · procedural geometry builders (art §4)
src/render/fx/fxSystem.ts     · particle/light pools + budgets
src/render/fx/recipes.ts      · event → effect recipes (art §8)
src/render/cameraFx.ts        · trauma shake, fly-in, slow-mo, curtain
src/render/materials.ts       · palette tokens (art §3), water/ice shaders
src/audio/audio.ts            · createAudio, buses, ducking
src/audio/synth.ts            · instrument patches (audio §3)
src/audio/sequencer.ts        · lookahead scheduler, song format
src/audio/songs/*.ts          · title, fanfare, suite, tally, gameover, hiscore
src/audio/sfx.ts              · SFX patch registry (audio §5)
src/input/keyboard.ts|gamepad.ts|touch.ts|input.ts
src/ui/hud.ts|menus.ts|screens/*.ts|styles.css
src/ui/fonts/                 · Orbitron + Inter woff2 + OFL licenses
src/editor/editor.ts|tools.ts|waveEditor.ts|share.ts
scripts/level-preview.ts      · ASCII contact sheet
tests/…                       · mirrors src (unit); tests/replays/*.json golden fixtures
e2e/smoke.spec.ts             · Playwright
```

---

## Phase 0 — Foundation

### - [ ] T0.1 Scaffold & toolchain — Lane main
**Files:** create `package.json`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `index.html`, `src/app/main.ts` (canvas mount + "boot ok" console), `playwright.config.ts`, `e2e/smoke.spec.ts` (page loads, no console errors), `tests/setup.test.ts` (trivial green test), dir skeleton per §3 with `.gitkeep`.
**Spec:** arch §1–2. **Produces:** working toolchain, npm scripts (§2 list), ESLint boundary rules (core restricted imports + banned globals `Math.random|Date|window|document|performance` within `src/core/**`).
**Tests:** `tests/setup.test.ts` (1+1) and boundary lint proof: a temp file importing `three` inside `src/core` must fail `npm run lint` (executor demonstrates in report, then deletes).
**Steps:** standard cycle. Pin `three` exact version; record versions in report. Playwright installs chromium.
**Commit:** `chore: scaffold vite+ts+three toolchain with core boundary rules`

### - [ ] T0.2 Core kernel: constants, types, rng, grid, events — Lane main
**Files:** create `src/core/{constants,types,events,rng,grid}.ts`; tests `tests/core/{rng,grid,constants}.test.ts`.
**Spec:** fidelity §1–2 + §2 Contract Zero. **Produces:** every §2 type; `grid`: `aabbOverlap`, `tileAt(sx,sy)`, `subcellIndex`, `snap8(v)`, `tilesInAabb`, `forEachSubcellUnder(aabb)`.
**Tests (concrete):** mulberry32 with seed 12345 first 3 floats match snapshot & repeatable; `nextInt(4)` distribution over 10k draws within ±5% (4k was statistically too tight at ~1.8σ); `snap8(37.3)===40`, `snap8(32)===32`, `snap8(36)===40` (nearest multiple of 8, half rounds up — tie-break is a calibration-grade detail), `snap8(-3)===0` (clamped ≥0); `spawnIntervalTicks(1,1)===186`, `(35,1)===50`, `(1,2)===166`, `(99,1)===50`, floor `30`, ceil `192`; constants spot-check vs fidelity tables (PLAYER_SPEED 45 etc.).
**Steps:** standard cycle. **Commit:** `feat(core): kernel types, constants with CAL tags, seeded rng, grid math`

## Phase 1 — Core simulation (all Lane main, sequential; gate G1 at end)

### - [ ] T1.1 Level loading, terrain, game skeleton
**Files:** create `src/levels/schema.ts`, `src/core/game.ts` (createGame + stepGame skeleton: clears `events`, advances `tick`, calls empty system fns in arch §3.2 order; hashState), `src/core/systems/index.ts` stubs; test `tests/core/level.test.ts`, `tests/levels/schema.test.ts`; fixture `tests/fixtures/level-basic.json` (simple valid level: border-safe brick cross + 20 basics).
**Spec:** content §1, fidelity §1–2, arch §3.1–3.3.
**Tests:** validateLevel rejects: 12 rows, 14-char row, bad char, 19 enemies, partials on `W`, occupied spawn tile — each with readable error containing the reason; accepts fixture; createGame stamps eagle ring bricks at `(5,11)(6,11)(7,11)(5,12)(7,12)` (assert subcell kinds), spawn/player tiles empty, `terrain.length===676`; partials mask applied (tile (2,2) mask 5 → TL+BL brick only); hashState stable across two identical createGame calls and changes when a subcell differs.
**Commit:** `feat(core): level schema/validation, terrain grid, game skeleton with system order`

### - [ ] T1.2 Movement: players, turn snap, blocking, ice
**Files:** create `src/core/systems/movement.ts`; test `tests/core/movement.test.ts`.
**Spec:** fidelity §4; parity P-01, P-09 (movement half).
**Tests:** helper `game()` builds state from fixture + places tanks directly. Cases: move right 60 ticks from x=32 ⇒ x=32+45·1=77 (float tolerance 1e-9); turning up at x=37.3 snaps x to 40, at x=36 stays 36 (P-01); 180° reversal keeps x exact (P-01); blocked flush against brick subcell (tank at x approaching wall stops with `x+16===wallX`); tank-vs-tank blocking; water blocks, trees don't (P-09); border clamp; ice: enter ice tile, release input ⇒ slides ~4.2u (45²/(2·240)) then stops, `iceSkidStarted` emitted once; new input overrides slide; `treeEntered` emitted on entering trees tile.
**Commit:** `feat(core): movement system with turn snap, blocking, ice slide (P-01, P-09)`

### - [ ] T1.3 Bullets, combat, terrain damage
**Files:** create `src/core/systems/bullets.ts`; test `tests/core/bullets.test.ts`.
**Spec:** fidelity §3.1 (tier table), §5, §6; parity P-02, P-04–P-08, P-10, P-22, P-24.
**Tests:** fire spawns bullet at muzzle center moving 120 u/s tier0 / 240 tier1+ (P-02); cap: tier0/1 one airborne, tier2/3 two — third fire ignored until despawn (P-22); enemy cap 1 (P-24); brick: rightward bullet into tile ⇒ removedMask west half `TL|BL=5`, second hit clears; upward bullet ⇒ south half `BL|BR=12` (P-04); tier3 clears full tile one hit; steel: tier<3 `steelHit destroyed:false` bullet gone, tier3 removes near half (P-05); player bullet vs enemy bullet both die + `bulletsCanceled` (P-07); enemy bullet passes through enemy tank (P-06); player bullet on other player ⇒ `playerStunned` 3s, no hp loss, stunned can't move/fire until timer (P-08); armor takes 4 hits with `tankHit hpLeft` 3,2,1 then destroyed 400 pts; eagle hit by any bullet ⇒ `baseDestroyed`, phase `baseLost` (P-10); border despawn event; shielded player consumes bullet without damage.
**Commit:** `feat(core): bullets, interaction matrix, subcell terrain damage (P-02..P-10, P-22, P-24)`

### - [ ] T1.4 Enemy spawner
**Files:** create `src/core/systems/spawner.ts`; test `tests/core/spawner.test.ts`.
**Spec:** fidelity §7; parity P-11, P-12, P-25.
**Tests:** first spawn at tick 0 at left point; subsequent at `spawnIntervalTicks` cadence cycling L→C→R (P-12); icons semantics: `enemySpawnStarted` events count == spawned (HUD consumes); cap 4 enforced (P-11); blocked point (tank parked) ⇒ hold + retry 0.5s without advancing cycle (P-12); materialize after `SPAWN_ANIM_S` with `enemySpawned`, no collision while spawning; ordinals 4/11/18 flagged `carrier:true` (P-13 half); queue exhausts at 20; stage>35 uses capped formula (P-25); 2P interval term.
**Commit:** `feat(core): enemy spawner with cadence formula and carriers (P-11, P-12, P-25)`

### - [ ] T1.5 Power-ups & timed effects
**Files:** create `src/core/systems/powerups.ts`; test `tests/core/powerups.test.ts`.
**Spec:** fidelity §8; parity P-13–P-18.
**Tests:** first hit on carrier spawns powerup + unflags (P-13), position subcell-aligned inside field excluding eagle-ring tiles; single powerup — new replaces (P-14); pickup awards 500 + `powerupCollected`; star: tier up, capped at 3 (P-15); helmet: `shieldT` 10s, re-pickup resets; clock: all enemies `frozenT` — no move/fire, spawn-during-clock frozen with remaining duration (P-17); shovel: ring subcells become steel + damage repaired, after 17s `shovelPhase blink`, after +3s revert to full brick repaired (P-16); grenade: all materialized enemies destroyed, zero points, spawning stars unaffected (P-18); tank: +1 life `extraLife`.
**Commit:** `feat(core): six power-ups with timed effects (P-13..P-18)`

### - [ ] T1.6 Enemy AI
**Files:** create `src/core/systems/ai.ts`; test `tests/core/ai.test.ts`.
**Spec:** fidelity §9 (weights, timers, fire probabilities — implement exactly; tuning happens only via constants).
**Tests:** determinism: same seed ⇒ identical decision sequence over 600 ticks (positions hash equal); blocked tank picks an open direction (never rams wall >1 tick); alignment fire: enemy facing player same column within 6u fires within 2s at p=0.9/s (statistical: over 20 seeded runs ≥16 fire); frozen enemies make no decisions and resume timers; direction weights sampled over 5k decisions within ±3% of spec (seeded).
**Commit:** `feat(core): deterministic enemy AI per fidelity §9`

### - [ ] T1.7 Players, scoring, stage flow, 2P
**Files:** create `src/core/systems/{players,stageflow}.ts`; test `tests/core/{players,stageflow}.test.ts`.
**Spec:** fidelity §3.1, §10–13; parity P-03, P-19, P-20, P-21, P-26.
**Tests:** death ⇒ tier reset 0, respawn after 1s with 3s shield (P-03), lives decrement; scoring per type + killer attribution (P-19); bonus life exactly once at ≥20000 (P-20, cross 19900→20100 by 300-kill); 2P: shared queue, separate scores, out-player stays out, game continues; game over when both out or base lost (P-21); stage cleared when 20th destroyed ⇒ phase `cleared` + `stageCleared`; `destroyedByType` tallies; pause: `pause` intent edge toggles `paused`, stepGame early-outs (timers frozen) + `pauseToggled` (P-26); intro phase 2s before first control.
**Commit:** `feat(core): players, scoring, stage flow, 2P rules (P-03, P-19..P-21, P-26)`

### - [ ] T1.8 Integration: system order, golden replays, perf
**Files:** modify `src/core/game.ts` (final wiring per arch §3.2); create `tests/core/replay.test.ts`, `tests/replays/{replay1,replay2,replay3}.json` (generated fixtures: stage-1-like level; seeds 1/2/3; 1800 scripted ticks each — scripted intents defined in the test generator, committed as JSON).
**Spec:** arch §3.2–3.5; parity P-23.
**Tests:** replaying each fixture yields recorded `hashState` (P-23); event-order regression: fixture 1's event log first 50 events match snapshot; perf: 1800 ticks complete < 500 ms in CI-ish conditions (soft assert with generous 3× margin); full parity suite P-01…P-26 green (meta-test asserting all tagged tests exist: grep test titles for `P-\d\d`).
**Commit:** `feat(core): integrated step order + golden replays (P-23) — core complete`
**⛔ Gate G1** — orchestrator review of the whole core.

## Phase 2 — Render foundation (Lane main)

### - [ ] T2.1 App loop, screen skeleton, error handling & debug flags
**Files:** create `src/app/{loop,screens,session,storage,debug}.ts`; tests `tests/app/{loop,storage,debug}.test.ts`.
**Spec:** arch §3.4, §4.2, §8, §12; GDD §5.
**Tests:** loop (injected clock): 100ms elapsed ⇒ 6 steps + alpha∈[0,1); 400ms spike clamps to 250ms (15 steps max); pause stops stepping; storage: versioned get/set roundtrip, corrupt JSON ⇒ defaults (no throw), unknown fields preserved-then-dropped per key policy; debug: URL params `?stage=n&seed=n&quality=low&overlay=1` parsed in dev builds only (prod build ignores them).
**Build notes:** screens = typed registry `show(name)` swapping DOM roots + enter/leave hooks; play screen owns loop. Global error handler → friendly error screen (reload + copy details) per arch §12; WebGL context-loss listener rebuilds renderer from state.
**Commit:** `feat(app): fixed-timestep loop, screen machine, storage, error/debug rails`

### - [ ] T2.2 Scene root: board, camera, lights, quality plumbing
**Files:** create `src/render/{renderer,sceneRoot,materials}.ts`; test `tests/render/materials.test.ts` (palette tokens exact hexes from art §3 — data-only test).
**Spec:** art §2–3, §6–7; arch §5. **Produces:** `createRenderer` per Contract Zero (renders board + placeholder tanks as boxes reading GameState).
**Build notes:** ortho camera pitch 32°, yaw 0; board plane + frame; key/hemi lights + shadow config per preset; ACES, exposure 1.1; DPR caps; resize letterboxing. Visual check: `npm run dev` shows lit board with placeholder entities on fixture level (orchestrator eyeballs screenshot in report).
**Commit:** `feat(render): scene root with tilted ortho rig, lighting, presets`

### - [ ] T2.3 Terrain renderer
**Files:** create `src/render/terrainView.ts`; extend renderer. Test `tests/render/terrainView.test.ts` (instance-count bookkeeping with mocked three via lightweight fake — count instances per kind for fixture level; dirty update removes exactly the subcells of a `brickHit` mask).
**Spec:** art §5; arch §5.
**Build notes:** InstancedMesh per material (brick/steel subcell boxes, water plane shader from materials.ts, tree canopies above tank layer, ice decals); event-driven dirty updates (`brickHit`/`steelHit`/shovel phases rebuild ring tiles).
**Commit:** `feat(render): instanced terrain with event-driven damage updates`

### - [ ] T2.4 Tank & bullet views, procedural models
**Files:** create `src/render/{models,tankView,bulletView}.ts`. Test `tests/render/models.test.ts` (geometry factories return per-type part counts/dimensions per art §4 table; tier ring count === tier).
**Spec:** art §4, §9 (animation specs).
**Build notes:** silhouettes per type; pooled views keyed by tank id; interpolate prevX/prevY→x/y with alpha; track stepping, turret recoil on `shotFired`, 2.5° turn lean, spawn-star billboard while `spawningT>0`, carrier 4Hz emissive pulse, armor HP tint crossfade, shield shimmer while `shieldT>0`, stun stars while `stunT>0`.
**Commit:** `feat(render): procedural tank/bullet models with animation states`

### - [ ] T2.5 Post chain & auto quality
**Files:** create `src/render/post.ts`; extend renderer; modify `src/app/main.ts` (auto-probe on title: DPR/cores/1s FPS sample → preset; override persisted).
**Spec:** art §7; arch §5.
**Tests:** preset table data test (post.ts exports per-preset config matching art §7 exactly); probe unit test with injected samples (30fps sample ⇒ 'low', 60fps+DPR2+8cores ⇒ 'high').
**Commit:** `feat(render): bloom/AA/vignette post chain with auto quality probe`

## Phase 3 — First playable (Lane main)

### - [ ] T3.1 Keyboard input
**Files:** create `src/input/{keyboard,input}.ts`; test `tests/input/keyboard.test.ts` (fake KeyboardEvents: WASD+J → P1 intent; arrows+Numpad0 → P2; dominant-axis latch — pressing D while W held keeps last-pressed axis; fire edge + hold; pause edge; rebinding map applied).
**Spec:** GDD §7; arch §7.
**Commit:** `feat(input): remappable 2-player keyboard with 4-way latch`

### - [ ] T3.2 Playable stage integration + smoke E2E
**Files:** modify `src/app/{main,screens,session}.ts`; create `src/ui/hud.ts` (minimal: enemies-left icons, lives, score, stage — DOM, event-driven), `src/levels/original/stage01.json` (**provisional** hand-made approximation clearly marked `"name":"Stage 1 (provisional)"` — replaced in Phase 7), `e2e/smoke.spec.ts` (extend): boot → title → start 1P → 10 s of scripted keys → expect canvas pixels changing, HUD counters, zero console errors; editor route stub excluded.
**Spec:** GDD §5–6, §9.
**Steps:** standard cycle + run `npm run e2e` locally green.
**Commit:** `feat(app): first playable stage with minimal HUD and smoke e2e`
**⛔ Gate G2** — owner plays; feel sign-off.

## Phase 4 — VFX & juice (Lane A after G2)

### - [ ] T4.1 FxSystem: pools & budgets
**Files:** create `src/render/fx/fxSystem.ts`; test `tests/render/fxSystem.test.ts` (pool: acquire beyond cap drops lowest priority, zero allocations after warmup — assert stable pool array identities; light pool caps at 8 with priority eviction).
**Spec:** art §8 budgets; arch §5.
**Commit:** `feat(render): pooled particle/light fx system with priority budgets`

### - [ ] T4.2 Effect recipes
**Files:** create `src/render/fx/recipes.ts`; test `tests/render/recipes.test.ts` (each GameEvent type maps to a recipe within art §8 particle budget; table-driven).
**Spec:** art §8 (all rows), §6 dynamic lights.
**Build notes:** implement every row incl. brick chunks with gravity/bounce, base slow-mo hooks (emits cameraFx request), muzzle/explosion lights, powerup/spawn/stun/skid/rustle.
**Commit:** `feat(render): full event→vfx recipe set per art direction`

### - [ ] T4.3 Camera FX, curtain transition, popups, reduced motion
**Files:** create `src/render/cameraFx.ts`; modify renderer + play screen; test `tests/render/cameraFx.test.ts` (trauma decays 1.2/s; offset = trauma²·3u max; reduced-motion flag zeroes shake/slow-mo/flash but recipes still emit particles; curtain timeline 300ms in / 300ms out synced with fly-in per art §10).
**Spec:** art §2, §10 (popups + curtain), §11; GDD §10 toggles.
**Build notes:** curtain = twin steel shutters wipe on stage intro/outro, driven by the same timeline as the 55°→32° camera fly-in (art §2).
**Commit:** `feat(render): trauma shake, curtain fly-in, slow-mo, score popups, reduced motion`

## Phase 5 — Audio (Lane B after G2)

### - [ ] T5.1 Engine, instruments, sequencer
**Files:** create `src/audio/{audio,synth,sequencer}.ts`; tests `tests/audio/sequencer.test.ts` (injected fake clock/context: lookahead schedules note-ons at correct AudioContext times ±1ms over tempo changes; loop wraps at `loopAtTick`; layer gain automation ramps 250ms), `tests/audio/synth.test.ts` (patch registry exposes all audio §3 patches; envelope param maps).
**Spec:** audio §2–3; arch §6. **Produces:** Contract Zero AudioSystem; song format exactly audio §2.
**Build notes:** OfflineAudioContext-based unit checks acceptable; gesture resume; buses + comp/limiter + ducking hooks.
**Commit:** `feat(audio): webaudio engine, instrument patches, lookahead sequencer`

### - [ ] T5.2 SFX set + ducking
**Files:** create `src/audio/sfx.ts`; test `tests/audio/sfx.test.ts` (every audio §5 ID registered with priority/poly caps; ducking matrix values; retrigger guard 30ms; engine hum pitch follows `moving`/speed).
**Spec:** audio §5–6.
**Commit:** `feat(audio): full parametric sfx set with ducking matrix`

### - [ ] T5.3 Music: arrangements + adaptive suite
**Files:** create `src/audio/songs/{title,fanfare,suite,tally,gameover,hiscore,pause}.ts`; extend audio.ts intensity logic; test `tests/audio/suite.test.ts` (layer targets from state: 3 enemies on field ⇒ L2 on; ≤5 left ⇒ L3; base breached or last life ⇒ L4; clock ⇒ lowpass flag).
**Spec:** audio §4, §7 (faithfulness ledger — fanfare/gameover/pause must be motif-recognizable; orchestrator gates by ear).
**Commit:** `feat(audio): faithful jingles + adaptive 5-layer gameplay suite`

## Phase 6 — UI, screens, persistence (Lane main; merges A/B when ready)

### - [ ] T6.1 Menus, settings, pause
**Files:** create `src/ui/{menus,styles.css}`, `src/ui/screens/{title,menu,settings,pause}.ts`; modify screens.ts. Test `tests/ui/settings.test.ts` (settings persist via storage: volumes, quality, toggles, bindings; navigation model up/down/select works from abstract nav events).
**Spec:** GDD §5, §10; art §10 styling (panels, focus ring, fonts placeholder until T6.3).
**Commit:** `feat(ui): title/menu/settings/pause with persisted settings`

### - [ ] T6.2 Campaign flow, tally, game over, hi-scores
**Files:** create `src/ui/screens/{stageSelect,intro,tally,gameOver,hiScore}.ts`; extend session.ts (progress, loop-after-35, per-run carryover). Tests `tests/app/session.test.ts` (progress unlock persists; loop 35→1 keeps rising internal stage; score carry; hi-score qualifies top-10, initials entry model 3 chars, seed entry 20000).
**Spec:** GDD §5, §8; fidelity §11–13.
**Commit:** `feat(ui): full campaign loop with tally and arcade hi-scores`

### - [ ] T6.3 Final HUD + fonts
**Files:** create `src/ui/fonts/` (download Orbitron + Inter woff2 subsets + OFL licenses — network allowed this task only, from fonts.gstatic.com; commit files), finalize `src/ui/hud.ts` per art §10 (enemy grid, player cards, tier pips, stage flag; portrait variant), `index.html` preloads.
**Tests:** `tests/ui/hud.test.ts` (HUD model derives from events/state: 20 icons decrement on `enemySpawnStarted`; lives/tier react).
**Spec:** art §10; GDD §9.
**Commit:** `feat(ui): final HUD and bundled OFL fonts`
**⛔ Gate G3** — owner full-loop review.

## Phase 7 — Content: original 35 (Lane C after G1 for T7.1; T7.2–4 parallelizable, disjoint files)

### - [ ] T7.1 Level tooling & validation suite
**Files:** create `scripts/level-preview.ts` (ASCII contact sheet: all levels → `docs/assets/level-contact-sheet.txt`, includes openness metric per content §4), extend `tests/levels/schema.test.ts` with completability check (BFS from each spawn over non-blocking tiles reaches ≥40% of field).
**Spec:** content §2.2, §4. **Commit:** `feat(levels): preview tooling and completability validation`

### - [ ] T7.2 / T7.3 / T7.4 Transcribe stages 1–12 / 13–24 / 25–35
**Files:** create `src/levels/original/stageNN.json` for the range (replacing T3.2's provisional stage01 in T7.2).
**Spec:** content §2 (sources + protocol). Each stage: terrain rows + partials (half-tiles!) + 20-enemy composition from the cited FAQs (WebFetch; if a source 403s, report to orchestrator who fetches/mirrors).
**Process per stage:** transcribe → `npm run levels:preview` → self-check against source → validation tests green. After the batch: orchestrator dispatches an **independent verifier agent** (sees only JSON + sources) whose diff report must be clean before the gate.
**Tests:** all stages pass schema + completability; stage count assertion.
**Commits:** `content: original stages 1-12 transcribed` (etc.)

## Phase 8 — Editor & Neo campaign (Lane main after G3)

### - [ ] T8.1 Editor: painting & wave editing
**Files:** create `src/editor/{editor,tools,waveEditor}.ts`, `src/ui/screens/editor.ts` (route `#editor`, code-split). Test `tests/editor/tools.test.ts` (paint tile/subcell mode produces expected LevelData mutations; validation surfaces content §1 errors verbatim).
**Spec:** arch §9; content §1, §5.
**Commit:** `feat(editor): terrain painting and enemy wave editor`

### - [ ] T8.2 Editor: test-play, save, share codes
**Files:** create `src/editor/share.ts`; extend editor + menus (custom levels list/play). Tests `tests/editor/share.test.ts` (roundtrip JSON↔`BC1.` base64url; tampered payload → readable error; unknown prefix `BC2.` rejected).
**Spec:** arch §9; content §5.
**Commit:** `feat(editor): instant test-play, local save, share codes`

### - [ ] T8.3 Neo campaign (12 stages)
**Files:** create `src/levels/neo/neo01..12.json` per content §3 briefs (authored via the editor — dogfood; any editor friction reported becomes fix-first).
**Tests:** schema+completability; contact sheet regenerated; difficulty positions per content §4.
**Commit:** `content: neo campaign (12 stages)` — playtest gate with owner.

## Phase 9 — Inputs & platform (Lane main)

### - [ ] T9.1 Gamepad
**Files:** create `src/input/gamepad.ts`; extend input.ts + menus nav. Test `tests/input/gamepad.test.ts` (fake Gamepad API: standard mapping, hot-plug assignment first-free-slot, stick 4-way latch with 0.4 deadzone, menu nav events).
**Spec:** GDD §7; arch §7. **Commit:** `feat(input): hot-plug gamepads for both players`

### - [ ] T9.2 Touch & responsive
**Files:** create `src/input/touch.ts`, touch CSS; portrait HUD layout. Test `tests/input/touch.test.ts` (virtual stick vector→4-way latch; fire button; only on touch devices flag).
**Spec:** GDD §7; art §10 portrait. **Commit:** `feat(input): touch controls with responsive layouts`

### - [ ] T9.3 PWA & build
**Files:** modify `vite.config.ts` (vite-plugin-pwa precache-all, manifest), create `scripts/gen-icons.ts` (renders icon SVG → PNGs via Playwright screenshot), `public/` icons. Test: `npm run build` + `npm run preview` + e2e against preview; offline reload works (Playwright offline context).
**Spec:** arch §10; GDD §3. **Commit:** `feat(app): installable offline PWA`
**⛔ Gate G4** — owner tests on phone + gamepad.

## Phase 10 — QA, calibration, release (Lane main)

### - [ ] T10.1 Performance pass
Measure against arch §11 budgets on dev machine + throttled CPU (Playwright CDP 4× throttle): fix violations (pool audits, draw-call counts via renderer.info snapshot test ≤120, sim perf test tightened to spec 2ms/step equivalent). **Commit:** `perf: meet frame/step/draw budgets`

### - [ ] T10.2 Calibration session (owner + orchestrator)
Execute fidelity §16 protocol with the owner running the NES reference (Mesen2): update each `[CAL-nn]` constant + fidelity doc + affected test expectations; re-record golden replays in the same commit batch. AI `[FEEL]` A/B tuning per §16.5. **Commit:** `fix(core): calibrated CAL constants against NES reference`

### - [ ] T10.3 Accessibility & E2E hardening
Verify GDD §10 + art §11: reduced-motion path, high-contrast toggle, colorblind silhouette review, HUD contrast ≥4.5:1 (automated check on palette), remap flow; extend e2e: 2P start, editor create→share→import→play, pause/resume, game-over→hi-score entry. **Commit:** `test: e2e hardening + accessibility pass`

### - [ ] T10.4 Release 1.0
`npm version 1.0.0`; README gameplay/screenshots/controls section; final `npm run check` + e2e + manual playtest checklist (orchestrator-authored, owner-executed); tag `v1.0.0`. Deployment target decided with owner (static host / GitHub Pages / itch.io — needs owner input). **Commit:** `chore: release 1.0.0`
**⛔ Gate G5** — ship.

---

## Verification summary

- Parity P-01…P-26 mapped: P-01/09→T1.2 · P-02/04/05/06/07/08/10/22/24→T1.3 · P-11/12/25→T1.4 · P-13–18→T1.5 · P-03/19/20/21/26→T1.7 · P-23→T1.8 (meta-test in T1.8 asserts coverage).
- Golden replays guard behavior from G1 onward; re-recorded only in T10.2 (calibration) with orchestrator approval.
- Every phase gate includes: full `npm run check`, e2e where present, and orchestrator review; G2/G3/G4/G5 add owner playtests.
