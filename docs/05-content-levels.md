# Battle City Remake — Content: Levels & Campaigns

**Doc:** 05 · **Status:** Approved design (2026-07-20) · **Audience:** content/transcription implementers, editor implementers

## 1. Level data format (v1)

```ts
interface LevelData {
  version: 1;
  id: string;              // "orig-01".."orig-35", "neo-01".."neo-12", "custom-<uuid>"
  name: string;            // "Stage 1", "First Frost", user text for customs
  author?: string;         // customs only
  terrain: string[];       // exactly 13 strings of exactly 13 chars (rows, top to bottom)
  partials?: { tx: number; ty: number; mask: number }[]; // subcell mask override
  enemies: EnemyType[];    // exactly 20 entries, spawn order; EnemyType = "basic"|"fast"|"power"|"armor"
  noAutoBase?: boolean;    // default false: eagle + brick ring auto-stamped (fidelity §2)
}
```

**Terrain characters:** `.` empty · `B` brick · `S` steel · `W` water · `T` trees · `I` ice.

- The eagle tile and base ring are auto-stamped over whatever the rows contain (unless `noAutoBase`, reserved for future use — v1 content never sets it).
- `partials` refine a tile to specific subcells: `mask` bits `1=TL, 2=TR, 4=BL, 8=BR` (only valid on `B`/`S` tiles). The NES originals use half-tiles extensively — transcriptions must reproduce them.
- Spawn tiles `(0,0) (6,0) (12,0)` and player tiles `(4,12) (8,12)` must be empty; validation enforces this (architecture §9).
- Carrier positions are **not** data: always the 4th/11th/18th spawn (fidelity §3.2).

Runtime validation errors are user-readable (editor imports).

## 2. Original campaign (35 stages)

### 2.1 Sources

