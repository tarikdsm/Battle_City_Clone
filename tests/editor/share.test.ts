import { describe, expect, it } from 'vitest';
import {
  SHARE_PREFIX,
  decodeShare,
  encodeShare,
  exportJson,
  importText,
  shareFileName,
} from '../../src/editor/share';
import { createDraft, paintSubcell, paintTile } from '../../src/editor/tools';
import { setSlotType } from '../../src/editor/waveEditor';
import { validateLevel } from '../../src/levels/schema';
import stage02 from '../../src/levels/original/stage02.json';
import type { LevelData } from '../../src/core/types';

/** A level with something in every field a share code has to carry. */
function authored(): LevelData {
  let level = createDraft({
    id: 'custom-share-test',
    name: 'Pöytä — a name with accents',
    author: 'Tarik',
  });
  level = paintTile(level, 3, 3, 'B').level;
  level = paintTile(level, 4, 3, 'S').level;
  level = paintTile(level, 5, 3, 'W').level;
  level = paintTile(level, 6, 3, 'T').level;
  level = paintTile(level, 7, 3, 'I').level;
  level = paintSubcell(level, 2, 5, 0, 'B').level;
  level = paintSubcell(level, 2, 5, 3, 'B').level;
  return { ...level, enemies: setSlotType(level.enemies, 3, 'armor') };
}

function errorsOf(text: string): string[] {
  const result = importText(text);
  if (result.ok) {
    throw new Error('expected the import to fail, but it succeeded');
  }
  return result.errors;
}

// ---------------------------------------------------------------------------
// --- Share codes (content §5) ----------------------------------------------
// ---------------------------------------------------------------------------

describe('share codes', () => {
  it('is prefixed BC1. and is base64url — no +, / or = to break a URL', () => {
    const code = encodeShare(authored());
    expect(code.startsWith(`${SHARE_PREFIX}.`)).toBe(true);
    expect(code.slice(4)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips a level exactly, accents and half-tiles included', () => {
    const level = authored();
    const result = decodeShare(encodeShare(level));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.level).toEqual(level);
    }
  });

  it('round-trips a shipped original stage', () => {
    // The transcriptions carry `provenance`/`source` alongside `LevelData`.
    // A share code is the level, not our bookkeeping, so the extra keys are
    // not expected back — but the playable content must survive intact.
    const parsed = validateLevel(stage02);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const back = decodeShare(encodeShare(parsed.level));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.level.terrain).toEqual(parsed.level.terrain);
      expect(back.level.enemies).toEqual(parsed.level.enemies);
      expect(back.level.id).toBe(parsed.level.id);
    }
  });

  it('is small enough to paste — content §5 budgets about 0.5 KB', () => {
    const code = encodeShare(authored());
    expect(code.length).toBeLessThan(1200);
  });

  it('is deterministic: the same level always produces the same code', () => {
    expect(encodeShare(authored())).toBe(encodeShare(authored()));
  });

  it('tolerates surrounding whitespace and a newline from a paste', () => {
    const code = encodeShare(authored());
    expect(decodeShare(`  ${code}\n`).ok).toBe(true);
  });
});

describe('share codes that are not ours', () => {
  it('rejects a future version by name', () => {
    const future = `BC2.${encodeShare(authored()).slice(4)}`;
    const errors = errorsOf(future);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BC2');
    expect(errors[0]).toMatch(/BC1/);
  });

  it('rejects a code with no recognisable prefix', () => {
    expect(errorsOf('hello world').join('\n')).toMatch(/BC1\./);
  });

  it('rejects an empty paste', () => {
    expect(errorsOf('   ').join('\n')).toMatch(/nothing to import/i);
  });
});

describe('tampered payloads', () => {
  it('reports base64 that is not base64', () => {
    expect(errorsOf('BC1.not valid base64 *** !!').join('\n')).toMatch(
      /base64url/i,
    );
  });

  it('reports a payload that is not JSON', () => {
    // "this is not json" as base64url.
    const code = `${SHARE_PREFIX}.dGhpcyBpcyBub3QganNvbg`;
    expect(errorsOf(code).join('\n')).toMatch(/not valid JSON/i);
  });

  it('reports a truncated code rather than throwing', () => {
    const code = encodeShare(authored());
    const errors = errorsOf(code.slice(0, code.length - 12));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.length > 0)).toBe(true);
  });

  it('runs a decoded level through validateLevel and reports it verbatim', () => {
    const broken = { ...authored(), terrain: ['too', 'short'] };
    const code = encodeShare(broken as LevelData);
    const errors = errorsOf(code);
    expect(errors).toContain('terrain must have exactly 13 rows (got 2).');
  });

  it('rejects a payload that is a JSON array rather than a level', () => {
    // `[1,2,3]` as base64url.
    expect(errorsOf(`${SHARE_PREFIX}.WzEsMiwzXQ`).join('\n')).toMatch(
      /must be a JSON object/i,
    );
  });
});

// ---------------------------------------------------------------------------
// --- JSON files ------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('JSON export and import', () => {
  it('exports pretty JSON that reads back as the same level', () => {
    const level = authored();
    const text = exportJson(level);
    expect(text).toContain('\n  "version": 1');
    expect(text.endsWith('\n')).toBe(true);
    const back = importText(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.level).toEqual(level);
    }
  });

  it('accepts a pasted JSON object as readily as a share code', () => {
    // One box for both: an author who has a file open should be able to paste
    // its contents without first working out which kind of text it is.
    const level = authored();
    expect(importText(exportJson(level)).ok).toBe(true);
    expect(importText(encodeShare(level)).ok).toBe(true);
  });

  it('reports broken JSON readably', () => {
    expect(errorsOf('{ "version": 1, ').join('\n')).toMatch(/not valid JSON/i);
  });

  it('names the file after the stage, safely', () => {
    expect(shareFileName({ ...authored(), name: 'Ice bridge' })).toBe(
      'ice-bridge.json',
    );
    expect(shareFileName({ ...authored(), name: '  ///  ' })).toBe(
      'custom-stage.json',
    );
    expect(shareFileName({ ...authored(), name: 'A'.repeat(80) })).toMatch(
      /^a{1,48}\.json$/,
    );
  });
});
