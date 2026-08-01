# Battle City Remake — Technical Architecture

**Doc:** 02 · **Status:** Approved design (2026-07-20) · **Audience:** all implementers

## 1. Stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict: true` | no `any` in `src/core` |
| Build/dev | Vite (latest stable at scaffold) | ESM, code-split editor route |
| Rendering | Three.js (latest stable at scaffold, pinned exact) | WebGL2; no other runtime deps |
| Audio | Web Audio API (no library) | all synthesized |
| Tests | Vitest (unit/core) + Playwright (E2E smoke) | |
| Lint/format | ESLint (flat config) + Prettier | import-boundary rules enforced |
| PWA | vite-plugin-pwa | precache all assets; offline-first |
| Package manager | npm | Node ≥ 20 |

Exact versions are pinned by the scaffold task and recorded in `package.json` (lockfile committed). No other runtime dependencies without orchestrator approval — the asset pipeline is code.

## 2. Module map & dependency rules

```
src/
  core/     pure deterministic simulation  — imports: NOTHING (not even three)
  levels/   level data (JSON/TS) + schema  — imports: core types only
  render/   Three.js presentation          — imports: core (read), levels
  audio/    WebAudio engine, songs, sfx    — imports: core events/types
  input/    keyboard/gamepad/touch drivers — imports: core intent types
  ui/       DOM HUD, menus, screens        — imports: core (read), app services
  editor/   construction mode              — imports: core, levels, render, ui
  app/      composition root, game loop, screen state machine, persistence
```

**Hard rules** (enforced via ESLint `no-restricted-imports` per directory):
- `core` imports nothing and touches no browser API (`window`, `document`, `performance`, `Math.random` are all forbidden — lint-banned identifiers).
- `render`/`audio`/`ui` **read** core state and **consume** core events; they never mutate simulation state.
- Only `app` (and `editor` for test-play) constructs and steps the simulation.

Everything in `core` runs headless under Vitest/Node — that is what makes agent TDD reliable.

## 3. Core simulation

### 3.1 Shape

Data-oriented and allocation-free in steady state:

```ts
interface GameState {
  tick: number;
  rng: RngState;                    // mulberry32 state
  stage: StageState;                // number, phase, timers
  terrain: TerrainGrid;             // 26×26 subcell typed array + tile metadata
  tanks: Tank[];                    // fixed-capacity pool (2 players + 4 enemies)
  bullets: Bullet[];                // fixed-capacity pool
  powerup: Powerup | null;
  players: PlayerMeta[2];           // lives, score, tier, counters
  spawner: SpawnerState;            // queue index, cycle pos, timers
  effectsQueue: GameEvent[];        // drained by presentation each frame
}
```

- `GameState` is a plain serializable object (structured-clone safe) → trivial save/replay/test snapshots.
- `step(state, intents: [PlayerIntent, PlayerIntent]) -> void` advances exactly one tick, mutating in place. `PlayerIntent = { dir: Dir | null, fire: boolean, pause: boolean }`.

### 3.2 System order (per tick — fixed, part of the spec)

Each tick, `stepGame` clears `events`, handles the pause edge (a paused tick returns before `tick++` and before the prev-snapshot, advancing nothing), increments `tick`, snapshots `prevX/prevY` for every tank (render-only, never hashed), gates intents to `NULL_INTENT` unless the phase is `'playing'`, then runs:

1. stage phase & timers (intro/clear/gameover, shovel, clock, shields, stun, player respawn)
2. spawner (enemy spawn starts/materializations)
3. AI decisions **and enemy movement** — the AI drives its own tanks via `moveTank`, because its lattice rule reads the pre-move position (see note below)
4. tank movement — **players only** (turn-snap; ice)
5. firing (spawn bullets; press-edge triggered)
6. bullet advance (swept) → collisions in order: bullet-vs-bullet, bullet-vs-tank, bullet-vs-terrain/eagle/border
7. power-up spawn/pickup
8. score/lives/bonus-life bookkeeping
9. win/lose evaluation

`GameEvent`s accumulate in `state.events` as systems run and are drained by presentation after the tick.

