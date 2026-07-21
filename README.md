# Battle City Remake

A faithful remake of Namco's **Battle City** (NES, 1985) for the modern web — identical gameplay, stunning 2.5D presentation. TypeScript + Three.js + WebAudio, 100% procedural assets, PWA/offline, 1P + 2P local co-op, the 35 original stages, a new 12-stage campaign, and a map editor.

**▶ Play the latest build:** <https://tarikdsm.github.io/Battle_City_Clone/> (auto-deployed from `dev`/`main` by GitHub Actions on every push — during development it reflects work in progress, not a finished game).

**Status:** in development — core simulation phase (see the [implementation plan](docs/06-implementation-plan.md)).

## Documentation

| Doc | Content |
|---|---|
| [00-game-design.md](docs/00-game-design.md) | Vision, pillars, modes, screens, controls, UX |
| [01-fidelity-spec.md](docs/01-fidelity-spec.md) | Exact NES rules — the source of truth for the simulation |
| [02-architecture.md](docs/02-architecture.md) | Stack, module boundaries, core sim, testing, budgets |
| [03-art-direction.md](docs/03-art-direction.md) | 2.5D look: camera, palette, models, lighting, VFX |
| [04-audio-direction.md](docs/04-audio-direction.md) | Synth engine, adaptive music, SFX recipes |
| [05-content-levels.md](docs/05-content-levels.md) | Level format, 35-stage transcription protocol, Neo Campaign |

## Method

Docs-first, spec-driven development, orchestrated multi-agent execution: an orchestrator (Claude Fable 5) owns specs, task breakdown, review, and integration; executor agents (Claude Opus 4.8) implement tasks under TDD against the fidelity spec's parity checklist.
