# Battle City Remake — Execution Status & Resume Protocol

**Doc:** 07 · **Snapshot:** 2026-07-21, session paused by owner · **Branch:** `dev` (all work; `main` advances only at gates)

This is the committed snapshot of the multi-agent execution state. The live ledger is `.superpowers/sdd/progress.md` (git-ignored, local working tree only) — when the two disagree, trust this doc + `git log`.

## 1. Method (running contract)

- Orchestrator: Claude Fable 5 — briefs, reviews, rulings, integration. Executors and task reviewers: **Claude Opus 4.8** subagents, **strictly one at a time** (owner mandate — no parallelism).
- Per task: brief file → implementer (TDD red→green, single commit + Opus trailer) → review package (`review-package BASE HEAD`) → task reviewer (spec + quality verdicts) → controller resolves ⚠️ items (commit trailer via `git log`, etc.) → fix + re-review loop if needed → ledger entry.
- Workflow per `docs/06-implementation-plan.md` §1; briefs/reports/diffs live in `.superpowers/sdd/` (git-ignored; briefs are regenerable from the plan's task blocks + Contract Zero).

## 2. Completed (all task-reviewed, verdicts clean)

| Task | Commits | Outcome |
|---|---|---|
| T0.1 scaffold | `dab196d..8ab1e4c` | Toolchain; three `0.185.1` exact; TS `~6.0.3` (typescript-eslint cap); ESLint 10 core-boundary rules (`regex: '^[^.]'`) |
| T0.2 kernel | `8ab1e4c..86641ca` | Contract Zero verbatim; mulberry32; grid math; `snap8` = nearest-8 **half-up** |
| T1.1 levels/skeleton | `0e7efc5..03ece71` | Schema validation (all-errors), terrain 676 subcells, 9-system pipeline order, FNV-1a `hashState` |
| T1.2 movement | `03ece71..b133a15` | Turn snap (P-01), flush blocking, ice slide with momentum (P-09), `makeTank`/`moveTank` |
| T1.3 combat | `e1e9e88..3f6cb70` | Full §5.2 interaction matrix, subcell brick/steel damage, press-edge firing; incl. review fix `3f6cb70` (struck-subcell tile rule) |
| T1.4 spawner | `3f6cb70..59af96c` | Cadence formula (t=0 start, L→C→R, retry-on-block), carriers 4/11/18, cap 4, clock-freeze read (P-11/12/25) |

Also on `dev`: CI/Pages commit `e1e9e88` and interleaved docs commits. **113 unit tests green** at `59af96c` (`npm run check`).

## 3. Next on resume (in order)

1. **T1.5 power-ups** — brief ready: `.superpowers/sdd/briefs/task-T1.5-brief.md` (BASE for review: `59af96c`).
2. **T1.6 enemy AI** — brief ready: `task-T1.6-brief.md` (adds `Tank.aiTimerT` + `probeMove`).
3. **T1.7 players/scoring/stage flow** and **T1.8 integration + golden replays** — briefs to be written from plan blocks (patterns: see the T1.2–T1.6 briefs).
4. **Gate G1**: full parity suite + replays + sim-perf check, then owner review; merge `dev → main`.

If a brief file is missing, regenerate it from the plan's task block + Contract Zero + Global Constraints (the existing briefs show the format).

## 4. Controller rulings log (binding, chronological)

1. `eagleAlive` is unconditional — `noAutoBase` only skips ring stamping (T1.1).
2. `snap8`: nearest multiple of 8, **half rounds up**, clamp ≥ 0; exact-half tie-break is calibration-grade (T0.2).
3. `nextInt` uniformity test: 10k draws ±5% (4k was ~1.8σ, statistically unsound) (T0.2).
4. Stun and freeze **cancel ice slide** (`sliding=false, slideV=0`) (T1.2 review question; implemented for stun in T1.3, for clock in T1.5 brief).
5. Core fires on **press edge**; hold-to-autofire is an input-layer turbo pulse (fidelity §5.1 amended; `Tank.fireHeld`).
6. Damaged tile derives **fully from the struck subcell**; straddle tie → lower-coordinate tile (fidelity §6.1 amended; fix `3f6cb70`).
7. Spawner timer comparisons use `<= HALF_TICK` (float-drift compensation → exact tick cadence); `timerT` may drift negative after queue exhaustion (T1.4).
8. Bullet/tank pool slots are reused; `id` = slot index (deterministic reuse).

## 5. Contract Zero amendments (already in plan §2)

`Tank.slideV` (hashed after `sliding`) · `Tank.fireHeld` (hashed after `bulletsAirborne`) · `Tank.aiTimerT` (T1.6, hashed after `fireHeld`) · `LevelData` type lives in `core/types.ts` (schema.ts re-exports + validates).

## 6. Minor findings triage (for the final whole-branch review before release)

- T0.1: no `engines` field; `reuseExistingServer` unconditional (revisit when CI runs e2e); `.prettierignore` covers all of `docs/`.
- T0.2: wrong intermediate std-err figure in an rng test comment (conclusion correct).
- T1.1: redundant char errors on wrong-length rows; `author` not type-checked; hash uses big-endian f64 (internal-only).
- T1.2: brick flush test missing its P-09 tag.
- T1.3: player↔player bullet cancel untested; enemy-bullet-vs-player lacks an `hpLeft>0` branch (inert while players are hp 1); subcell-scan DRY note (deliberate house pattern).
- T1.4: bare `1` for non-armor hp (vs `ARMOR_HP`); 186-interval cadence test lacks the tick-186 lower-boundary assert.

## 7. Infrastructure

- GitHub: `tarikdsm/Battle_City_Clone` (public), remote `origin`, branches `main`, `dev`.
- Live build: <https://tarikdsm.github.io/Battle_City_Clone/> — `.github/workflows/deploy.yml` deploys on every push to `dev`/`main`; build gate = `npm run check`; Pages base path = `/Battle_City_Clone/` via `vite build --mode pages`; `github-pages` environment allows `dev` and `main`. **T9.3 (PWA) must respect the base path.**
- Local Node v25 / npm 11; CI Node 22.

## 8. Resume protocol

1. `git checkout dev && git pull` · confirm HEAD matches §2's last commit (or later).
2. Read this doc + `.superpowers/sdd/progress.md` (if present) + plan §Execution status.
3. `npm run check` — must be green before dispatching anything.
4. Continue superpowers subagent-driven-development at §3's next task: dispatch the Opus 4.8 implementer with the existing brief, then task-review, one agent at a time.
5. Keep this doc + the plan's checkboxes updated at every task completion; commit docs updates with the task merges.
