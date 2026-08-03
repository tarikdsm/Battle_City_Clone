// scripts/transcribe-original-stages.ts — regenerates `src/levels/original/`
// from the NES ROM's own stage table (`npm run levels:transcribe`).
//
// This script IS the provenance. The 35 stage files it writes claim to be
// transcriptions of the original game, and a claim like that is worth exactly
// as much as the path that can reproduce it, so the path is committed rather
// than described. Nothing here is authored by hand: the terrain, the wave
// composition and the spawn order are all decoded from ROM data, and the only
// edits made on top are the spawn-tile clearances under DEVIATIONS, which the
// script finds itself and records in each file it touches.
//
// --- Where the data comes from --------------------------------------------
//
// cyneprepou4uk/NES-Games-Disassembly carries a full disassembly of Battle City
// (J) with the stage table split out as raw binaries. Pinned to a commit, not a
// branch, so a re-run reproduces today's bytes:
//
//   Battle City/incbin/stages/stage_NN.bin  — 91 bytes, one stage's terrain
//   Battle City/bank_FF.asm                 — tbl_E4EC + tbl_E578, the waves
//
// --- The terrain encoding --------------------------------------------------
//
// 91 bytes = 182 nibbles = 13 rows x 14 nibbles, one nibble per tile and a
// 14th (always $D) closing each row. High nibble first. The nibble is a
// terrain kind AND a shape in one, which is why the format's `partials` exist:
// the NES field is 26x26 half-tiles, and a tile can carry any half or the lot.
//
// The nibble -> (kind, mask) table below is NOT documented in the disassembly.
// It was derived by decoding all 35 stages and matching every tile against two
// unrelated reimplementations, and it is re-checked on every run by `verify()`
// at the bottom of this file. That check is the evidence for the word
// "transcribed" in the level files; if it ever stops passing, the word is no
// longer earned.
//
// --- The wave --------------------------------------------------------------
//
// Two 35x4 tables and the spawn routine at $E3CB. tbl_E578 holds four counts
// per stage; tbl_E4EC holds the tank type each of those four slots means. The
// routine walks the slots in order, taking one tank from the current slot and
// only moving on when that slot is empty (`ram_enemy_type_offset` is zeroed
// once per stage at $C35B and only ever increments), so the 20-tank queue is
// slot 0's tanks, then slot 1's, and so on. Type bytes decode via the scoring
// path at $E7FB (`type >> 5 - 4` indexes the 100/200/300/400 table):
// $80 basic, $A0 fast, $C0 power, $E0 armor.
//
// Node fs/fetch are used here on purpose: scripts live outside src/core, so the
// core's dependency-free/headless boundary does not apply to them.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { validateLevel } from '../src/levels/schema';
import {
  completabilityErrors,
  type AnnotatedLevel,
} from '../src/levels/analysis';
import type { EnemyType } from '../src/core/types';

const STAGES = 35;
const TILES = 13;

// --- Pinned sources --------------------------------------------------------

const ROM_REPO = 'cyneprepou4uk/NES-Games-Disassembly';
const ROM_SHA = '57972cd64f18e3a718fbd3b0babe55e688599e8f';
const ROM_BASE = `https://raw.githubusercontent.com/${ROM_REPO}/${ROM_SHA}/Battle%20City/`;

// The two independent reimplementations `verify()` cross-checks against. Both
// predate this project and neither derives from the other: one is a C++/SDL2
// game storing 26x26 ASCII grids, the other a TypeScript/React game storing
// 13x13 JSON with explicit half-tile masks.
const TANKS_REPO = 'krystiankaluzny/Tanks';
const TANKS_SHA = 'f59aea31638117e20bc03276026bdbb9f8828b47';
const TANKS_BASE = `https://raw.githubusercontent.com/${TANKS_REPO}/${TANKS_SHA}/resources/stages/`;
const BC_REPO = 'feichao93/battle-city';
const BC_SHA = '745c369af6d4a02c71560265fd9448518e99c18d';
const BC_BASE = `https://raw.githubusercontent.com/${BC_REPO}/${BC_SHA}/app/stages/`;

const OUT_DIR = new URL('../src/levels/original/', import.meta.url);

