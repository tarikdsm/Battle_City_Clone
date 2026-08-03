// scripts/author-neo-stages.ts — the twelve Neo Campaign stages
// (`npm run levels:author`, content doc 05 §3).
//
// ## Why the stages are a script and not twelve hand-written JSON files
//
// Content §3 puts a dogfooding gate on this campaign: "authoring happens in our
// own editor (if authoring feels bad, the editor gets fixed first)". A hand-typed
// grid of 169 characters would slip that gate silently — nothing about the file
// would say whether the editor could have produced it.
//
// So every tile is placed by driving `createEditor()` — the *same* model
// `src/ui/screens/editor.ts` sends its clicks to — through the tools T8.3 added:
// mirror modes, line, rectangle, filled rectangle and flood fill. A stage that
// needed something the editor cannot do could not be expressed here at all.
// Twelve stages of that is the honest version of the gate, and re-running it
// rewrites byte-identical files, so the claim stays checkable.
//
// The stages were then opened, validated and test-played in the real editor UI
// (`npm run capture:neo`), which is where the pointer-level dogfooding happened.
//
// Node fs is used here on purpose: scripts live outside src/core, so the core's
// dependency-free/headless boundary does not apply to them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEditor, type EditorModel } from '../src/editor/editor';
import { createDraft, type Subcell } from '../src/editor/tools';
import {
  analyseLevel,
  completabilityErrors,
  type AnnotatedLevel,
} from '../src/levels/analysis';
import { validateLevel } from '../src/levels/schema';
import { NEO_SPECS, type At, type StageSpec } from './neo-stage-specs';

const OUT_DIR = new URL('../src/levels/neo/', import.meta.url);

function cell(at: At): { tx: number; ty: number; sub: Subcell } {
  return { tx: at[0], ty: at[1], sub: at[2] ?? 0 };
}

interface Built {
  level: AnnotatedLevel;
  /** Anything the editor refused, so a design fighting the format is visible. */
  refusals: string[];
}

/** Replay one stage's ops through the editor model, exactly as a drag would. */
function build(spec: StageSpec): Built {
  const ed: EditorModel = createEditor(
    createDraft({ id: spec.id, name: spec.name }),
  );
  const refusals: string[] = [];
  for (const op of spec.ops) {
    ed.setMode(op.mode);
    ed.setBrush(op.brush);
    ed.setTool(op.tool);
    ed.setMirror(op.mirror ?? spec.mirror);
    // Press, drag, release — the three calls the pointer handlers make.
    ed.beginShape(cell(op.from));
    ed.updateShape(cell(op.to));
    ed.endShape();
    if (ed.status() !== '') {
      refusals.push(ed.status());
    }
  }

  let slot = 0;
  for (const [type, count] of spec.wave) {
    for (let i = 0; i < count; i++) {
      ed.setEnemy(slot, type);
      slot += 1;
    }
  }
  if (slot !== 20) {
    throw new Error(`${spec.id}: wave is ${slot} tanks, not 20`);
  }

  const draft = ed.draft();
  const partials = draft.partials ?? [];
  const level: AnnotatedLevel = {
    version: 1,
    id: spec.id,
    name: spec.name,
    provenance: 'authored',
    source:
      'Authored in this project’s own editor (content §3 dogfooding gate); ' +
      'rebuilt tile by tile by `npm run levels:author`.',
    notes: spec.note,
    effectiveStage: spec.effectiveStage,
    terrain: draft.terrain,
    ...(partials.length > 0 ? { partials } : {}),
    enemies: draft.enemies,
  };
  return { level, refusals };
}

function main(): number {
  mkdirSync(OUT_DIR, { recursive: true });
  let bad = 0;
  const lines: string[] = [];

  NEO_SPECS.forEach((spec, i) => {
    const n = i + 1;
    if (spec.id !== `neo-${String(n).padStart(2, '0')}`) {
      throw new Error(`stage ${n} is ${spec.id}; ids must run neo-01..neo-12`);
    }
    const { level, refusals } = build(spec);
    const result = validateLevel(level);
    const errors = result.ok
      ? completabilityErrors(result.level)
      : result.errors;
    const a = analyseLevel(level);
    writeFileSync(
      new URL(`neo${String(n).padStart(2, '0')}.json`, OUT_DIR),
      `${JSON.stringify(level, null, 2)}\n`,
    );

    if (errors.length > 0) {
      bad += 1;
      console.error(`  FAIL ${spec.id}`);
      for (const e of errors) console.error(`       ${e}`);
      for (const row of a.tileRows) console.error(`       ${row}`);
    }
    lines.push(
      `  ${spec.id} ${spec.name.padEnd(14)} eff ${String(spec.effectiveStage).padStart(2)}` +
        ` open ${(a.openness * 100).toFixed(1).padStart(5)}%` +
        ` reach ${(a.minSpawnReach * 100).toFixed(1).padStart(5)}%` +
        ` b${String(a.enemyCounts.basic).padStart(2)}` +
        ` f${String(a.enemyCounts.fast).padStart(2)}` +
        ` p${String(a.enemyCounts.power).padStart(2)}` +
        ` a${String(a.enemyCounts.armor).padStart(2)}` +
        ` half ${String(level.partials?.length ?? 0).padStart(2)}` +
        (refusals.length > 0 ? ` (refused: ${refusals[0]})` : ''),
    );
    if (process.env.NEO_MAPS === '1') {
      lines.push('');
      for (const row of a.subcellRows) lines.push(`    ${row}`);
      lines.push('');
    }
  });

  console.log(`neo: ${NEO_SPECS.length} stage(s) -> ${fileURLToPath(OUT_DIR)}`);
  for (const l of lines) console.log(l);
  if (bad > 0) {
    console.error(`author-neo-stages: ${bad} stage(s) failed.`);
  }
  return bad > 0 ? 1 : 0;
}

process.exitCode = main();
