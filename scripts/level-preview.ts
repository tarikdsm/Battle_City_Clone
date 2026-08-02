// scripts/level-preview.ts — the ASCII contact-sheet generator
// (`npm run levels:preview`, content doc 05 §6.1).
//
// It reads every shipped level, runs it through the SAME validator the game
// boots with (`validateLevel`) and the same completability walk the test suite
// gates on (`completabilityErrors`), renders the lot to
// `docs/assets/level-contact-sheet.txt`, and exits non-zero if anything failed.
// So this is a check as well as a renderer: a level file edited by hand into an
// unplayable shape cannot pass through it quietly.
//
// The rendering itself lives in `src/levels/analysis.ts` rather than here, so
// `tests/levels/schema.test.ts` can assert that the committed sheet is exactly
// what today's level files produce. Re-running this on unchanged inputs rewrites
// the identical bytes — there is no clock, no ordering by mtime and no
// formatter in the path.
//
// Node fs is used here on purpose: scripts live outside src/core, so the core's
// dependency-free/headless boundary does not apply to them.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  analyseLevel,
  completabilityErrors,
  renderContactSheet,
  type AnnotatedLevel,
} from '../src/levels/analysis';
import { validateLevel } from '../src/levels/schema';

// Campaign order: `original/` then `neo/`, each sorted by filename. stage01.json
// … stage35.json and neo01.json … sort correctly as plain strings because the
// numbers are zero-padded.
const CAMPAIGN_DIRS = ['original', 'neo'] as const;
const LEVELS_DIR = new URL('../src/levels/', import.meta.url);
const SHEET = new URL(
  '../docs/assets/level-contact-sheet.txt',
  import.meta.url,
);

interface Loaded {
  file: string;
  level: AnnotatedLevel;
  errors: string[];
}

function load(): Loaded[] {
  const out: Loaded[] = [];
  for (const dir of CAMPAIGN_DIRS) {
    const url = new URL(`${dir}/`, LEVELS_DIR);
    // `neo/` is empty until Phase 8 and git does not track empty directories,
    // so a fresh clone may not have it at all.
    if (!existsSync(url)) continue;
    for (const name of readdirSync(url).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = `${dir}/${name}`;
      const raw: unknown = JSON.parse(readFileSync(new URL(name, url), 'utf8'));
      const result = validateLevel(raw);
      const errors = result.ok
        ? completabilityErrors(result.level)
        : result.errors;
      out.push({ file, level: raw as AnnotatedLevel, errors });
    }
  }
  return out;
}

function main(): number {
  const loaded = load();
  if (loaded.length === 0) {
    console.error('level-preview: no level files found under src/levels/.');
    return 1;
  }

  writeFileSync(SHEET, renderContactSheet(loaded.map((l) => l.level)));
  console.log(
    `level-preview: ${loaded.length} level(s) -> ${fileURLToPath(SHEET)}`,
  );

  let bad = 0;
  for (const { file, level, errors } of loaded) {
    if (errors.length > 0) {
      bad += 1;
      console.error(`  FAIL ${file}`);
      for (const e of errors) console.error(`       ${e}`);
      continue;
    }
    const a = analyseLevel(level);
    console.log(
      `  ok   ${file.padEnd(22)} ${level.provenance ?? 'unlabelled'}`.padEnd(
        48,
      ) +
        ` openness ${(a.openness * 100).toFixed(1).padStart(5)}%` +
        ` minReach ${(a.minSpawnReach * 100).toFixed(1).padStart(5)}%`,
    );
  }
  if (bad > 0) {
    console.error(`level-preview: ${bad} level(s) failed validation.`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
