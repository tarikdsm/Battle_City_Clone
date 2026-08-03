import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_STAGE_COUNT,
  allOriginalStages,
  originalStage,
} from '../../src/levels/campaign';
import { completabilityErrors } from '../../src/levels/analysis';
import { validateLevel } from '../../src/levels/schema';
import { STAGE_LOOP, levelStageOf } from '../../src/app/session';

const ORIGINAL_DIR = fileURLToPath(
  new URL('../../src/levels/original/', import.meta.url),
);

describe('the original campaign (GDD §4, content §2)', () => {
  it('addresses all 35 stages, and the count agrees with the files on disk', () => {
    // The count is derived from the import list, so this is the guard against
    // a stage file that exists but was never wired in — the exact failure that
    // let the game play stage 1 thirty-five times.
    const onDisk = readdirSync(ORIGINAL_DIR).filter((f) =>
      f.endsWith('.json'),
    ).length;
    expect(ORIGINAL_STAGE_COUNT).toBe(onDisk);
    expect(ORIGINAL_STAGE_COUNT).toBe(35);
  });

  it('is exactly as long as the campaign loop', () => {
    // `STAGE_LOOP` is what makes stage 36 stage 1 again. If the two ever
    // disagreed, either a stage would be unreachable or the loop would ask for
    // a file that does not exist.
    expect(ORIGINAL_STAGE_COUNT).toBe(STAGE_LOOP);
  });

  it('serves every stage schema-valid and completable', () => {
    for (const level of allOriginalStages()) {
      const result = validateLevel(level);
      expect(result.ok ? [] : result.errors, level.id).toEqual([]);
      expect(completabilityErrors(level), level.id).toEqual([]);
    }
  });

  it('serves stage N as orig-NN, in order', () => {
    for (let n = 1; n <= ORIGINAL_STAGE_COUNT; n++) {
      expect(originalStage(n).id).toBe(`orig-${String(n).padStart(2, '0')}`);
      expect(originalStage(n).name).toBe(`Stage ${n}`);
    }
  });

  it('serves 35 DIFFERENT stages', () => {
    // The bug this file exists for was invisible from any single stage: every
    // number produced a valid, playable level. It was only visible from two.
    const fields = allOriginalStages().map((l) => l.terrain.join('|'));
    expect(new Set(fields).size).toBe(ORIGINAL_STAGE_COUNT);
    expect(fields[0]).not.toBe(fields[1]);
  });

  it('returns the same object for a repeated lookup', () => {
    // The cache is what keeps a 35-stage run from re-validating on every stage
    // boundary; it also means core is handed a stable reference.
    expect(originalStage(7)).toBe(originalStage(7));
  });

  it('rejects a stage number outside 1..35 with a readable message', () => {
    for (const bad of [0, 36, -1, 1.5, Number.NaN]) {
      expect(() => originalStage(bad)).toThrow(/no such original stage/);
    }
  });

  it('loops: the internal counter past 35 folds onto a real stage file', () => {
    // Fidelity §11.5 — the counter rises forever, the layout wraps. This is the
    // pair `main.ts` uses, tested together because either alone looks correct.
    expect(originalStage(levelStageOf(36)).id).toBe('orig-01');
    expect(originalStage(levelStageOf(70)).id).toBe('orig-35');
    expect(originalStage(levelStageOf(71)).id).toBe('orig-01');
  });
});