// --- Deviations from the ROM ----------------------------------------------
//
// Seven tiles across five stages, all of one kind and all forced by our own
// engine rather than chosen: the format requires the three enemy spawn tiles
// and the two player spawn tiles to be empty (content doc 05 §1, arch §9), and
// the ROM does not. Stages 5 and 12 put a brick on the centre enemy spawn;
// stages 15 and 16 put trees on a player spawn; stage 32 ices all three enemy
// spawns. Trees and ice are drivable, so on the NES five of the seven are
// harmless scenery; the two bricks are the real change, and both
// reimplementations cross-checked below clear them too.
//
// The script detects these rather than hard-coding them, and writes a `notes`
// line into every file it edits — a transcription that quietly differs from its
// source is the failure mode this whole task is about.
const MUST_BE_EMPTY: readonly (readonly [number, number])[] = [
  [0, 0],
  [6, 0],
  [12, 0],
  [4, 12],
  [8, 12],
];

// --- ROM terrain decoding --------------------------------------------------

interface Cell {
  ch: string;
  mask: number;
}

const NIBBLE: readonly Cell[] = [
  { ch: 'B', mask: 10 }, // $0 brick, right half   (TR|BR)
  { ch: 'B', mask: 12 }, // $1 brick, bottom half  (BL|BR)
  { ch: 'B', mask: 5 }, //  $2 brick, left half    (TL|BL)
  { ch: 'B', mask: 3 }, //  $3 brick, top half     (TL|TR)
  { ch: 'B', mask: 15 }, // $4 brick, whole tile
  { ch: 'S', mask: 10 }, // $5 steel, right half
  { ch: 'S', mask: 12 }, // $6 steel, bottom half
  { ch: 'S', mask: 5 }, //  $7 steel, left half
  { ch: 'S', mask: 3 }, //  $8 steel, top half
  { ch: 'S', mask: 15 }, // $9 steel, whole tile
  { ch: 'W', mask: 15 }, // $A water
  { ch: 'T', mask: 15 }, // $B trees
  { ch: 'I', mask: 15 }, // $C ice
  { ch: '.', mask: 0 }, //  $D empty
];

function decodeTerrain(bytes: Uint8Array, stage: number): Cell[][] {
  if (bytes.length !== 91) {
    throw new Error(`stage ${stage}: expected 91 bytes, got ${bytes.length}`);
  }
  const nibbles: number[] = [];
  for (const b of bytes) nibbles.push(b >> 4, b & 0xf);

  const grid: Cell[][] = [];
  for (let ty = 0; ty < TILES; ty++) {
    const row: Cell[] = [];
    for (let tx = 0; tx < TILES; tx++) {
      const v = nibbles[ty * 14 + tx];
      const cell = NIBBLE[v];
      if (cell === undefined) {
        throw new Error(
          `stage ${stage} (${tx},${ty}): unknown nibble $${v.toString(16)}`,
        );
      }
      row.push(cell);
    }
    // The row's 14th nibble is padding and is $D in every stage of the ROM. If
    // that ever fails, the 13-tiles-plus-pad reading of the format is wrong and
    // everything decoded above is suspect, so it is an error, not a warning.
    const pad = nibbles[ty * 14 + 13];
    if (pad !== 0xd) {
      throw new Error(
        `stage ${stage} row ${ty}: pad nibble is $${pad.toString(16)}, expected $D`,
      );
    }
    grid.push(row);
  }
  return grid;
}

// --- ROM wave decoding -----------------------------------------------------

const TANK_TYPE: Record<number, EnemyType> = {
  0x80: 'basic',
  0xa0: 'fast',
  0xc0: 'power',
  0xe0: 'armor',
};

