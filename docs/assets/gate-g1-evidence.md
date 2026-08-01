# Task T1.8 report — Integration: system order, golden replays, perf

**Status:** DONE_WITH_CONCERNS (concerns are findings to note, not blockers)
**Commit:** `2dd6b5e` — `feat(core): integrated step order + golden replays (P-23) — core complete`
**Branch:** `dev` (not pushed). `.github/` untouched. `src/core/**` untouched.
**Suite:** 202 tests / 15 files, all green. `npm run check` green (typecheck + lint + prettier + tests).

---

## 1. Pipeline audit — no drift, no hash changed

`stepGame` was read line by line against architecture §3.2 and against what T1.1–T1.7
established. Everything the brief asked me to confirm is already true:

| Check | Result |
|---|---|
| Nine systems, in order stageflow → spawner → ai → movement → firing → bullets → powerups → players → winlose | ✅ `src/core/game.ts:171-179`, exactly that order |
| `state.events` cleared at the top of the tick | ✅ `game.ts:112`, first statement |
| Pause resolved from the REAL intents, before anything else | ✅ `game.ts:119-127` |
| Paused tick advances nothing (`tick++`, systems and prev-snapshot all skipped) | ✅ early-out at `game.ts:135`, ahead of both |
| `tick++` then the unconditional prev-snapshot pass, then systems | ✅ `game.ts:137-169` |
| Intent gating decided once per tick from the phase the tick began in | ✅ `game.ts:146` |
| Leftover no-op indirection to remove | none found — all nine systems have real bodies; `systems/index.ts` is a documented re-export barrel, not a stub layer |

**`src/core/game.ts` was therefore not modified, and no recorded hash moved.** The brief
listed it under "Files: Modify"; the honest outcome of the audit is that there was
nothing to fix, so I left it alone rather than manufacture a diff.

### One deviation from the literal wording of §3.2 — pre-existing, deliberately NOT changed

