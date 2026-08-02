// src/levels/campaign.ts — the original campaign, addressed by stage number.
//
// Phase 7 transcribed all 35 stages from the ROM tables into `original/`, and
// until this file existed nothing read more than the first of them: `main.ts`
// imported `stage01.json` and handed the same layout to every stage a run
// reached. This is the lookup that turns 35 files into a campaign.
//
// ## Why 35 static imports rather than `import.meta.glob`
//
// Vite's glob would be three lines instead of thirty-five, and it was the first
// thing tried. Two things sank it:
//
// 1. **The typecheck.** The app program compiles with `types: []` (see
//    tsconfig.json) precisely so no ambient package can leak Node globals into
//    `src`, and `import.meta.glob` is declared by `vite/client`. Typing it by
//    hand in `vite-env.d.ts` would work for the app program but *not* for the
//    node program (tsconfig.node.json), which owns `tests/` and pulls `src`
//    files in through their imports without ever including that .d.ts — so any
//    test that touched this module would fail `npm run typecheck`.
// 2. **The failure mode.** A glob answers "whatever is on disk"; a missing or
//    misnamed `stage23.json` becomes a runtime surprise on the 23rd stage of
//    somebody's run. Below, it is a build error.
//
// The list is boring on purpose. It is also the whole reason the campaign is
// offline-complete (arch §10: no network calls at runtime at all) — every stage
// ships inside the bundle.

import type { LevelData } from '../core/types';
import { validateLevel } from './schema';

import stage01 from './original/stage01.json';
import stage02 from './original/stage02.json';
import stage03 from './original/stage03.json';
import stage04 from './original/stage04.json';
import stage05 from './original/stage05.json';
import stage06 from './original/stage06.json';
import stage07 from './original/stage07.json';
import stage08 from './original/stage08.json';
import stage09 from './original/stage09.json';
import stage10 from './original/stage10.json';
import stage11 from './original/stage11.json';
import stage12 from './original/stage12.json';
import stage13 from './original/stage13.json';
import stage14 from './original/stage14.json';
import stage15 from './original/stage15.json';
import stage16 from './original/stage16.json';
import stage17 from './original/stage17.json';
import stage18 from './original/stage18.json';
import stage19 from './original/stage19.json';
import stage20 from './original/stage20.json';
import stage21 from './original/stage21.json';
import stage22 from './original/stage22.json';
import stage23 from './original/stage23.json';
import stage24 from './original/stage24.json';
import stage25 from './original/stage25.json';
import stage26 from './original/stage26.json';
import stage27 from './original/stage27.json';
import stage28 from './original/stage28.json';
import stage29 from './original/stage29.json';
import stage30 from './original/stage30.json';
import stage31 from './original/stage31.json';
import stage32 from './original/stage32.json';
import stage33 from './original/stage33.json';
import stage34 from './original/stage34.json';
import stage35 from './original/stage35.json';

/**
 * The stage files in campaign order, **unvalidated**.
 *
 * `unknown`, not `LevelData`: `resolveJsonModule` types a JSON import as a loose
 * object literal (`version: number`, `terrain: string[]`), so the only thing
 * that can produce a `LevelData` is {@link validateLevel}. Widening here rather
 * than casting at the call site keeps that honest.
 */
const FILES: readonly unknown[] = [
  stage01,
  stage02,
  stage03,
  stage04,
  stage05,
  stage06,
  stage07,
  stage08,
  stage09,
  stage10,
  stage11,
  stage12,
  stage13,
  stage14,
  stage15,
  stage16,
  stage17,
  stage18,
  stage19,
  stage20,
  stage21,
  stage22,
  stage23,
  stage24,
  stage25,
  stage26,
  stage27,
  stage28,
  stage29,
  stage30,
  stage31,
  stage32,
  stage33,
  stage34,
  stage35,
];

/**
 * GDD §2/§4: the original campaign is 35 stages long.
 *
 * Deliberately derived from the list above rather than written as `35`, so the
 * constant cannot disagree with the files. `tests/levels/campaign.test.ts` pins
 * it against `STAGE_LOOP` (app/session.ts) and against what is on disk.
 */
export const ORIGINAL_STAGE_COUNT = FILES.length;

/**
 * Validated levels, by 1-based stage number.
 *
 * Populated on first use rather than at module load. A campaign visits at most
 * one new stage every few minutes, and validating all 35 on the boot path would
 * spend the work before the title screen has painted — for content the test
 * suite already gates (`tests/levels/campaign.test.ts` validates every one).
 */
const validated = new Map<number, LevelData>();

/**
 * The layout for stage `n`, 1…35.
 *
 * Takes the **looped** stage (`levelStageOf` in app/session.ts), not the run's
 * rising internal counter — stage 36 is stage 1's layout, and the counter that
 * keeps climbing is what keeps the spawn cadence tightening (fidelity §11.5).
 *
 * Throws rather than returning `null` for two reasons: an out-of-range stage is
 * a bug in the caller and there is no sensible level to substitute, and the app
 * already has a rail for exactly this (`createErrorRail` puts the message on the
 * error screen instead of leaving a black canvas).
 */
export function originalStage(stage: number): LevelData {
  const cached = validated.get(stage);
  if (cached !== undefined) {
    return cached;
  }
  if (!Number.isInteger(stage) || stage < 1 || stage > ORIGINAL_STAGE_COUNT) {
    throw new Error(
      `no such original stage: ${stage} (expected 1..${ORIGINAL_STAGE_COUNT})`,
    );
  }
  const result = validateLevel(FILES[stage - 1]);
  if (!result.ok) {
    throw new Error(
      `stage${String(stage).padStart(2, '0')}.json is invalid:\n${result.errors.join('\n')}`,
    );
  }
  validated.set(stage, result.level);
  return result.level;
}

/** Every stage, validated, in campaign order. The test suite's entry point. */
export function allOriginalStages(): LevelData[] {
  const out: LevelData[] = [];
  for (let n = 1; n <= ORIGINAL_STAGE_COUNT; n++) {
    out.push(originalStage(n));
  }
  return out;
}