/** Parse a 35-row, 4-byte-per-row table out of the disassembly listing. */
function parseTable(asm: string, label: string): number[][] {
  const lines = asm.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(label));
  if (start < 0) throw new Error(`table not found in bank_FF.asm: ${label}`);

  const re =
    /\.byte \$([0-9A-F]{2}), \$([0-9A-F]{2}), \$([0-9A-F]{2}), \$([0-9A-F]{2})\s+;\s+([0-9A-F]{2})/;
  const rows: number[][] = [];
  for (let i = start + 1; i < lines.length && rows.length < STAGES; i++) {
    const m = re.exec(lines[i]);
    if (m === null) continue;
    // Each row of the listing is annotated with its own stage number. Checking
    // it means a table that gains or loses a line cannot silently shift every
    // stage's wave by one.
    const annotated = parseInt(m[5], 16);
    if (annotated !== rows.length + 1) {
      throw new Error(
        `${label}: row ${rows.length + 1} is annotated ${annotated}`,
      );
    }
    rows.push([m[1], m[2], m[3], m[4]].map((h) => parseInt(h, 16)));
  }
  if (rows.length !== STAGES) {
    throw new Error(`${label}: found ${rows.length} rows, expected ${STAGES}`);
  }
  return rows;
}

function buildQueue(
  types: number[],
  counts: number[],
  stage: number,
): EnemyType[] {
  const queue: EnemyType[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const type = TANK_TYPE[types[slot]];
    if (type === undefined) {
      throw new Error(
        `stage ${stage}: unknown tank type $${types[slot].toString(16)}`,
      );
    }
    for (let i = 0; i < counts[slot]; i++) queue.push(type);
  }
  if (queue.length !== 20) {
    throw new Error(
      `stage ${stage}: wave has ${queue.length} tanks, expected 20`,
    );
  }
  return queue;
}

// --- Fetching --------------------------------------------------------------

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function getBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

// --- Building the level files ---------------------------------------------

function buildLevel(
  stage: number,
  grid: Cell[][],
  queue: EnemyType[],
): AnnotatedLevel {
  const cells = grid.map((row) => row.map((c) => ({ ...c })));

  const cleared: string[] = [];
  for (const [tx, ty] of MUST_BE_EMPTY) {
    if (cells[ty][tx].ch !== '.') {
      cleared.push(`(${tx},${ty}) ${cells[ty][tx].ch}`);
      cells[ty][tx] = { ch: '.', mask: 0 };
    }
  }

  const terrain = cells.map((row) => row.map((c) => c.ch).join(''));
  const partials: { tx: number; ty: number; mask: number }[] = [];
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const { ch, mask } = cells[ty][tx];
      if ((ch === 'B' || ch === 'S') && mask !== 15) {
        partials.push({ tx, ty, mask });
      }
    }
  }

  const level: AnnotatedLevel = {
    version: 1,
    id: `orig-${pad2(stage)}`,
    name: `Stage ${stage}`,
    provenance: 'transcribed',
    source:
      `NES ROM stage table — ${ROM_REPO}@${ROM_SHA.slice(0, 7)} ` +
      `Battle City/incbin/stages/stage_${pad2(stage)}.bin (terrain), ` +
      `bank_FF.asm tbl_E4EC + tbl_E578 (wave)`,
    terrain,
    enemies: queue,
  };
  if (cleared.length > 0) {
    level.notes =
      `Deviates from the ROM at ${cleared.join(', ')}: the format requires the ` +
      `enemy and player spawn tiles to be empty (content doc 05 §1), and the ROM ` +
      `puts terrain there.`;
  }
  if (partials.length > 0) {
    level.partials = partials;
  }
  return level;
}

// Key order is fixed here rather than left to object-literal order so the files
// stay diffable across re-runs.
function serialize(level: AnnotatedLevel): string {
  const ordered: Record<string, unknown> = {
    version: level.version,
    id: level.id,
    name: level.name,
    provenance: level.provenance,
    source: level.source,
  };
  if (level.notes !== undefined) ordered.notes = level.notes;
  ordered.terrain = level.terrain;
  if (level.partials !== undefined) ordered.partials = level.partials;
  ordered.enemies = level.enemies;
  return JSON.stringify(ordered);
}

// --- Independent cross-check ----------------------------------------------

const TANKS_GLYPH: Record<string, string> = {
  '#': 'B',
  '@': 'S',
  '~': 'W',
  '%': 'T',
  '-': 'I',
  '.': '.',
};