Planned: original NES gameplay/stage references — GameFAQs complete guides ([brian_sulpher's walkthrough](https://gamefaqs.gamespot.com/nes/562966-battle-city/faqs/29287), [Shirow's FAQ](https://gamefaqs.gamespot.com/nes/562966-battle-city/faqs/15969)) and [StrategyWiki's Battle City pages](https://strategywiki.org/wiki/Battle_City), cross-checked against stage screenshots/longplay footage. The transcription task fetches and cites the exact source used per stage.

**Actually used (T7.1, 2026-08-02).** Those prose guides were not needed: the game's own stage table is available as data, which is a strictly better source than any description of it. All 35 stages are transcribed from the ROM, and the path is committed as `scripts/transcribe-original-stages.ts` (`npm run levels:transcribe`) rather than described, so the claim is reproducible.

| Role | Source | What it gave |
|---|---|---|
| Primary | [cyneprepou4uk/NES-Games-Disassembly](https://github.com/cyneprepou4uk/NES-Games-Disassembly/tree/main/Battle%20City), pinned at `57972cd` | `incbin/stages/stage_NN.bin` — 91 bytes per stage, one nibble per tile carrying kind **and** half-tile shape; `bank_FF.asm` tables `tbl_E4EC`/`tbl_E578` plus the spawn routine at `$E3CB` — the 20-tank wave and its order |
| Verifier | [krystiankaluzny/Tanks](https://github.com/krystiankaluzny/Tanks) `@f59aea3` | 26×26 ASCII grids (C++/SDL2). Agrees with the ROM on 99.56% of tiles |
| Verifier | [feichao93/battle-city](https://github.com/feichao93/battle-city) `@745c369` | 13×13 JSON with half-tile masks and per-stage bot lists (TypeScript/React). Agrees on 99.82% of tiles and on 33/35 waves |

The nibble→(kind, mask) table is not documented anywhere; it was derived by decoding all 35 stages and matching every tile against those two reimplementations, and the transcription script re-runs that comparison on every invocation. Where the three disagree the ROM wins — the other two are reimplementations, and both differ from each other as well.

Seven tiles across stages 5, 12, 15, 16 and 32 deviate from the ROM: the format requires the three enemy spawn tiles and the two player spawn tiles to be empty (§1) and the ROM does not. Each affected stage file records the deviation in a `notes` field.

Each stage file carries `provenance` (`"transcribed" | "reconstructed"`) and `source`. These are campaign bookkeeping, not part of `LevelData`, so `validateLevel` ignores them and user levels need not have them.

### 2.2 Transcription protocol (agent workflow)

1. **Transcriber** produces `terrain` rows + `partials` + the enemy composition for one stage from the references, and renders an ASCII preview (tooling script `scripts/level-preview.ts`, built in the content phase) side by side with the source description.
2. **Independent verifier** (separate agent, sees only the JSON + original reference, not the transcriber's notes) checks tile-by-tile and signs off or files a diff.
3. Acceptance checklist per stage: 13×13 shape valid · spawn/player tiles clear · eagle ring intact · half-tile placements match reference · enemy list has 20 with correct type counts · stage is completable (path from spawns to open field exists).
4. Output: `src/levels/original/stage01.json` … `stage35.json` + a generated contact-sheet preview (all 35 ASCII maps in one reviewable file) for the orchestrator gate.

Enemy composition per stage (counts of basic/fast/power/armor summing to 20) comes from the same references; it is **data produced by the transcription task**, stored in each stage file, and spot-verified against footage for stages 1–5.

Known anchor for sanity-checking (from the classic layout): stage 1 is the sparse brick layout whose enemy mix is dominated by basic tanks with a couple of fasts; if a transcription of stage 1 deviates wildly from this, the pipeline is suspect.

## 3. Neo Campaign (12 new stages)

**Constraints:** original mechanics and terrain vocabulary only — creativity lives in layout, terrain interplay, and wave composition. Difficulty band ≈ original stages 18–35. Every stage passes the same validation + completability checklist, plus a playtest gate (fun check by the orchestrator + owner).

| ID | Name | Motif brief | Wave flavor |
|---|---|---|---|
| neo-01 | First Frost | ice avenues force drift-aim; brick islands as brakes | fast-heavy |
| neo-02 | Twin Rivers | two vertical water channels, three bridges as chokepoints | power on bridges |
| neo-03 | The Orchard | dense tree cover — ambush warfare, sound cues matter | basic swarm + armors hidden |
| neo-04 | Foundry | steel maze with narrow brick doors; tier-3 rewards | power-heavy |
| neo-05 | Shatterfront | thick brick labyrinth that erodes into open war | balanced, armor finale |
| neo-06 | Frozen Harbor | ice sheet meeting water docks; sliding near edges | fast + power |
| neo-07 | Greenwall | tree curtain hiding a brick fortress | armor-heavy |
| neo-08 | The Vault | eagle in a steel pocket with one brick throat; shovel is king | mixed, relentless |
| neo-09 | Mirrorworks | perfect left/right symmetry; designed around 2P split defense | mirrored waves |
| neo-10 | Sandglass | hourglass shape, all traffic through the waist | power snipers |
| neo-11 | Blackout | near-empty field — pure dodging and spacing | fast swarm |
| neo-12 | Last Stand | all terrains, three-phase erosion toward the base | armor-heavy finale |

Authoring happens in our own editor (dogfooding gate: if authoring feels bad, the editor gets fixed first).

### 3.1 Built (T8.3, 2026-08-02)

All twelve ship as `src/levels/neo/neo01.json` … `neo12.json`, `provenance: "authored"`. The dogfooding gate was taken literally: T8.2's report said the editor had no mirror tool, no shape tools and no coordinate readout, so those were built **first** (`feat(editor): mirror modes, shape tools, coordinate readout`) and every tile of these twelve was then placed through `createEditor()` — the same model the editor screen sends its clicks to — by `npm run levels:author` (`scripts/author-neo-stages.ts` + `scripts/neo-stage-specs.ts`). A stage needing something the editor cannot do could not have been expressed. Each was then opened, validated and test-played in the real editor UI.

Each file carries its **idea** in `notes` — one line naming the thing a player should be able to name after one run — and its `effectiveStage` (§4). The contact sheet prints both.

| ID | Effective stage | Openness | Idea |
|---|---|---|---|
| neo-01 First Frost | 20 | 46.2% | Three ice avenues run spawn to base; the brick islands are the only brakes |
| neo-02 Twin Rivers | 21 | 59.2% | Three lanes, three bridges, two of them behind brick doors |
| neo-03 The Orchard | 23 | 29.6% | A canopy hides everyone; the two ploughed rows are the only sightlines |
| neo-04 Foundry | 24 | 48.5% | A steel maze whose only doors are brick — until somebody reaches tier 3 |
| neo-05 Shatterfront | 25 | 32.0% | Solid brick with one crossroads cut through it; it ends as a field |
| neo-06 Frozen Harbor | 27 | 55.0% | One ice sheet, water on three sides: a fast turn ends against the quay |
| neo-07 Greenwall | 28 | 36.1% | A tree curtain you can shoot through but not see through, in front of a fort |
| neo-08 The Vault | 30 | 59.2% | A steel pocket with one brick throat; hold it or lose everything |
| neo-09 Mirrorworks | 31 | 47.3% | Two identical halves, a steel spine between them, one player each |
| neo-10 Sandglass | 32 | 40.2% | A one-tile steel waist everything has to come through |
| neo-11 Blackout | 34 | 79.9% | Four steel pillars and nothing else to hide behind |
| neo-12 Last Stand | 35 | 42.0% | Three shells — trees and water, brick, then brick standing on ice |

`Mirrorworks` is symmetric by construction (drawn once, with the editor's left/right mirror on) and its wave order is a palindrome, which with 20 slots forces every type count even. `tests/levels/neo.test.ts` asserts both, plus the single throat in `The Vault`, the steel shoulders of `Sandglass`'s waist, and that all six terrains appear in `Last Stand`.

## 4. Difficulty guidance

- Spawn pressure comes from the fidelity §7 formula — Neo stages declare an *effective stage number* via position in campaign (neo-01 ≈ stage 20 pressure, neo-12 = 35).
- Mix curve across a campaign: armor share rises toward the end; fast tanks spike mid-campaign; power tanks appear where sightlines are long.
- Openness metric (share of empty tiles) recorded per stage in the contact sheet — the curve should oscillate (dense/open alternation keeps runs fresh, as the original does).

**As built (T8.3).** `effectiveStage` is a field on the stage file, not a rule the format knows about (`validateLevel` ignores it, exactly like `provenance`), and `neoEffectiveStage(n)` in `src/levels/campaign.ts` is what a campaign runner would hand core. The twelve declare 20, 21, 23, 24, 25, 27, 28, 30, 31, 32, 34, 35 — strictly rising, landing on the §7 cap.

Measured openness runs 46.2, 59.2, 29.6, 48.5, 32.0, 55.0, 36.1, 59.2, 47.3, 40.2, 79.9, 42.0 — nine direction changes in eleven steps, no run of three in the same direction, and a range (29.6–79.9%) that brackets the originals' own 23.7–67.5%. That is asserted, not just recorded: `tests/levels/neo.test.ts` fails if the curve ever drifts.

Two honest caveats about the metric. Openness counts *tiles that are not empty*, so **trees make a stage look dense that plays open** (`The Orchard` at 29.6% has no walls in it at all) and **half-tiles are nearly free** (a tile carved to one subcell counts the same as a solid one). It is a good tripwire for "this campaign is drifting", not a measure of how crowded a stage feels.

## 5. Custom levels & sharing

- Saved to `bc.customLevels.v1` (architecture §4.2).
- Export: pretty JSON file download **and** share string `BC1.<base64url(minified JSON)>`. Measured (T8.2): a dense stage is **~806 characters**, not the "~0.5 KB" this doc originally estimated — still comfortably paste-able, but size the UI for ~900. Import accepts both, validates, and reports precise errors.
- Future format versions bump the `BC1` prefix; v1 readers reject unknown prefixes with a clear message.

## 6. Deliverables summary (content phase)

1. `scripts/level-preview.ts` (ASCII contact sheet generator). **Done** — `npm run levels:preview`, one sheet for all 47 shipped stages.
2. 35 original stage files, transcribed + independently verified + contact sheet. **Done** (T7.1).
3. 12 Neo stage files, authored in-editor + playtested. **Done** (T8.3) — `npm run levels:author`.
4. Validation suite covering §1 rules (part of core/levels tests). **Done** — `tests/levels/schema.test.ts`, `campaign.test.ts`, `neo.test.ts`.