**Why the AI moves its own tanks (amended 2026-07-22, T1.6):** the §9 lattice rule reconsiders direction when a tank crosses a tile line *during the previous tick*, so it must read the pre-move position before moving. Enemy look-back therefore lives in dedicated hashed fields (`aiTileX/aiTileY`) written by the AI itself, while `prevX/prevY` stay render-only with a single unconditional snapshot per tick. Splitting the two concerns is what makes a future gating of `aiSystem` break golden replays instead of silently degrading enemy behavior.

### 3.3 Events (core → presentation)

`GameEvent` is a discriminated union: `shotFired, bulletHit, brickDestroyed, steelHit, steelDestroyed, tankDamaged, tankDestroyed, playerStunned, playerSpawned, enemySpawnStarted, enemySpawned, powerupSpawned, powerupCollected, shovelPhase, clockStarted/Ended, baseDestroyed, stageCleared, gameOver, scoreAwarded, extraLife, iceSkid…` — each with positions/ids/payloads. Render, audio, and UI subscribe; nothing flows back.

### 3.4 Fixed timestep loop (app layer)

Accumulator pattern: `dt` clamped at 250 ms (tab-switch safety), sim stepped at 60 Hz, render interpolates entity transforms between previous and current tick (`alpha`). Pause stops stepping entirely (fidelity §11).

### 3.5 Determinism & replay

- All randomness via `rng` (mulberry32) inside `core`.
- Replay record = `{ levelId, seed, intents per tick }`; golden-replay tests assert a stable hash of the final state (parity P-23).
- A tiny state-hash util (FNV-1a over a canonical serialization) ships in core for tests.

## 4. Data & persistence

### 4.1 Level data (v1)

See [05-content-levels.md](05-content-levels.md) for the authoring format and constraints. Runtime schema (`levels/schema.ts`) validates on load; invalid custom levels fail with a user-readable reason.

### 4.2 Save data (localStorage, versioned)

| Key | Content |
|---|---|
| `bc.save.v1` | campaign progress (highest stage), neo progress |
| `bc.scores.v1` | top-10 `{score, initials, stage}` |
| `bc.settings.v1` | volumes, quality, toggles, key bindings |
| `bc.customLevels.v1` | array of LevelData |

Unknown/corrupt payloads are discarded field-wise with defaults (never crash on parse).

## 5. Rendering (render/)

- **SceneRoot** builds: board, lights, camera rig (orthographic, tilt per art doc), post chain.
- **TerrainRenderer:** one `InstancedMesh` per terrain material (brick subcells, steel subcells, water tiles, tree canopies, ice decals); dirty-set updates on `brickDestroyed` etc. — no per-frame rebuilds.
- **Entity views:** pooled `TankView` (player/enemy variants assembled from shared geometries) and `BulletView`; positions read from sim with interpolation alpha; facing/track/turret animation driven by state deltas.
- **FxSystem:** pooled GPU-friendly particle batches (debris, sparks, smoke, rings) + pooled point lights (cap 8), consuming `GameEvent`s; budgets per art doc §8.
- **Post chain:** EffectComposer — Render → UnrealBloom → SMAA/FXAA → vignette/grade shader pass; assembled per quality preset (art doc §7). Renderer uses ACES tone mapping.
- **Camera FX:** trauma-based shake (art doc §2), stage fly-in, base-destruction slow-mo (presentation-side time dilation of *interpolation only* — simulation ticks are unaffected except the scripted lock in fidelity §11).
- **Resize/DPR:** letterboxed board + HUD dock; `devicePixelRatio` capped by preset (High 2, Med 1.5, Low 1).
- **Quality presets:** Low/Med/High + Auto (probe: DPR, `navigator.hardwareConcurrency`, 1-s FPS sample on title screen → pick preset; user override persists).

## 6. Audio (audio/)

- **Graph:** `master(limiter ← compressor)` ← `musicBus`, `sfxBus`; per-voice envelope gains. Context resumed on first user gesture (title interaction).
- **Sequencer:** lookahead scheduler (120 ms window, 25 ms timer) over note patterns `{bpm, ppq: 4, tracks: [{inst, steps: [tick, midi, dur, vel][]}], loopAtTick}`; supports layer gain automation for adaptive music (audio doc §4).
- **Instruments:** small patch registry (pulse/tri/noise/sub/pad/bell) built on OscillatorNode/AudioBufferSourceNode(noise) + BiquadFilter + Gain envelopes (audio doc §3).
- **SFX:** parametric one-shot patch functions with priority, polyphony caps, and a ducking matrix (audio doc §6).
- Subscribes to `GameEvent`s; music intensity recomputed on relevant events.