Architecture §3.2 reads `3. AI decisions → enemy intents` / `4. tank movement (players
then enemies, index order)`. The implementation splits it differently: `aiSystem`
(#3) moves the enemies itself through `movement.ts`'s `moveTank`, and `movementSystem`
(#4) moves only the players. This is a T1.6 decision, documented in three places
(`src/core/systems/ai.ts:18-21`, `movement.ts:6-8`, `systems/index.ts:15-23`) and load-bearing
for the rng draw order that every existing seeded test pins.

I did not touch it. Bringing the code to the literal §3.2 wording would move enemy
movement one system later and change the rng stream, i.e. rewrite every golden — a
hash change, which per your instruction needs your sign-off, not a silent re-record.
My recommendation was to amend §3.2 rather than change the code.

**Resolved.** The drift was real — `docs/02-architecture.md` §3.2 did read
`3. AI decisions → enemy intents` / `4. tank movement (players then enemies, index
order)` at the time this task ran. The orchestrator amended the doc after reading this
report (while the review was in flight), so §3.2 now documents the AI-moves-enemies
split. Recorded here rather than struck out: the finding was valid, the code was
correctly left alone, and the fix landed on the doc side.

---

## 2. TDD evidence

1. `tests/core/replay.test.ts` and `tests/core/parity-coverage.test.ts` were written
   **before** any fixture or generator existed.
2. First run: `replay.test.ts` failed as intended —
   `Error: ENOENT: no such file or directory, open '…\tests\replays\replay1.json'`
   (suite-level failure at `loadFixture`).
3. `parity-coverage.test.ts` passed on its first run, because T1.1–T1.7 had already
   tagged all 26 invariants in their titles. A test that can only pass is not evidence,
   so I verified the failure path directly: temporarily setting `LAST_PARITY_ID = 28`
   produced

   > `AssertionError: parity invariants with no tagged test: P-27, P-28 — add a test, or tag the existing one; do not relax this checklist.: expected [ 'P-27', 'P-28' ] to deeply equal []`

   i.e. the missing ids are named explicitly. Reverted immediately.
4. Generator built, fixtures recorded, both tests green (21 tests across the two files).
5. **The net was then proven to bite.** I mutated the pipeline order in `game.ts` and
   re-ran `replay.test.ts`, restoring `game.ts` after each:

   | Mutation | Result |
   |---|---|
   | swap #7 `powerupsSystem` ↔ #8 `playersSystem` | **6 failures** — all three hashes + all three event-order checks |
   | swap #4 `movementSystem` ↔ #5 `firingSystem` | **8 failures** — hashes, event order, and the non-triviality floor |
   | swap #8 `playersSystem` ↔ #9 `winloseSystem` | **not caught** — see Concerns |

   `git diff src/core/game.ts` clean afterwards; `git diff HEAD~1 HEAD -- src/` on the
   committed tree is empty, i.e. `src/` is byte-identical to the parent commit `f3159eb`.

---

## 3. Fixture summary stats

All three fixtures end in phase **`playing`** — deliberately inside live play, so none of
them degenerates into simulating a finished game while still hashing consistently.

| | replay1 | replay2 | replay3 |
|---|---|---|---|
| level | `test-basic` | `test-mixed` | `test-open` |
| players / stage / seed | 1 / 16 / 18 | 2 / 3 / 15 | 1 / 8 / 4 |
| spawn cadence (P-25 formula) | 126 ticks | 158 ticks | 138 ticks |
| `stepGame` calls | 1800 | 1800 | 2700 |
| final `state.tick` | 1800 | **1739** (61-call pause stall) | 2700 |
| final phase | playing | playing | playing |
| **events** | **288** | **481** | **621** |
| **distinct event types** | **14** | **17** | **15** |
| **enemies destroyed** | **6** | **10** | **9** |
| **power-ups dropped / collected** | **1 / 1** | **2 / 1** | **2 / 2** |
| terrain hits (brick + steel) | 56 | 57 | 66 |
| player deaths / respawns | 2 | 1 | 1 |
| intent rows (sparse) | 851 | 1525 | 1298 |
| recorded hash | 3044664431 | 281234597 | 824158851 |

Per-fixture event breakdown (what each one actually exercises):

- **replay1** — `shotFired 128, bulletDespawned 60, steelHit 48, enemySpawnStarted 10,
  enemySpawned 10, brickHit 8, tankDestroyed 8, scoreAwarded 7, shovelPhase 2,
  playerSpawned 2, treeEntered 2, powerupSpawned 1, powerupCollected 1, bulletsCanceled 1`.
  The collected drop was a **shovel**, so the run also walks the whole
  steel → blink → revert state machine (P-16) end to end at integration level.
- **replay2** — `shotFired 217, bulletDespawned 108, brickHit 37, playerStunned 33,
  steelHit 20, enemySpawnStarted 12, enemySpawned 11, tankDestroyed 11, scoreAwarded 11,
  treeEntered 8, tankHit 5, pauseToggled 2, powerupSpawned 2, playerSpawned 1,
  bulletsCanceled 1, powerupCollected 1, shovelPhase 1`.
  **33 friendly-fire stuns** (P-08 in 2P), **5 `tankHit`** (the armor enemies in the
  mixed queue soaking hits), and the scripted pause.
- **replay3** — `shotFired 291, bulletDespawned 206, steelHit 55, enemySpawnStarted 13,
  enemySpawned 13, brickHit 11, scoreAwarded 11, tankDestroyed 10, bulletsCanceled 3,
  powerupSpawned 2, powerupCollected 2, clockStarted 1, clockEnded 1, playerSpawned 1,
  shovelPhase 1`.
  13 spawns means **both carrier ordinals 4 and 11** landed inside the run, both were shot,
  both dropped, and the lawnmower route collected **both**.

Union across the three fixtures: **19 of the 25 `GameEvent` variants**. The six never
reached are `tierChanged`, `grenadeUsed`, `extraLife`, `iceSkidStarted`, `baseDestroyed`,
`stageCleared`, `gameOver` — the last three by design (the fixtures stay inside live
play), the first three because the random drop types happened to be shovel/clock rather
than star/grenade/tank. All six are covered by dedicated unit tests.

### How the scenarios were designed

Every constraint the brief warned about is honoured explicitly:

- **Intents dead until tick 121.** `CONTROL_FROM = 121` in the generator; nothing is
  scripted before it, and the constant carries the reason. (Tick 120 lifts the curtain
  but the gating decision for that tick was already made — control resumes on 121.)
- **The simulation keeps running past game over.** Rather than trust that, the recorder
  prints the final phase, and seeds/stages were chosen so all three end in `playing`.
- **Paused ticks stall the counter.** replay2 presses pause on call 700 and again on 761;
  calls 700…760 are frozen (the toggling call itself returns early), so `state.tick`
  lands on 1739 — asserted as `ticks - 61`, not glossed over.
- **Scripts must not idle.** replay1 patrols the brick diamond, replay2 runs two
  independent patrols with offset fire, replay3 mows the field. Fire is a 4-tick turbo
  pulse (edge-triggered; over-cap presses are free no-ops, so the tank shoots exactly as
  fast as its bullets clear).
- **replay3 collects drops by construction, not by luck.** Its route uses full-width
  horizontal legs separated by 30 u vertical steps — under the 32 u band in which a 16 u
  tank overlaps a 16 u power-up — so consecutive passes leave no gap and a full cycle
  sweeps the reachable field.

Seeds and stage numbers were **chosen, not arbitrary**: I swept seed × stage × route
offline (throwaway script, not committed) and kept combinations that stay in live play
for the whole recording while producing kills, drops and terrain damage. The three stage
numbers differ on purpose so the set covers three different P-25 cadences. This is
recorded in the generator's comments so a future re-record knows the constraints.

### Non-triviality is enforced, not just described

`replay.test.ts` asserts, per fixture: the brief's floor (≥200 events, ≥3 distinct types
beyond `shotFired`, ≥1 `tankDestroyed`), the exact tick count including the pause stall,
**and** the behaviour the fixture exists for:

- replay1 → `brickHit`, `tankDestroyed`, `enemySpawned`
- replay2 → `pauseToggled`, `playerStunned`, `tankDestroyed`, `brickHit`
- replay3 → `tankDestroyed`, `powerupSpawned`, `powerupCollected`, `scoreAwarded`

A re-record that quietly stopped producing friendly fire, or stopped collecting drops,
fails with the missing event kinds named — it does not silently become a hash of nothing.

---

## 4. Parity coverage table (Gate G1 evidence)

All 26 rows of fidelity spec §15 are covered by an **`it`-level** test whose title carries
the tag (not merely an enclosing `describe`). "Tags" counts every title in the suite
mentioning that id.

| ID | Test | Tags |
|---|---|---|
| P-01 | `tests/core/movement.test.ts:81` — *P-01: straight run advances 45 u/s and keeps dir/axis* | 6 |
| P-02 | `tests/core/bullets.test.ts:144` — *P-02: tier-0 bullet speed 120 and the four muzzle spawn positions* | 3 |
| P-03 | `tests/core/players.test.ts:232` — *P-03: a killed player loses a life and respawns at tier 0 with a fresh shield* | 3 |
| P-04 | `tests/core/bullets.test.ts:302` — *P-04: non-tier-3 removes the near half; two hits clear the tile* | 3 |
| P-05 | `tests/core/bullets.test.ts:327` — *P-05: a tier-3 bullet clears a full brick tile in one hit* | 3 |
| P-06 | `tests/core/bullets.test.ts:468` — *P-06: an enemy bullet passes through an enemy tank (no damage)* | 3 |
| P-07 | `tests/core/bullets.test.ts:439` — *P-07: a player and an enemy bullet annihilate head-on* | 2 |
| P-08 | `tests/core/bullets.test.ts:515` — *P-08: a player bullet stuns (not kills) the other player and cancels its slide* | 2 |
| P-09 | `tests/core/bullets.test.ts:746` — *P-09: a bullet crosses a water tile unharmed* | 9 |
| P-10 | `tests/core/bullets.test.ts:673` — *P-10: a player bullet destroys the base -> baseLost* | 3 |
| P-11 | `tests/core/spawner.test.ts:148` — *P-11: never more than ENEMY_CAP enemies active; a kill frees a slot* | 3 |
| P-12 | `tests/core/spawner.test.ts:78` — *P-12: first spawn starts at t=0 at the LEFT point* | 4 |
| P-13 | `tests/core/powerups.test.ts:218` — *P-13: an armor carrier drops on the FIRST hit and never again* | 5 |
| P-14 | `tests/core/powerups.test.ts:268` — *P-14: a second drop REPLACES the first — only ever one on the field* | 2 |
| P-15 | `tests/core/powerups.test.ts:457` — *P-15 star: tier climbs 0→1→2→3 and stays at 3* | 5 |
| P-16 | `tests/core/powerups.test.ts:590` — *P-16 shovel: repairs + steels the ring, blinks, then reverts to full brick* | 3 |
| P-17 | `tests/core/ai.test.ts:468` — *P-17: a frozen enemy draws nothing, moves nothing and pauses its timer* | 5 |
| P-18 | `tests/core/players.test.ts:364` — *P-18/P-19: grenade kills pay nothing and are left out of the tally* | 3 |
| P-19 | `tests/core/bullets.test.ts:553` — *P-19: an armor enemy takes four hits (three tankHit, then tankDestroyed 400)* | 7 |
| P-20 | `tests/core/players.test.ts:388` — *P-20: crossing 20,000 grants exactly one extra life, ever* | 2 |
| P-21 | `tests/core/players.test.ts:325` — *P-19/P-21: in 2P the kill pays the shooter only* | 4 |
| P-22 | `tests/core/bullets.test.ts:192` — *P-22: tier-0 cap — refused while airborne, allowed once freed* | 3 |
| P-23 | `tests/core/ai.test.ts:186` — *P-23: two runs of the same seed hash identically at ticks 200/400/600* | 14 |
| P-24 | `tests/core/bullets.test.ts:224` — *P-24: enemy cap is one; basic fires slow, power fires fast* | 2 |
| P-25 | `tests/core/spawner.test.ts:114` — *P-25: stage number caps at 35 in the interval (stage 99 → 50 ticks)* | 3 |
| P-26 | `tests/core/stageflow.test.ts:280` — *P-26: a paused tick advances nothing at all* | 5 |

New P-23 coverage added by this task: `tests/core/replay.test.ts:195` (per-fixture hash),
`:203` (event count + first-50 event order), `:255` and `:262` (fixture-independent
determinism: same seed twice ⇒ same hash; seed ± 1 ⇒ different hash).

**Title fixed rather than weakening the meta-test:** `tests/core/powerups.test.ts:495`
covered P-15's *Tank* clause (the sixth power-up type) but its title carried no tag,
while its siblings did (`P-15 star:`, `P-15 helmet:`). Retitled to `P-15 tank:`, so the
ledger's finest-grain evidence for P-15 now covers all six types. No other id was
missing, so no other title was touched.

The meta-test **excludes its own file** from the scan — a meta-test that could satisfy
the checklist by naming ids in its own titles would be circular evidence. It also
guards its own scan (`expect(TAGS.length).toBeGreaterThan(26)`, so a broken regex reads
as a broken scan rather than a suite-wide catastrophe) and rejects tags outside
P-01…P-26 (catches a typo'd id that would otherwise look like coverage).

---

## 5. Perf

Measured out-of-band (20 runs after a warm-up, `performance.now()`, Node via tsx, this
Windows box):

| | value |
|---|---|
| replay1, 1800 ticks | **median 3.80 ms** (min 3.21, max 11.12) |
| average per step | **2.11 µs/step** |
| spec target | ≤ 2 ms/step ⇒ ~3600 ms for this run |
| headroom | ≈ **950×** inside budget |

The committed assertion (`tests/core/replay.test.ts:274`) uses the brief's generous
1500 ms bound and prints nothing — it exists to catch an order-of-magnitude regression
(an accidental per-tick allocation storm, an O(n²) scan), not to benchmark CI hardware.
The whole 202-test suite runs in ~1.1 s.

---

## 6. Files changed

| File | |
|---|---|
| `scripts/record-replay.ts` | **new** — the recorder. Scenario table + script DSL (`patrol`/`firePulse`/`pausePress`), sparse-diff encoder, Prettier-formatted output. `npm run replays:record`. |
| `tests/core/replay.test.ts` | **new** — golden replay runner, per-fixture assertions, fixture-independent determinism pair, perf smoke. |
| `tests/core/parity-coverage.test.ts` | **new** — the P-01…P-26 meta-test. |
| `tests/replays/replay{1,2,3}.json` | **new** — the fixtures (917 / 1591 / 1364 lines). |
| `tests/fixtures/level-mixed.json` | **new** — all six terrain kinds, 5 partial tiles, 20-enemy queue with `armor` and `power`. |
| `tests/fixtures/level-open.json` | **new** — near-empty field for high enemy mobility. |
| `tests/core/powerups.test.ts` | 1 line — `P-15 tank:` title tag. |
| `package.json` | `replays:record` script; `@types/node` devDependency. |
| `package-lock.json` | the above. |
| `src/core/**` | **untouched** — audit found no drift. |

### `@types/node` — a dependency added beyond the brief's file list

The brief allows tests and scripts to use `fs`, but `tsconfig.json` sets `"types": []`
and no Node typings were installed, so `import { readFileSync } from 'node:fs'` failed
`tsc --noEmit` outright. I added `@types/node` as a devDependency and left
`"types": []` alone — the three files that need Node pull the typings in with an explicit
`/// <reference types="node" />` and a comment saying why. That keeps the tsconfig's
"no ambient globals by default" intent, and the core boundary stays enforced by ESLint's
`no-restricted-imports` (which already blocks every bare specifier inside `src/core`).
Flagging it because it is a dependency change, which normally warrants your sign-off.

---

## 7. Self-review findings

- **Do the fixtures exercise the game?** Yes, and the exercise is asserted rather than
  described: 6/10/9 enemies destroyed, 5 power-ups dropped and 4 collected, 179 terrain
  hits, 33 friendly-fire stuns, 4 player deaths and respawns, 19 of 25 event variants.
  All three end in `playing`.
- **Byte-stable generator?** Verified twice by md5 (record → hash → record → `md5sum -c`),
  including once through `npm run replays:record` after the last refactor. Determinism
  comes from the seeded rng; formatting stability from routing the JSON through Prettier's
  API with the repo's resolved config, so a re-record can never fail `prettier --check`.
- **Test output pristine?** Yes — no `console.log` anywhere in `tests/`, and the full
  run prints only vitest's own summary.
- **Formatting.** `prettier --check .` clean, including the ~3900 lines of generated JSON.
- **Fixture size.** 917/1591/1364 lines. The turbo fire cadence is what drives it (two
  rows per 4-tick pulse). I judged fidelity of the scenario worth the bytes; a slower
  cadence would have halved the files and roughly halved the events.

---

## 8. Concerns

1. **Pipeline order #8 ↔ #9 is not distinguished by the fixtures.** Swapping
   `playersSystem` and `winloseSystem` leaves all three replays green. That is inherent,
   not a fixture defect: the order only becomes observable on a tick that both awards
   score and ends the stage/run, and every fixture deliberately stays inside live play.
   The individual transitions *are* unit-tested (`tests/core/stageflow.test.ts:207` stage
   clear, `:237` base lost → game over), but the specific rule `winlose.ts` documents —
   "cleared is evaluated FIRST, so the shot that kills the twentieth enemy still clears
   the stage even when it was fired on a last life that runs out in the same tick" — has
   no test. **Suggest a small T1.9 / follow-up unit test for that same-tick collision.**
   I did not add it: there is no `tests/core/winlose.test.ts` at all, and creating one is
   a scope call for you, not for the integration task.
2. **Doc/code mismatch at architecture §3.2** (AI moves enemies; movement drives only
   players). Detailed in §1 above. Needs a decision at Gate G1 — my recommendation is to
   amend the doc, since changing the code rewrites every golden.
3. **`@types/node` devDependency** — see §6. Reversible, but it is a dependency change.
4. **Six `GameEvent` variants are unreached by any fixture** (`tierChanged`,
   `grenadeUsed`, `extraLife`, `iceSkidStarted`, plus the three terminal ones). The
   terminal three are deliberate. The other three depend on which power-up type the rng
   drops, which I did not want to seed-shop for at the cost of the other properties. All
   are unit-covered; noting it so the render/audio tasks know the replays will not
   produce a `grenadeUsed` or `iceSkidStarted` to hang an effect test on.
5. **The fixtures encode chosen seeds.** If T10.2 calibration changes a constant, the
   *outcomes* those seeds produce will change — the recorder will still emit a valid
   fixture, but the scenario may no longer stay in live play or hit its `requires` list.
   That is exactly what the per-fixture `requires` assertions are for: the re-record will
   fail loudly and the seeds will need re-sweeping. Worth knowing before T10.2 starts.

---

# Addendum — review fixes (commit `9d5e2d9`)

`test(core): assert fixtures stay in live play; contain node types; cover winlose precedence`

**Suite:** 211 tests / 16 files, all green. `npm run check` green. `src/` still byte-identical
to the parent commit; no recorded hash moved (all three fixtures re-recorded byte-identically
after the format refactor, which is the evidence the refactor was behaviour-preserving).

## 1. Fixtures are now asserted to stay inside live play

The gap was real: `state.phase` was never asserted, and every other per-fixture check is
cumulative over the whole run, so a re-record that reached game over at call 900 would have
passed on the events it emitted before dying. Added to each fixture:

- `expect(result.state.phase).toBe('playing')` — its own named test, so the failure reads as
  "this fixture stopped being a game", not as a hash mismatch.
- `enemyKills(events) >= 3`. Deliberately **not** `tankDestroyed`: that event is emitted for
  player deaths too, so the brief's floor is satisfied by a fixture in which only the player
  dies. Recorded values are 6 / 10 / 9.
- `powerupCollected >= 1` on all three (recorded 1 / 1 / 2), plus `powerupCollected` added to
  replay1's `requires`.

Floors carry headroom on purpose — a legitimate re-record may move the numbers; one that stops
fighting or stops collecting must not pass.

## 2. `@types/node` containment — my previous claim was wrong

The review is right and my §6 argument was incorrect. TypeScript global declarations are
program-wide, not file-scoped, so the triple-slash references did nothing to contain them:
`@types/node/globals.d.ts` was in the single program that also compiled `src`, and
`process.hrtime.bigint()` inside a core system would have passed both `tsc` and ESLint.

**Landed: the tsconfig split** (the "real containment" option), not the ESLint fallback — the
split closes the hole at its source rather than blacklisting five identifier names, and it did
not fight the toolchain.

| | |
|---|---|
| `tsconfig.json` | `include: ["src"]`, `types: []` — the gate |
| `tsconfig.node.json` | `extends` the above; `include: ["tests","e2e","scripts","vite.config.ts","playwright.config.ts"]`, `types: ["node"]` |
| `npm run typecheck` | `tsc -p tsconfig.json && tsc -p tsconfig.node.json` |

The three `/// <reference types="node" />` lines are removed — the split carries it now, and
leaving them would have re-opened the hole in any program that compiled those files.

**One non-obvious thing this surfaced, worth knowing:** the first attempt at the split still
leaked. `vite.config.ts` was in the app program, it imports `vitest/config`, and that package's
`.d.ts` carries its own `/// <reference types="node" />` — **a triple-slash reference inside a
dependency is followed even under `types: []`**. One tool config in the `src` include list was
enough to re-open the entire boundary. `vite.config.ts` therefore lives in the node program.

Verified two ways:

- `tsc -p tsconfig.json --listFiles | grep -c "@types/node"` -> **0** (was 82).
- Mutation: appending `export const LEAK = process.hrtime.bigint();` to `src/core/grid.ts` now
  fails `npm run typecheck` with
  `src/core/grid.ts(73,21): error TS2591: Cannot find name 'process'.` Restored; `src/` clean.

Cost: an editor opening a file under `tests/` no longer finds it in the root `tsconfig.json`'s
include list and falls back to inferred-project semantics for it. `npm run check` is unaffected
and is the contract. If that turns out to annoy anyone, the fix is a solution-style root with
`references`, which is a bigger change than this review warranted.

## 3. `tests/core/winlose.test.ts` — and the mutation result

Four tests, covering both sides of the same hole:

| Test | Pins |
|---|---|
| `the shot that kills the last enemy clears the stage on the very tick the run would end` | intra-winlose precedence: `stageCleared` is evaluated before `allPlayersOut` |
| `with the pool NOT spent, the identical frame is a game over instead` | the control — without it the first test also passes if winlose simply never reports a game over |
| `P-20: a bonus life earned by the killing shot saves the run on the same tick` | **#8 before #9** |
| `the last death still gets its full respawn second before the game ends` | §11.4's pending-respawn grace, which had no test |

All four are built from a player that has spent its last life plus an **orphaned airborne
player bullet** — a bullet outlives its shooter, which is what lets a dead player land a kill
on the tick the run would end. That is a reachable state, not a contrivance.

**Mutation result (asked for explicitly):** swapping `playersSystem` <-> `winloseSystem` in
`stepGame` makes exactly **one** test fail — `P-20: a bonus life earned by the killing shot
saves the run on the same tick`. The stage-clear precedence test does **not** fail under the
swap, and that is not a defect in it: `stageCleared` is evaluated first *inside* winlose
regardless of where winlose sits, so that test pins the intra-system order and nothing else.

The reviewer's suggested mechanism ("with winlose first, the last life has not yet been
decremented") turns out not to be observable, and the reason is worth recording because it says
something good about the design: on a death tick, `players` first leaves
`lives = L-1, respawnT = 1`, and `winlose` first sees `lives = L`. Both are read as "not out" —
`respawnT > 0` post-decrement is exactly the guard `lives > 0` provided pre-decrement, which is
the pending-respawn term doing its job. The two orders diverge only where `playersSystem` moves
a player from out to **not** out within a single tick, and the one path that does that is
`applyBonusLives`. Hence the bonus-life construction. Anyone tightening this later should know
the #8/#9 order is otherwise semantically inert — not that the test was aimed poorly.

Mutation harness restored after each run; `git status --porcelain src/` clean.

## 4. `tests/replays/format.ts` — one definition of the fixture format

Schema (`IntentRow`, `ReplayFixture`, `RunResult`), `IDLE`, `encodeIntents`, `replayIntents`
and `runReplay` now live in one module imported by both the recorder and the runner. Three
things bind the halves:

- the recorder's fixture literal is typed `ReplayFixture`, so a renamed field is a compile error;
- the recorder **records by replaying the rows it just encoded**, never by stepping the script
  directly — a fixture's `expected` therefore always describes what decoding those rows does;
- `replay.test.ts > replay fixture format` pins encode/decode as inverse over a 400-call script
  (every call compared, plus "sparse, not one row per call" and "no leading row while idle").

Evidence the refactor was behaviour-preserving: all three fixtures re-recorded **byte-identical**
(md5 verified) after the recorder switched from the script path to the encode-then-decode path.

## 5. Meta-test limitation documented

`describe.each(TABLE)('title ...')` is not matched by `TITLE_RE` — the table argument sits
between `.each` and the title, so the title is in a second call. Documented in the file,
including why it is safe (conservative: a tag can only be missed, never invented) and when to
widen it (if a `.each` block ever becomes the sole evidence for an invariant).

**Parity table correction.** The counts in the §4 table are counts of *matched* titles. P-23's
**14** does not include `replay.test.ts`'s `describe.each` suite title `golden replay $name
(P-23)`, which is invisible to the scan for the reason above; the four `it`-level P-23 tests
inside it are counted. Post-addendum, **P-20 is now 3** (was 2) — the new winlose test adds one.
Every other row is unchanged, and all 26 remain covered.

## 6. `firstEvents` scope documented

Noted on `ReplayFixture.expected.firstEvents` and at the assertion: it pins event **kind and
order only**. Payload fields — positions, ids, points — are not in it, so a regression inside
those first 50 events is invisible unless it also moves hashed state. A green `firstEvents`
means "same kinds in the same order", not "the first 50 events are correct".

## 7. Collection-time execution (noted, and taken)

Each fixture's replay moved from module scope into `beforeAll`, so a throw out of `stepGame`
reports as a failing hook on the named suite instead of a bare collection error. Still one run
per fixture. Four lines.

## Remaining concerns after the fixes

1. **Editor ergonomics for `tests/`** under the tsconfig split (§2 above). `npm run check` is
   unaffected.
2. **Six `GameEvent` variants unreached by any fixture** — unchanged from the original report
   (`tierChanged`, `grenadeUsed`, `extraLife`, `iceSkidStarted`, and the three terminal ones).
3. **T10.2 re-record risk** — unchanged, and now better guarded: the live-play and count-floor
   assertions mean a calibration change that pushes a fixture into a game over fails loudly
   instead of silently degrading, and the seeds get re-swept.