/** krystiankaluzny/Tanks: a 26x26 ASCII grid, folded back to tiles + masks. */
function tanksCells(text: string, stage: number): (Cell | null)[][] {
  const rows = text.split(/\r?\n/).filter((r) => r.length === 26);
  if (rows.length !== 26) {
    throw new Error(`Tanks stage ${stage}: ${rows.length} rows of 26 chars`);
  }
  const grid: (Cell | null)[][] = [];
  for (let ty = 0; ty < TILES; ty++) {
    const row: (Cell | null)[] = [];
    for (let tx = 0; tx < TILES; tx++) {
      const quad = [
        rows[ty * 2][tx * 2],
        rows[ty * 2][tx * 2 + 1],
        rows[ty * 2 + 1][tx * 2],
        rows[ty * 2 + 1][tx * 2 + 1],
      ].map((c) => TANKS_GLYPH[c] ?? '?');
      const kinds = new Set(quad.filter((k) => k !== '.'));
      if (kinds.size === 0) row.push({ ch: '.', mask: 0 });
      else if (kinds.size > 1)
        row.push(null); // two kinds in one tile: unrepresentable, count as a diff
      else {
        let mask = 0;
        [1, 2, 4, 8].forEach((bit, i) => {
          if (quad[i] !== '.') mask |= bit;
        });
        row.push({ ch: [...kinds][0], mask });
      }
    }
    grid.push(row);
  }
  return grid;
}

// feichao93/battle-city, app/types/StageConfig.ts: X empty, E eagle, B brick,
// T steel, R river (water), S snow (ice), F forest (trees); a trailing hex
// digit on B/T is the half-tile mask, in the same bit order as ours.
// Those JSON files carry a UTF-8 BOM, which JSON.parse rejects.
const BOM = /^\uFEFF/;

const BC_GLYPH: Record<string, string> = {
  X: '.',
  B: 'B',
  T: 'S',
  R: 'W',
  S: 'I',
  F: 'T',
  E: 'E',
};

function bcCells(text: string, stage: number): (Cell | null)[][] {
  const data = JSON.parse(text.replace(BOM, '')) as { map: string[] };
  if (data.map.length !== TILES) {
    throw new Error(`battle-city stage ${stage}: ${data.map.length} rows`);
  }
  return data.map.map((line) => {
    const row: (Cell | null)[] = [];
    for (let tx = 0; tx < TILES; tx++) {
      const cell = line.slice(tx * 3, tx * 3 + 3).trim();
      const ch = BC_GLYPH[cell[0]];
      if (ch === undefined)
        throw new Error(`battle-city stage ${stage}: cell "${cell}"`);
      if (ch === 'E') row.push(null);
      else if (ch === '.') row.push({ ch: '.', mask: 0 });
      else row.push({ ch, mask: cell.length > 1 ? parseInt(cell[1], 16) : 15 });
    }
    return row;
  });
}

// The engine stamps its own brick ring over these five tiles and clears the
// eagle tile (fidelity §2), and the two reimplementations draw the NES's thinner
// ring into their map data. Nothing here is comparable, so it is excluded.
const BASE_AREA = new Set(['5,11', '6,11', '7,11', '5,12', '6,12', '7,12']);

interface Diff {
  stage: number;
  tx: number;
  ty: number;
  rom: string;
  other: string;
}

function compare(
  stage: number,
  rom: Cell[][],
  other: (Cell | null)[][],
  into: Diff[],
): number {
  let compared = 0;
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      if (BASE_AREA.has(`${tx},${ty}`)) continue;
      compared += 1;
      const a = rom[ty][tx];
      const b = other[ty][tx];
      const bs = b === null ? 'n/a' : `${b.ch}${b.mask}`;
      if (b === null || a.ch !== b.ch || a.mask !== b.mask) {
        into.push({ stage, tx, ty, rom: `${a.ch}${a.mask}`, other: bs });
      }
    }
  }
  return compared;
}

