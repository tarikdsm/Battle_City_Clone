# Battle City Remake — Execution Status & Resume Protocol

**Doc:** 07 · **Snapshot:** 2026-07-22 · **Branch:** `dev` · **Milestone: Phase 1 complete — Gate G1 open for owner review**

Committed snapshot of the multi-agent execution state. The live ledger is `.superpowers/sdd/progress.md` (git-ignored, local); when the two disagree, trust this doc + `git log`.

## 1. Method (running contract)

- Orchestrator: Claude Fable 5 — briefs, reviews, rulings, integration. Executors and task reviewers: **Claude Opus 4.8**, **strictly one at a time** (owner mandate — no parallelism).
- Per task: brief → implementer (TDD red→green, single commit + Opus trailer) → review package → task reviewer (spec + quality verdicts) → controller resolves ⚠️ items → fix/re-review loop → ledger entry.
- Briefs/reports/diffs live in `.superpowers/sdd/` (git-ignored; briefs are regenerable from the plan's task blocks + Contract Zero).

## 2. Completed — Phases 0 and 1 (every task review-gated)

| Task | Commits | Outcome |
|---|---|---|
| T0.1 scaffold | `dab196d..8ab1e4c` | Toolchain; `three` 0.185.1 exact; ESLint core-boundary rules |
| T0.2 kernel | `8ab1e4c..86641ca` | Contract Zero verbatim; mulberry32; grid math; `snap8` half-up |
| T1.1 levels/skeleton | `0e7efc5..03ece71` | Schema validation, 676-subcell terrain, 9-system pipeline, FNV-1a `hashState` |
| T1.2 movement | `03ece71..b133a15` | Turn snap (P-01), flush blocking, ice slide (P-09) |
| T1.3 combat | `e1e9e88..3f6cb70` | Full §5.2 matrix, subcell damage, press-edge firing; + struck-subcell tile fix |
| T1.4 spawner | `3f6cb70..59af96c` | Cadence formula, carriers 4/11/18, cap 4 (P-11/12/25) |
| T1.5 power-ups | `2a9bab2..dc771fb` | Six power-ups + effect timers (P-13…P-18); rng draw order pinned |
| T1.6 enemy AI | `17c6534..d579f78` | Deterministic §9 AI; `probeMove`; prev/AI-memory split |
| T1.7 players/flow | `d579f78..f3159eb` | Lives, scoring, 2P, phases, pause (P-03/19/20/21/26) |
| T1.8 integration | `2dd6b5e..9d5e2d9` | Golden replays (P-23), parity meta-test, tsconfig containment, winlose coverage |

Plus controller commits (docs, CI/Pages, formatting gate).

## 3. Gate G1 evidence

- **211 tests green** (`npm run check` = typecheck ×2 programs + lint + prettier + tests).
- **Parity P-01…P-26**: every ID covered, enforced by `tests/core/parity-coverage.test.ts`, which fails naming missing IDs. Full ID → file:line table in `.superpowers/sdd/task-T1.8-report.md`.
- **Three golden replays** (`tests/replays/`), re-recordable byte-identically via `npm run replays:record`; each asserted to stay in live play with enemy-kill floors and named-event requirements.
- **Performance**: 1800 ticks in 3.80 ms median = **2.11 µs/step** vs the 2 ms/step budget (~950× headroom).
- Reviewer independently replayed all three fixtures and reproduced every hash and stat.

## 4. Controller rulings log (binding, chronological)

1. `eagleAlive` unconditional — `noAutoBase` only skips ring stamping (T1.1).
2. `snap8`: nearest multiple of 8, half rounds up, clamp ≥ 0 (T0.2).
3. `nextInt` uniformity: 10k draws ±5% (4k was ~1.8σ) (T0.2).
4. Stun and freeze cancel ice slide (T1.2/T1.3/T1.5).
5. Core fires on **press edge**; hold-to-autofire is an input-layer turbo (fidelity §5.1; `Tank.fireHeld`).
6. Damaged tile derives **fully from the struck subcell**; straddle → lower coordinate (fidelity §6.1).
7. Countdown timers snap to 0 within `HALF_TICK`; count-up phase boundaries use the mirror `t + HALF_TICK >= limit` (fidelity §1). `aiTimerT` is exempt — it is never tick-quantized.
8. Pool slots reused; `id` = slot index.
9. Grenade-killed carriers drop nothing (fidelity §8).
10. `prevX/prevY` are **render-only, never hashed**; AI look-back is `aiTileX/aiTileY`, **hashed**. Invariant: any tick that advances `tick` leaves prev at that tick's start position, including a tick that runs no systems.
11. Intent gating is decided once per tick from the phase the tick began in; pause detection always uses the real intents.
12. `npm run check` includes `prettier --check` (format drift found in 6 files, 2026-07-22).
13. Node typings are contained by a two-program tsconfig split — `src` compiles with `types: []`; tests/scripts/tool-configs compile separately. **Never merge the programs back**: a tool config in the `src` include list re-opens the boundary through transitive triple-slash references.

## 5. Contract Zero (as built)

`Tank`: + `slideV` (hashed after `sliding`), `fireHeld` (after `bulletsAirborne`), `aiTimerT` (after `fireHeld`), `aiTileX`/`aiTileY` (after `aiTimerT`).
`GameState`: + `pauseHeld` (hashed after `paused`), `respawnT` (after the players block). `LevelData` lives in `core/types.ts`; `levels/schema.ts` re-exports and validates.
Presentation handoff is **`state.events`** (cleared at the top of every tick) — there is no `effectsQueue`.

## 6. Residual risk carried into Phase 2 (from the G1 review)

Read before writing the T2.x briefs:

1. **Event payloads are unpinned at integration level.** Golden replays record event *discriminators* only, so a regression in e.g. a `brickHit`'s `tx/ty` or a `scoreAwarded`'s `x/y` passes the replays unless it also moves hashed state. Per-system unit tests do cover payloads — but a render task wiring effects to coordinates is exactly what would expose the gap.
2. **Seven `GameEvent` variants never occur in any fixture**: `tierChanged`, `grenadeUsed`, `extraLife`, `iceSkidStarted`, `baseDestroyed`, `stageCleared`, `gameOver`. VFX/audio work cannot hang an integration test on them — use unit tests or record a fourth fixture.
3. **No fixture reaches a terminal phase**, so UI work against `cleared`/`gameOver`/`baseLost` rests on `stageflow.test.ts` and `winlose.test.ts`.
4. **Editor ergonomics under the tsconfig split**: files under `tests/` fall outside the root config's include. `npm run check` is the contract and is unaffected — do not "fix" this by merging the programs (ruling 13).
5. Not a risk: the render interpolation contract — `prevX/prevY` carries 46 assertions across 7 test files despite being unhashed.

## 7. Minor findings triage (for the final whole-branch review before release)

T0.1: no `engines` field; `reuseExistingServer` unconditional; `.prettierignore` covers all of `docs/`. · T0.2: wrong intermediate std-err figure in an rng test comment. · T1.1: redundant char errors on wrong-length rows; `author` not type-checked; big-endian f64 in hash (internal-only). · T1.2: brick flush test missing its P-09 tag. · T1.3: player↔player bullet cancel untested; enemy-bullet-vs-player lacks an `hpLeft>0` branch (inert). · T1.4: bare `1` for non-armor hp; cadence test missing the tick-186 lower bound. · T1.5: stale "two scratch AABBs" header comment; `stampBaseRing` couples pipeline #1 to #7; landed as 2 commits. · T1.6: golden-attribution harness now redundant with the direct check. · T1.7: `nextBonusAt: 0` for inactive slots makes the `!active` guard load-bearing. · T1.8: `minPowerupsCollected` floor has no headroom (comment overstates); `IDLE` is an exported mutable singleton; `applyRowsFor` trusts fixture well-formedness.

## 8. Infrastructure

- GitHub: `tarikdsm/Battle_City_Clone` (public), remote `origin`, branches `main`, `dev`.
- Live build: <https://tarikdsm.github.io/Battle_City_Clone/> — deploys on every push to `dev`/`main`; build gate is `npm run check`; Pages base path `/Battle_City_Clone/` via `vite build --mode pages`. **T9.3 (PWA) must respect the base path.**
- Local Node v25 / npm 11; CI Node 22.

## 9. Resume protocol

1. `git checkout dev && git pull`; confirm HEAD matches §2's last commit or later.
2. Read this doc + the plan's Execution status block.
3. `npm run check` — must be green before dispatching anything.
4. Continue superpowers subagent-driven-development at the next unchecked task in the plan, **one agent at a time**.
5. Update this doc and the plan's checkboxes at every task completion.