## 7. Input (input/)

- Uniform output: `PlayerIntent` per player per tick; sources merge with precedence (any active source wins; latest direction latched, dominant-axis rule).
- Keyboard: two default layouts (GDD §7), remappable, stored in settings.
- Gamepad: Standard Gamepad mapping, polled in the RAF loop, hot-plug assignment (first pad → first free player slot).
- Touch: DOM overlay (left virtual stick with 4-way latch + dead zone; right fire button); visible only on touch devices; portrait and landscape layouts.

## 8. UI & screens (ui/, app/)

- Screen state machine per GDD §5 (`Boot, Title, Menu, StageSelect, Intro, Play, Pause, Tally, GameOver, HiScore, Settings, Editor`).
- DOM overlay (semantic HTML + CSS custom properties; no framework). HUD updates are event-driven (no per-frame DOM writes except score tween).
- Menu navigation abstract: works with keyboard/gamepad/touch; focus ring per art doc.

## 9. Editor (editor/)

- Route `#editor` (code-split chunk). Tools: terrain brush (tile + subcell mode for brick/steel), eraser, eagle-ring toggle, enemy-wave editor (20 slots with type picker + carrier markers fixed at 4/11/18), metadata (name/author).
- Validation before save/play: schema-valid, spawn tiles & player tiles clear, eagle intact.
- **Test-play:** launches the standard game loop on the draft level in 1P; Esc returns to editing (draft kept).
- Persistence: save to `bc.customLevels.v1`; export/import as JSON file **and** share string `BC1.<base64url(JSON)>` with version prefix.

## 10. PWA & deploy

- vite-plugin-pwa: precache app shell + all built assets (fonts included); `standalone` display; offline works fully (no network calls at runtime at all).
- Static hosting compatible (any static server / GitHub Pages); no backend.

## 11. Performance budgets

| Budget | Target |
|---|---|
| Frame rate | 60 FPS sustained: desktop @High, mid-2020s mobile @Low |
| Sim step | ≤ 2 ms worst case (typically ≪ 1 ms) |
| Render CPU | ≤ 6 ms @High desktop; draw calls ≤ ~120 (instancing) |
| Steady-state allocations | zero in sim; near-zero in render (pools everywhere) |
| Bundle | ≤ 1.5 MB gzip total (three.js dominates); editor code-split |
| Load | interactive < 3 s on 4G mid-phone |

Perf instrumentation: dev overlay (FPS, sim ms, render ms, draw calls, pool usage) toggled with backtick key in dev builds.

## 12. Error handling & debug

- `core`: `devAssert()` invariant checks compiled out of production builds.
- App-level error screen (friendly, offers reload + copy-details) on uncaught errors; renderer context-loss recovery (rebuild scene from state).
- Debug flags via URL params (`?stage=n`, `?seed=n`, `?quality=low`, `?overlay=1`) — dev builds only.

## 13. Testing strategy & quality gates

| Layer | Tooling | What |
|---|---|---|
| Core unit | Vitest | every parity item P-01…P-26 (fidelity §15), collision edge cases, AI determinism |
| Golden replays | Vitest fixtures | scripted intent logs → final state hash; catches any behavioral drift |
| E2E smoke | Playwright (chromium) | boot → title → start stage 1 → simulate 10 s inputs → no console errors, canvas draws, HUD updates; editor open/paint/test-play |
| Static | `tsc --noEmit`, ESLint, Prettier check | on every task |

**Definition of Done for every implementation task:** tests written/updated and green, `tsc` clean, lint clean, no console errors in smoke run, budgets respected, docs updated if behavior/interface changed.

**Phase gates (orchestrator-reviewed):** all of the above plus golden replays stable and a manual playtest checklist for feel-affecting phases.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fidelity drift ("feels wrong") | parity tests + [CAL] calibration protocol + turn-snap/ice covered explicitly |
| Mobile performance | quality presets + Auto probe; particle/light budgets; instancing |
| Agent scope creep | docs are the contract; DoD per task; orchestrator review at every gate |
| Three.js API drift vs. training data | pin exact version at scaffold; consult bundled types/docs, not memory |
| WebAudio autoplay policies | gesture-gated context resume; UI communicates muted state |
