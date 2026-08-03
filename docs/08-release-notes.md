# Battle City Remake — 1.0.0 release notes

**Doc:** 08 · **Released:** 2026-08-02 · **Audience:** players, and anyone deciding whether to trust this build

A faithful remake of Namco's **Battle City** (NES, 1985) for the browser: a deterministic simulation held to a written rule set, a 2.5D presentation built entirely from code, and the 35 original stages transcribed from the game's own data.

This document is deliberately blunt about what is verified, what is emulated, and what has never been tested at all. A remake that says "faithful" without saying *how it knows* is asking to be taken on trust, and this one would rather be checked.

---

## 1. What is in 1.0

| | |
|---|---|
| **Simulation** | A deterministic 60 Hz core with no dependencies, no DOM and no clock of its own. 26 NES-parity invariants (fidelity §15), each one an automated test. |
| **Stages** | The **35 original stages**, transcribed from the Battle City (J) ROM's own stage table — not redrawn from screenshots — plus the **12-stage authored Neo campaign**, with its own stage select and its own saved progress. |
| **Modes** | 1P and 2P local co-op, two campaigns each with its own stage select and progress, a map editor with share codes, local high scores. |
| **Presentation** | A calibrated 2.5D renderer: instanced geometry, a measured lighting rig, a post chain, camera FX, and a full synthesized soundtrack with adaptive layers. No image, audio or font asset is downloaded — every pixel and every sample is generated at run time. |
| **Platform** | An installable, offline-capable PWA. Keyboard, gamepad and touch input. |
| **Accessibility** | `prefers-reduced-motion` support, a required high-contrast mode, per-player key remapping, silhouette-distinct enemy types. |

---

## 2. The headline of this release: the calibration gap is closed

Through Phases 1–9 this project carried **eighteen `[CAL-nn]` constants** — movement speeds, effect durations, the spawn cadence, the power-up rules. Every one of them was reasoned from references rather than measured, and the plan said they could only be closed by a person running the ROM in an emulator with frame advance.

They were closed a different way. Phase 7 transcribed the 35 stages out of the public **Battle City (J) disassembly** (`cyneprepou4uk/NES-Games-Disassembly`, pinned at commit `57972cd`), and that same repository contains the game's *code*. So the constants were read out of the 6502 instead — which is better evidence than frame counting, because it is the stored number itself and anyone can check it from a public commit with no ROM and no emulator.

**Fifteen of the eighteen are now sourced to a specific address.** Ten of them moved, several substantially:

| Constant | Was | Now |
|---|---|---|
| Power enemy move speed | 45 u/s | **30 u/s** — only the *fast* tank moves every frame |
| Friendly-fire stun | 3.0 s | **4.45 s** |
| On-field enemy cap | 4 in 1P and 2P | **4 in 1P, 6 in 2P** |
| Spawn point cycle | left → centre → right | **centre → right → left** |
| Spawn animation | 1.3 s | **0.93 s** |
| Power-up drop position | any subcell slot | **one of sixteen fixed slots** |
| Power-up type | uniform over six | **weighted: star and grenade twice as likely** |
| Helmet / Clock | 10 s | **10.67 s** (they are counts of 64 frames, not seconds) |
| Shovel | 17 s + 3 s blink | **18.13 s + 3.2 s** |
| Spawn shield | 3.0 s | **3.2 s** |

