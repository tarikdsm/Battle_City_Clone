// tests/core/parity-coverage.test.ts — the Gate G1 meta-test.
//
// Fidelity spec §15 defines 26 parity invariants, P-01 … P-26, and every one of
// them is supposed to be pinned by at least one automated test. Nothing enforces
// that by construction: a test can be deleted, or renamed, or a whole invariant
// can be forgotten, and the suite still goes green. So this test reads the suite
// itself, pulls the `P-nn` tags out of every `describe`/`it` title, and fails with
// the missing ids by name when a row of §15 has no test carrying its tag.
//
// It is a coverage LEDGER, not a proof: the tag says a test claims the invariant,
// and the review that accepts the tag is what makes the claim true. The rule for
// keeping it honest is one-directional — if an invariant is genuinely covered by a
// test whose title lacks the tag, fix the title; never relax the checklist.
//
// This file is deliberately excluded from its own scan: a meta-test that could
// satisfy the checklist by mentioning the ids in its own titles would be circular.
//
// Node fs is used on purpose — tests live outside src/core, so the core's
// headless boundary does not apply here (this file compiles under
// tsconfig.node.json, the only program that carries @types/node).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = new URL('../', import.meta.url);
const SELF = 'parity-coverage.test.ts';

const FIRST_PARITY_ID = 1;
const LAST_PARITY_ID = 26; // fidelity spec §15 ends at P-26

// `describe(`, `it(`, `test(` and their `.only`/`.skip`/`.concurrent` variants,
// capturing the opening title literal (single, double or template quoted). Only
// titles are scanned: a `P-nn` in a comment or an assertion message documents
// intent, it does not claim coverage.
//
// KNOWN LIMITATION — `describe.each(TABLE)('title …')` is NOT matched: the table
// argument sits between `.each` and the title, so the title is in a second call.
// The effect is conservative (a tag can only be missed, never invented), and the
// one such title in the suite today — replay.test.ts's `golden replay $name
// (P-23)` — is backed by the tagged `it`s inside it. Widen the pattern if a
// `.each` block ever becomes the SOLE evidence for an invariant.
const TITLE_RE =
  /\b(?:describe|it|test)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
const TAG_RE = /P-(\d{2})/g;

interface Tag {
  id: number;
  where: string;
}

function listTestSources(dir: URL, prefix: string, out: string[][]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      listTestSources(
        new URL(`${entry.name}/`, dir),
        `${prefix}${entry.name}/`,
        out,
      );
    } else if (entry.name.endsWith('.ts') && entry.name !== SELF) {
      out.push([
        `${prefix}${entry.name}`,
        readFileSync(new URL(entry.name, dir), 'utf8'),
      ]);
    }
  }
}

// Every parity tag in the suite, with the file:line of the title that carries it.
function collectTags(): Tag[] {
  const sources: string[][] = [];
  listTestSources(TESTS_DIR, 'tests/', sources);

  const tags: Tag[] = [];
  for (const [path, source] of sources) {
    TITLE_RE.lastIndex = 0;
    let title: RegExpExecArray | null;
    while ((title = TITLE_RE.exec(source)) !== null) {
      // The 1-based line of the title literal, counted from the match offset.
      const line = source.slice(0, title.index).split('\n').length;
      TAG_RE.lastIndex = 0;
      let tag: RegExpExecArray | null;
      while ((tag = TAG_RE.exec(title[2])) !== null) {
        tags.push({ id: Number(tag[1]), where: `${path}:${line}` });
      }
    }
  }
  return tags;
}

const TAGS = collectTags();

function idsCovered(): Set<number> {
  const ids = new Set<number>();
  for (const tag of TAGS) ids.add(tag.id);
  return ids;
}

function label(id: number): string {
  return `P-${String(id).padStart(2, '0')}`;
}

describe('parity checklist coverage (fidelity spec §15)', () => {
  it('finds tagged tests to audit at all', () => {
    // Guards the scan itself: a broken regex or a moved directory would otherwise
    // report "everything missing" and be read as a suite-wide catastrophe.
    expect(TAGS.length).toBeGreaterThan(LAST_PARITY_ID);
  });

  it('covers every parity invariant P-01 through P-26', () => {
    const covered = idsCovered();
    const missing: string[] = [];
    for (let id = FIRST_PARITY_ID; id <= LAST_PARITY_ID; id++) {
      if (!covered.has(id)) missing.push(label(id));
    }
    expect(
      missing,
      `parity invariants with no tagged test: ${missing.join(', ')} — ` +
        'add a test, or tag the existing one; do not relax this checklist.',
    ).toEqual([]);
  });

  it('has no parity tag outside the P-01…P-26 range', () => {
    const stray = [...idsCovered()]
      .filter((id) => id < FIRST_PARITY_ID || id > LAST_PARITY_ID)
      .map(label)
      .sort();
    expect(
      stray,
      `tags outside fidelity §15: ${stray.join(', ')} — likely a typo in a test title.`,
    ).toEqual([]);
  });
});