async function verify(grids: Cell[][][], queues: EnemyType[][]): Promise<void> {
  console.log(
    '\nCross-checking the decode against two independent reimplementations.',
  );
  const tanksDiffs: Diff[] = [];
  const bcDiffs: Diff[] = [];
  const waveDiffs: string[] = [];
  let compared = 0;

  for (let s = 1; s <= STAGES; s++) {
    const rom = grids[s - 1];
    compared += compare(
      s,
      rom,
      tanksCells(await getText(`${TANKS_BASE}${s}`), s),
      tanksDiffs,
    );

    const bcText = await getText(`${BC_BASE}stage-${s}.json`);
    compare(s, rom, bcCells(bcText, s), bcDiffs);

    // The whole 20-tank SEQUENCE, not just the tally. The order is the one
    // thing here read out of code rather than out of data — the ROM stores no
    // queue, only four counts and four types, and the order comes from how
    // $E3CB consumes them. This comparison is what turns that reading into a
    // checked fact: their `bots` is an ordered list of groups, so expanding it
    // gives their spawn order, and it reproduces the slot-by-slot walk down to
    // stages whose four slots name the same tank type twice (7, 11, 31, 33).
    const bots = (JSON.parse(bcText.replace(BOM, '')) as { bots: string[] })
      .bots;
    const theirs = bots.flatMap((b) => {
      const [n, t] = b.split('*');
      return Array.from({ length: Number(n) }, () => t);
    });
    const ours = queues[s - 1];
    if (ours.join(',') !== theirs.join(',')) {
      waveDiffs.push(
        `  stage ${s}:\n    ROM        ${ours.join(' ')}\n    ${BC_REPO} ${theirs.join(' ')}`,
      );
    }
  }

  const agree = (d: Diff[]): string =>
    `${d.length} disagreements (${(((compared - d.length) / compared) * 100).toFixed(2)}% agree)`;
  console.log(
    `  ${compared} tiles compared per source (the base area is excluded)`,
  );
  console.log(`  ROM vs ${TANKS_REPO}: ${agree(tanksDiffs)}`);
  console.log(`  ROM vs ${BC_REPO}: ${agree(bcDiffs)}`);
  for (const d of [...tanksDiffs, ...bcDiffs]) {
    console.log(
      `    stage ${d.stage} (${d.tx},${d.ty}) ROM=${d.rom} other=${d.other}`,
    );
  }
  console.log(
    `  waves (full 20-tank order): ${STAGES - waveDiffs.length}/${STAGES} stages agree with ${BC_REPO}`,
  );
  for (const w of waveDiffs) console.log(w);
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `Fetching the ROM stage table from ${ROM_REPO}@${ROM_SHA.slice(0, 7)}.`,
  );
  const asm = await getText(`${ROM_BASE}bank_FF.asm`);
  const types = parseTable(asm, 'tbl_E4EC_stage_enemies:');
  const counts = parseTable(asm, 'tbl_E578_stage_enemies_type_counter:');

  const grids: Cell[][][] = [];
  const queues: EnemyType[][] = [];
  const prettier = await resolveConfig(
    fileURLToPath(new URL('stage01.json', OUT_DIR)),
  );

  for (let s = 1; s <= STAGES; s++) {
    const grid = decodeTerrain(
      await getBytes(`${ROM_BASE}incbin/stages/stage_${pad2(s)}.bin`),
      s,
    );
    const queue = buildQueue(types[s - 1], counts[s - 1], s);
    grids.push(grid);
    queues.push(queue);

    const level = buildLevel(s, grid, queue);
    const result = validateLevel(level);
    if (!result.ok) {
      throw new Error(
        `stage ${s} failed validation:\n${result.errors.join('\n')}`,
      );
    }
    const problems = completabilityErrors(result.level);
    if (problems.length > 0) {
      throw new Error(`stage ${s} is not completable:\n${problems.join('\n')}`);
    }

    const path = fileURLToPath(new URL(`stage${pad2(s)}.json`, OUT_DIR));
    writeFileSync(
      path,
      await format(serialize(level), { ...prettier, filepath: path }),
    );
    const tally = (t: EnemyType): number => queue.filter((e) => e === t).length;
    console.log(
      `  stage${pad2(s)}.json  partials ${String(level.partials?.length ?? 0).padStart(3)}  ` +
        `wave ${tally('basic')}/${tally('fast')}/${tally('power')}/${tally('armor')}` +
        (level.notes === undefined ? '' : '  (deviation recorded)'),
    );
  }

  await verify(grids, queues);
  console.log(
    '\nDone. Run `npm run levels:preview` to regenerate the contact sheet.',
  );
}

await main();