Three were recovered and **deliberately not adopted**, each for a stated reason: the armor tank's damage tint (the NES strobes between two palettes every frame; our renderer has no NES palette), the ice slide's velocity profile (the NES coasts at full speed for a counted 28 pixels rather than decelerating — we adopted the distance, not the profile), and brick damage granularity (the NES destroys brick in 4×4-pixel quarters; our terrain grid's finest unit is 8×8, so we take an 8-pixel bite where the NES takes 4).

Full table, every address, and the reasoning for all three deviations: [fidelity spec §16](01-fidelity-spec.md).

**What this means for you as a player:** the game is meaningfully different from every earlier build. Enemies come from the centre first, the 2P board is more crowded, power-ups land on a grid, and every timer runs a little longer. If a previous build felt right and this one does not, the disassembly is the reason and it is checkable.

---

## 3. What is verified, and how

| Claim | How it is backed |
|---|---|
| The simulation obeys the written rules | 26 parity invariants, 1,111 unit tests, three golden replays (same seed + same input log ⇒ identical state hash) |
| The 35 stages are the originals | Regenerated on demand by `npm run levels:transcribe` from a pinned ROM disassembly commit, cross-checked against two independent reimplementations on every run |
| Both campaigns are reachable and chain | Played, not read: the keyboard walks the menu into each campaign's own stage select, clears a stage against the real AI, and asserts the *layout* the next stage served |
| The 18 calibration constants | Each cites the 6502 label or address it came from (fidelity §16) |
| The lighting and palette | Measured, not eyeballed: `docs/calibration/lighting.json` holds the probe values and their tolerances |
| High-contrast mode separates the tanks | Measured: worst luma pair goes from 2.62 to 59.98 (`docs/calibration/high-contrast.json`) |
| Frame budgets | Measured in the real play loop, on the real page, with the machine's own load index recorded next to the numbers: `docs/calibration/play.json` |
| The screens and flows work | 18 Playwright tests through the real UI with a real keyboard: boot, resize, touch layout, a played stage, a scripted 2P run, pause/resume, the editor's create → share → import → play round trip, game over → high scores, both Neo campaign walks, and the accessibility pass below |

---

## 4. What is NOT verified — read this part

Nothing below is a suspicion. Each line is something that was never tested, stated so you are not surprised by it.

### Hardware that does not exist here

- **No physical gamepad has ever been connected to this build.** Gamepad support is written against the W3C standard mapping and exercised through a fake `navigator.getGamepads()`. The wiring is proven end to end; the *mapping* — that button 9 is Start on your pad — is not. A pad reporting a non-standard mapping would produce wrong buttons and every test would still pass.
- **No real phone or tablet has ever run this build.** Touch controls, layout, and the auto-quality probe were verified against emulated device profiles and CDP CPU throttling. A throttle models a slower CPU; it does not model a phone's GPU or its thermals.
- **iOS and WebKit are entirely unverified.** Everything was run in Chromium. Safari's audio policies, its PWA behaviour and its WebGL differences are unknown territory for this build.
- **The app has never been installed to a phone's home screen.** "Installable" was verified as a desktop app window plus a real service-worker offline reload — not as an Add-to-Home-Screen launch.
- **The High preset does not hold 60 FPS on this machine's integrated GPU. Stated plainly, because it is the honest reading.** Every figure below is from the committed, certified artifact `docs/calibration/play.json`:

  | Preset | FPS | frame CPU (mean / p95) | draw calls | verdict |
  |---|---|---|---|---|
  | High | 26.2 | 4.27 / 6.1 ms | 41–49 | 60 not held |
  | Medium | 59.6 | 3.01 / 4.4 ms | 39–48 | on the line |
  | Low | **87.8** | 1.74 / 2.9 ms | 14–20 | **60 proven** |
  | Low, 4× CPU throttle | 50.8 | 14.09 / 24.1 ms | 14–20 | 60 not held under throttle |

  The conclusion is not "the machine was busy". Across roughly thirty capture runs spanning a whole session, High was **never once** observed above 31 FPS — while its frame CPU is 4.3 ms of a 16.7 ms budget, i.e. the code spends a quarter of the frame and then waits. The binding constraint is the GPU finishing the picture, and on an Intel UHD it does not finish it sixty times a second at this preset.
- **Every CPU-side budget is met with room, at every preset.** Sim step 0.15–0.18 ms mean and ≤ 0.7 ms at the 95th percentile against a 2 ms budget; render CPU 5.6 ms at the 95th percentile against 6 ms at High; 49 draw calls at worst against a bound of 60.
- **The frame rates are lower bounds, not exact figures.** The harness records a machine-speed index with every row and refuses to certify a run taken on a contended CPU — but that index cannot see a *shared GPU*, and this machine's is shared. So each FPS row is a floor: 87.8 at Low proves Low clears 60; 26.2 at High proves only that it was at least that. Read `machine.certified` and `machine.certifyNote` in the artifact before quoting any of it.
- **What this means for you:** leave quality on **Auto**. It samples the device actually drawing before it decides (arch §5), and on hardware like this it picks Low — which the same artifact shows running at 87.8 FPS. High is there for a machine with a discrete GPU, and nobody has run this on one.

### Accessibility, verified and not

Verified end to end in 1.0: HUD text contrast measured from the composited computed styles (every value ≥ 4.5:1), `prefers-reduced-motion` suppressing the stage fly-in from the OS preference through to the drawn frame, the high-contrast toggle persisting and round-tripping through a reload, and the full keyboard-remap flow.

Two links are pinned at the unit layer rather than end to end, and the reason is arithmetic: high contrast recolours tank skins, which during the stage curtain is one 16×16 tank in a 1461×900 buffer. Its measured effect on any whole-frame statistic (0.055 mean levels) is *smaller* than the frame-to-frame noise of the twinkling spawn star (0.074), so an end-to-end pixel test would pass or fail on the star rather than on the mode. Likewise "a rebound key drives the tank" would mean comparing two live frames of a board with moving tanks. Both are covered where they are deterministic; neither is claimed here.

Never checked by a human: whether the reduced-motion path *feels* calm, whether the high-contrast palette is comfortable to play in for an hour, and whether the game is usable with a screen reader — it is a canvas game with a DOM menu, the menu carries roles and `aria-current`, and nothing beyond that was tested.

### Content and features

- **The Neo campaign's difficulty has never been judged by a human.** Twelve stages that validate, clear and sit in the originals' late difficulty band are not twelve stages that are *fun*. Its first and last stages have been played end to end by a script; the ten in between have been played by nobody, in any sense.
- **No human has finished either campaign.** The originals' chain is proven stage 1 → 2, the Neo campaign's stage 1 → 2 and its ending at stage 12; the long middle of both is unwalked.
- **The music's three "faithful" pieces are motif-shaped, not transcribed.** The stage fanfare, the game-over sting and the pause chirp were composed to the right character, length and instrumentation — no note-level source for Junko Ozawa's originals could be verified, and inventing one and calling it fidelity was refused. The game-over sting falls in two voices and ends unresolved in the original's 3 seconds; the stage fanfare is 2.0 s against the original's ~5, because the stage curtain is 2 s and the fanfare has to land on the music's downbeat. If your ear says no, each piece is one array of notes in one file.
- **The enemy AI is a reconstruction, not the NES AI.** The disassembly *does* contain the original: enemies reconsider direction only on an 8-pixel lattice and only on a 1-in-16 roll, and they fire on a flat 1-in-32 per frame with no aiming at all. Ours is a weighted per-decision model with an alignment term. Adopting the ROM's would mean adopting its random generator and its frame-counter coupling, which is a different determinism model from this project's seeded one. Behaviourally equivalent is the claim; identical is not.
- **No blind A/B review against NES footage has been done.** The AI's feel was never held against the original by a person.

### Fidelity deviations that are known and deliberate

- **Brick damage is coarser than the NES.** Ours removes an 8-unit-deep bite; the NES removes 4. A brick tile therefore takes two hits to punch through where the original takes four.
- **The armor tank's damage tint does not strobe.** The NES alternates two sprite palettes every frame; this keeps a stable, readable colour per remaining hit point.
- **The ice slide decelerates.** The NES coasts at full speed for a counted number of steps and stops dead, and it re-arms that counter while you drive — so the coast you get on release is a remainder between 0 and 28 pixels. Ours always coasts the full 28, decelerating.
- **Only players slide on ice.** That is also what the NES does, and it is now a deliberate match rather than an accident.
- **The power-up pickup box is 16 units; the NES uses 12.** Untagged, pre-existing, unchanged in 1.0.

---

## 5. Known issues

- High preset below 60 FPS on integrated graphics (§4).
- Three shader compile warnings from three.js's own FXAA pass appear on Medium and Low in Chromium/ANGLE. They come from upstream, are recorded in `docs/calibration/play.json` under `shaderWarnings`, and do not affect the image.
- A rare, intermittent boot failure in the **headed screenshot harness** — not in the game. It fired once in fifteen consecutive headed capture runs and never in isolated ones: several headed browsers competing for one integrated GPU can lose a WebGL context, and the boot smoke test then sees the shader errors that follow. The same contention is why `playwright.config.ts` pins one worker. The test classifies what it caught and says so in its failure message, without excusing it.
- The player-count choice is per sitting, not persisted: reloading the page returns to one player.

---

## 6. Credits and provenance

Original game: **Battle City**, Namco, 1985. Music (original): Junko Ozawa.

This is an independent remake. It contains **no ROM data, no ripped graphics and no ripped audio** — the stage layouts are decoded at build time from a public disassembly's data tables by a committed script, and every visual and every sound is generated from code at run time.

Sources this build depends on, all pinned:

- [`cyneprepou4uk/NES-Games-Disassembly`](https://github.com/cyneprepou4uk/NES-Games-Disassembly) @ `57972cd` — the stage table and the 6502 the calibration constants were read from.
- [`krystiankaluzny/Tanks`](https://github.com/krystiankaluzny/Tanks) and [`feichao93/battle-city`](https://github.com/feichao93/battle-city) — two independent reimplementations, used only as cross-checks on the stage decode.

Built with TypeScript, Vite, Three.js and the Web Audio API. Runtime dependencies: **one** (three.js).
