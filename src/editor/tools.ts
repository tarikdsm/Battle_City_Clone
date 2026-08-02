// src/editor/tools.ts — the terrain brush (arch §9, content §1).
//
// Pure and DOM-free, like `levels/analysis.ts` and for the same reason: the
// tests run in Vitest's node environment, so anything the brush decides is
// decided here and `ui/screens/editor.ts` only draws the answer.
//
// ## What a "subcell mode" brush actually edits
//
// The level format has one material per tile plus an optional `partials` entry
// that carves a **brick or steel** tile down to the subcells its mask keeps
// (bits `1=TL 2=TR 4=BL 8=BR`). The NES originals lean on this heavily —
// stage 1 alone is 30 half-tiles — so an editor without it cannot reproduce the
// content it exists to extend.
//
// Every operation here returns a NEW level and never edits the one it is given.
// That is what lets the editor's undo stack be a list of references instead of
// a list of deep clones, and it is why a no-op returns the *same* object: the
// caller can tell "nothing happened" by identity.

import {
  BASE_RING_TILES,
  EAGLE_TILE,
  ENEMY_SPAWN_TILES,
  FIELD_TILES,
  P1_SPAWN_TILE,
  P2_SPAWN_TILE,
} from '../core/constants';
import type { EnemyType, LevelData } from '../core/types';
import { WAVE_SIZE } from './waveEditor';

/** The six terrain characters (content §1). `.` is empty, and the eraser. */
export type Brush = '.' | 'B' | 'S' | 'W' | 'T' | 'I';

/** Which resolution a stroke works at. */
export type PaintMode = 'tile' | 'subcell';

/** A subcell within a tile, in mask-bit order: 0=TL, 1=TR, 2=BL, 3=BR. */
export type Subcell = 0 | 1 | 2 | 3;

/** A point on the field, at whichever resolution the current mode works at. */
export interface Cell {
  tx: number;
  ty: number;
  sub: Subcell;
}

/**
 * Which reflections a stroke is repeated through.
 *
 * The originals are overwhelmingly symmetric — and so is anything built around
 * a base that sits on the field's vertical axis — so without this every
 * symmetric layout is drawn twice, and the two halves drift apart by a tile
 * somewhere around the fortieth stroke.
 */
export type MirrorMode = 'off' | 'horizontal' | 'vertical' | 'quad';

/** What a press-drag-release does. `brush` is the original freehand stroke. */
export type ShapeTool = 'brush' | 'line' | 'rect' | 'rectFill' | 'fill';

/** The mirror modes, in the order the UI offers them. English sentence case. */
export const MIRROR_MODES: readonly { mode: MirrorMode; label: string }[] =
  Object.freeze([
    { mode: 'off', label: 'Off' },
    { mode: 'horizontal', label: 'Left / right' },
    { mode: 'vertical', label: 'Top / bottom' },
    { mode: 'quad', label: 'Quad' },
  ]);

/** The tools, in the order the UI offers them. */
export const SHAPE_TOOLS: readonly { tool: ShapeTool; label: string }[] =
  Object.freeze([
    { tool: 'brush', label: 'Brush' },
    { tool: 'line', label: 'Line' },
    { tool: 'rect', label: 'Rectangle' },
    { tool: 'rectFill', label: 'Filled rectangle' },
    { tool: 'fill', label: 'Fill' },
  ]);

/** Mask bit per {@link Subcell} — content §1's `1=TL, 2=TR, 4=BL, 8=BR`. */
export const SUBCELL_BITS: readonly number[] = Object.freeze([1, 2, 4, 8]);

/** Every mask bit set: a tile that needs no `partials` entry at all. */
const FULL_MASK = 15;

/**
 * The palette, in the order it is offered. Copy is English sentence case.
 *
 * Empty leads because it is the eraser and an eraser you have to hunt for is
 * an eraser you stop using. `half` marks the two materials the format lets a
 * partial carve — the UI greys subcell mode out for the others rather than
 * letting an author build something `validateLevel` will refuse at save time.
 */
export const BRUSHES: readonly {
  char: Brush;
  label: string;
  half: boolean;
}[] = Object.freeze([
  { char: '.', label: 'Erase', half: true },
  { char: 'B', label: 'Brick', half: true },
  { char: 'S', label: 'Steel', half: true },
  { char: 'W', label: 'Water', half: false },
  { char: 'T', label: 'Trees', half: false },
  { char: 'I', label: 'Ice', half: false },
]);

/** Tiles the format reserves, with the reason an author needs to hear. */
const RESERVED: readonly {
  tiles: readonly (readonly [number, number])[];
  why: string;
}[] = Object.freeze([
  {
    tiles: ENEMY_SPAWN_TILES,
    why: 'Enemy spawn tiles must stay clear — the wave deploys there.',
  },
  {
    tiles: [P1_SPAWN_TILE, P2_SPAWN_TILE],
    why: 'Player spawn tiles must stay clear.',
  },
  {
    tiles: [EAGLE_TILE, ...BASE_RING_TILES],
    why: 'The eagle and its brick ring are stamped automatically.',
  },
]);

/**
 * Why this tile cannot be painted, or `null` when it can.
 *
 * The spawn tiles are a *validation* rule (content §1) and the base is an
 * *engine* rule (fidelity §2), but from the brush's side they are the same
 * thing: a stroke there either fails at save time or shows nothing, and both
 * read as a broken tool. Refusing out loud is the honest version.
 */
export function reservedTile(tx: number, ty: number): string | null {
  for (const group of RESERVED) {
    for (const [x, y] of group.tiles) {
      if (x === tx && y === ty) {
        return group.why;
      }
    }
  }
  return null;
}

export interface PaintResult {
  /** The new draft — the *same object* when nothing changed. */
  level: LevelData;
  changed: boolean;
  /** A message for the status line: why nothing (or something else) happened. */
  refused: string | null;
}

function unchanged(level: LevelData, refused: string | null): PaintResult {
  return { level, changed: false, refused };
}

function inField(tx: number, ty: number): boolean {
  return (
    Number.isInteger(tx) &&
    Number.isInteger(ty) &&
    tx >= 0 &&
    ty >= 0 &&
    tx < FIELD_TILES &&
    ty < FIELD_TILES
  );
}

/** A fresh, empty, schema-valid draft (content §1). */
export function createDraft(init?: {
  id?: string;
  name?: string;
  author?: string;
}): LevelData {
  return {
    version: 1,
    id: init?.id ?? newCustomId(),
    name: init?.name ?? 'Untitled stage',
    author: init?.author ?? '',
    terrain: Array.from({ length: FIELD_TILES }, () => '.'.repeat(FIELD_TILES)),
    partials: [],
    enemies: Array.from({ length: WAVE_SIZE }, () => 'basic' as EnemyType),
  };
}

/**
 * `custom-<uuid>` per content §1.
 *
 * `randomUUID` is unavailable outside a secure context (a LAN IP over plain
 * http, which is exactly how somebody tests this on a phone), so the fallback
 * is not decoration — without it, opening the editor there would throw.
 */
export function newCustomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return `custom-${uuid}`;
  }
  return `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

// ---------------------------------------------------------------------------
// --- Terrain rows and partials ---------------------------------------------
// ---------------------------------------------------------------------------

function withTileChar(
  terrain: readonly string[],
  tx: number,
  ty: number,
  ch: Brush,
): string[] {
  const rows = [...terrain];
  const row = rows[ty];
  rows[ty] = row.slice(0, tx) + ch + row.slice(tx + 1);
  return rows;
}

function maskOf(level: LevelData, tx: number, ty: number): number | undefined {
  return level.partials?.find((p) => p.tx === tx && p.ty === ty)?.mask;
}

/**
 * Set (or, with `mask === null`, remove) one tile's partial.
 *
 * The list is kept sorted by row then column. That is not tidiness for its own
 * sake: a saved level, an exported file and a share code are all just this
 * array serialised, and two authors who drew the same field in a different
 * order should produce the same bytes.
 */
function withPartial(
  level: LevelData,
  tx: number,
  ty: number,
  mask: number | null,
): { tx: number; ty: number; mask: number }[] {
  const kept = (level.partials ?? []).filter(
    (p) => !(p.tx === tx && p.ty === ty),
  );
  if (mask !== null) {
    kept.push({ tx, ty, mask });
  }
  return kept.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
}

// ---------------------------------------------------------------------------
// --- The two brushes -------------------------------------------------------
// ---------------------------------------------------------------------------

/** Paint a whole tile. A whole tile has no half-tiles, so its partial goes. */
export function paintTile(
  level: LevelData,
  tx: number,
  ty: number,
  brush: Brush,
): PaintResult {
  if (!inField(tx, ty)) {
    return unchanged(level, `Tile (${tx},${ty}) is outside the field.`);
  }
  const reserved = reservedTile(tx, ty);
  if (reserved !== null) {
    return unchanged(level, reserved);
  }
  const had = level.terrain[ty][tx];
  const mask = maskOf(level, tx, ty);
  if (had === brush && mask === undefined) {
    return unchanged(level, null);
  }
  return {
    level: {
      ...level,
      terrain: withTileChar(level.terrain, tx, ty, brush),
      partials: withPartial(level, tx, ty, null),
    },
    changed: true,
    refused: null,
  };
}

/**
 * Paint one subcell of a tile.
 *
 * The rules, all of them consequences of "one tile carries one material":
 *
 * - only brick and steel can be partial, so `W`/`T`/`I` are refused;
 * - painting brick or steel keeps whatever brick/steel was already in the tile
 *   and adds the new subcell, so changing material never destroys geometry;
 * - painting over water, trees or ice replaces the tile with the single subcell
 *   painted, because the old material has nowhere left to live;
 * - completing all four subcells drops the `partials` entry — a full tile *is*
 *   the tile, and a mask of 15 would be a second way to spell the same field;
 * - erasing the last occupied subcell empties the tile.
 */
export function paintSubcell(
  level: LevelData,
  tx: number,
  ty: number,
  sub: Subcell,
  brush: Brush,
): PaintResult {
  if (!inField(tx, ty)) {
    return unchanged(level, `Tile (${tx},${ty}) is outside the field.`);
  }
  const reserved = reservedTile(tx, ty);
  if (reserved !== null) {
    return unchanged(level, reserved);
  }
  const bit = SUBCELL_BITS[sub];
  const had = level.terrain[ty][tx] as Brush;
  const partial = had === 'B' || had === 'S';
  const prevMask = partial ? (maskOf(level, tx, ty) ?? FULL_MASK) : 0;

  if (brush === '.') {
    if (!partial) {
      if (had === '.') {
        return unchanged(level, null);
      }
      // Water, trees and ice have no half-tiles, so there is exactly one thing
      // an erase here can mean. Do it, and say what happened.
      return {
        level: {
          ...level,
          terrain: withTileChar(level.terrain, tx, ty, '.'),
          partials: withPartial(level, tx, ty, null),
        },
        changed: true,
        refused: 'Cleared the whole tile — only brick and steel have halves.',
      };
    }
    const next = prevMask & ~bit;
    if (next === prevMask) {
      return unchanged(level, null);
    }
    return {
      level: {
        ...level,
        terrain: withTileChar(level.terrain, tx, ty, next === 0 ? '.' : had),
        partials: withPartial(level, tx, ty, next === 0 ? null : next),
      },
      changed: true,
      refused: null,
    };
  }

  if (brush !== 'B' && brush !== 'S') {
    return unchanged(
      level,
      `${brush === 'W' ? 'Water' : brush === 'T' ? 'Trees' : 'Ice'} fills a whole tile — only brick and steel have halves.`,
    );
  }

  const next = prevMask | bit;
  if (had === brush && next === prevMask) {
    return unchanged(level, null);
  }
  return {
    level: {
      ...level,
      terrain: withTileChar(level.terrain, tx, ty, brush),
      partials: withPartial(level, tx, ty, next === FULL_MASK ? null : next),
    },
    changed: true,
    refused: null,
  };
}

// ---------------------------------------------------------------------------
// --- Mirroring -------------------------------------------------------------
// ---------------------------------------------------------------------------
//
// ## Why the reflection is computed on the 26x26 grid
//
// "Mirror the tile and keep the mask" is wrong twice. A top-LEFT half reflected
// across the field's vertical axis is a top-RIGHT half, so the mask has to be
// reflected as well; and the field is 13 tiles wide, so the centre column *is*
// the axis — its left half reflects onto its own right half rather than onto
// another tile. Both fall out for free from reflecting the subcell coordinate
// (`25 - sx`) and folding the result back into tile + subcell, which is what
// these two functions do.

const SUBCELLS = FIELD_TILES * 2;

function flipsX(mode: MirrorMode): boolean {
  return mode === 'horizontal' || mode === 'quad';
}

function flipsY(mode: MirrorMode): boolean {
  return mode === 'vertical' || mode === 'quad';
}

/**
 * The tiles a tile-resolution stroke lands on, the struck one first.
 *
 * Deduplicated: on the axis (column 6, row 6) the reflection is the tile
 * itself, and painting it four times would be three no-ops that each cost a
 * fresh level object.
 */
export function mirrorTiles(
  tx: number,
  ty: number,
  mode: MirrorMode,
): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = [{ tx, ty }];
  const mx = FIELD_TILES - 1 - tx;
  const my = FIELD_TILES - 1 - ty;
  const add = (x: number, y: number): void => {
    if (!out.some((p) => p.tx === x && p.ty === y)) {
      out.push({ tx: x, ty: y });
    }
  };
  if (flipsX(mode)) {
    add(mx, ty);
  }
  if (flipsY(mode)) {
    add(tx, my);
  }
  if (flipsX(mode) && flipsY(mode)) {
    add(mx, my);
  }
  return out;
}

/** The same, at half-tile resolution: the subcell is reflected too. */
export function mirrorSubcells(
  tx: number,
  ty: number,
  sub: Subcell,
  mode: MirrorMode,
): Cell[] {
  const sx = tx * 2 + (sub % 2);
  const sy = ty * 2 + (sub < 2 ? 0 : 1);
  const mx = SUBCELLS - 1 - sx;
  const my = SUBCELLS - 1 - sy;
  const points: [number, number][] = [[sx, sy]];
  const add = (x: number, y: number): void => {
    if (!points.some((p) => p[0] === x && p[1] === y)) {
      points.push([x, y]);
    }
  };
  if (flipsX(mode)) {
    add(mx, sy);
  }
  if (flipsY(mode)) {
    add(sx, my);
  }
  if (flipsX(mode) && flipsY(mode)) {
    add(mx, my);
  }
  return points.map(([x, y]) => ({
    tx: x >> 1,
    ty: y >> 1,
    sub: ((y & 1) * 2 + (x & 1)) as Subcell,
  }));
}

/** What the mirror says when a reflection landed somewhere it may not paint. */
const MIRROR_SKIPPED = 'Mirror skipped a reserved tile.';

/**
 * Paint one cell and every reflection of it, as a single operation.
 *
 * `sub === undefined` paints whole tiles, exactly as {@link paintTile} does.
 *
 * A reflection that lands on a reserved tile is **skipped, not refused**: near
 * the top edge a top/bottom mirror hits the player spawns constantly, and a
 * mode that stopped painting there would be a mode nobody leaves on.
 *
 * The struck cell is the other way round. If *it* is refused the whole stroke
 * is, reflections included — answering a click the editor just said no to by
 * painting two tiles somewhere else would be the tool inventing edits.
 */
export function paintMirrored(
  level: LevelData,
  tx: number,
  ty: number,
  sub: Subcell | undefined,
  brush: Brush,
  mirror: MirrorMode,
): PaintResult {
  const targets: (Cell | { tx: number; ty: number; sub?: undefined })[] =
    sub === undefined
      ? mirrorTiles(tx, ty, mirror)
      : mirrorSubcells(tx, ty, sub, mirror);

  let next = level;
  let changed = false;
  let primary: string | null = null;
  let skipped = false;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const res =
      t.sub === undefined
        ? paintTile(next, t.tx, t.ty, brush)
        : paintSubcell(next, t.tx, t.ty, t.sub, brush);
    next = res.level;
    changed = changed || res.changed;
    if (i === 0) {
      primary = res.refused;
      if (!res.changed && res.refused !== null) {
        return unchanged(level, res.refused);
      }
    } else if (res.refused !== null && !res.changed) {
      skipped = true;
    }
  }
  const refused = primary ?? (skipped ? MIRROR_SKIPPED : null);
  return changed
    ? { level: next, changed, refused }
    : unchanged(level, refused);
}

// ---------------------------------------------------------------------------
// --- Line, rectangle and fill ----------------------------------------------
// ---------------------------------------------------------------------------

export interface ShapeOptions {
  tool: ShapeTool;
  /** Where the drag began. The seed tile, for {@link ShapeTool} `fill`. */
  from: Cell;
  /** Where it is now. Every shape is recomputed from `from` on every move. */
  to: Cell;
  brush: Brush;
  mode: PaintMode;
  mirror: MirrorMode;
}

/** What the status line says when a fill was asked for in half-tile mode. */
const FILL_IS_WHOLE_TILE = 'Fill works on whole tiles.';

/**
 * One press-drag-release of a shape tool, as a single (mirrored) operation.
 *
 * Always computed from `from` rather than accumulated, so dragging back
 * *shrinks* the rectangle instead of leaving the big one underneath — which is
 * what lets the editor use the result directly as a live preview.
 */
export function applyShape(level: LevelData, opts: ShapeOptions): PaintResult {
  const { tool, from, to, brush, mode, mirror } = opts;

  if (tool === 'fill') {
    const region = floodRegion(level, from.tx, from.ty);
    const res = paintAll(
      level,
      region.map((t) => ({ ...t, sub: undefined })),
      brush,
      mirror,
    );
    if (mode === 'subcell' && res.changed) {
      return { ...res, level: res.level, refused: FILL_IS_WHOLE_TILE };
    }
    return res;
  }

  if (mode === 'subcell') {
    const a = subPoint(from);
    const b = subPoint(to);
    const cells = shapePoints(tool, a, b, SUBCELLS).map(([x, y]) => ({
      tx: x >> 1,
      ty: y >> 1,
      sub: ((y & 1) * 2 + (x & 1)) as Subcell,
    }));
    return paintAll(level, cells, brush, mirror);
  }

  const cells = shapePoints(
    tool,
    [from.tx, from.ty],
    [to.tx, to.ty],
    FIELD_TILES,
  ).map(([tx, ty]) => ({ tx, ty, sub: undefined }));
  return paintAll(level, cells, brush, mirror);
}

function subPoint(cell: Cell): [number, number] {
  return [cell.tx * 2 + (cell.sub % 2), cell.ty * 2 + (cell.sub < 2 ? 0 : 1)];
}

/** Chain a list of cells through {@link paintMirrored}, keeping identity. */
function paintAll(
  level: LevelData,
  cells: readonly (Cell | { tx: number; ty: number; sub?: undefined })[],
  brush: Brush,
  mirror: MirrorMode,
): PaintResult {
  let next = level;
  let changed = false;
  let refused: string | null = null;
  for (const cell of cells) {
    const res = paintMirrored(next, cell.tx, cell.ty, cell.sub, brush, mirror);
    next = res.level;
    changed = changed || res.changed;
    // The first thing that went wrong, kept: a rectangle dragged over the
    // enemy spawns should say so once, not thirteen times.
    if (refused === null && res.refused !== null && !res.changed) {
      refused = res.refused;
    }
  }
  return changed
    ? { level: next, changed, refused }
    : unchanged(level, refused);
}

/** The cells a shape covers, in the grid `size` wide (tiles or subcells). */
function shapePoints(
  tool: ShapeTool,
  [x0, y0]: [number, number],
  [x1, y1]: [number, number],
  size: number,
): [number, number][] {
  const ax = clampTo(x0, size);
  const ay = clampTo(y0, size);
  const bx = clampTo(x1, size);
  const by = clampTo(y1, size);
  if (tool === 'line') {
    return linePoints(ax, ay, bx, by);
  }
  if (tool === 'brush') {
    return [[bx, by]];
  }
  const loX = Math.min(ax, bx);
  const hiX = Math.max(ax, bx);
  const loY = Math.min(ay, by);
  const hiY = Math.max(ay, by);
  const out: [number, number][] = [];
  for (let y = loY; y <= hiY; y++) {
    for (let x = loX; x <= hiX; x++) {
      const edge = x === loX || x === hiX || y === loY || y === hiY;
      if (tool === 'rectFill' || edge) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

function clampTo(v: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(v)));
}

/** Bresenham. Integer in, integer out, and it always terminates. */
function linePoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) {
      return out;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * The contiguous run of identical tiles the seed belongs to (4-connected).
 *
 * "Identical" means the same material **and** the same partial mask, so a
 * half-tile is its own region and a fill stops at it rather than quietly
 * erasing the geometry half-tile mode exists to make.
 */
function floodRegion(
  level: LevelData,
  tx: number,
  ty: number,
): { tx: number; ty: number }[] {
  if (!inField(tx, ty)) {
    return [];
  }
  const idOf = (x: number, y: number): string =>
    `${level.terrain[y][x]}${maskOf(level, x, y) ?? FULL_MASK}`;
  const target = idOf(tx, ty);
  const seen = new Set<number>([ty * FIELD_TILES + tx]);
  const queue: { tx: number; ty: number }[] = [{ tx, ty }];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = at.tx + dx;
      const ny = at.ty + dy;
      if (!inField(nx, ny)) continue;
      const key = ny * FIELD_TILES + nx;
      if (seen.has(key)) continue;
      if (idOf(nx, ny) !== target) continue;
      seen.add(key);
      queue.push({ tx: nx, ty: ny });
    }
  }
  return queue;
}

// ---------------------------------------------------------------------------
// --- The coordinate readout ------------------------------------------------
// ---------------------------------------------------------------------------

const MATERIAL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '.': 'empty',
  B: 'brick',
  S: 'steel',
  W: 'water',
  T: 'trees',
  I: 'ice',
});

/** Subcell names in mask-bit order, which is how content §1 numbers them. */
const SUBCELL_NAMES: readonly string[] = Object.freeze([
  'TL',
  'TR',
  'BL',
  'BR',
]);

/**
 * What is under the cursor, in words.
 *
 * Working from a reference ("brick at 7,4") otherwise means counting cells with
 * your eyes, and the half-tile grid is 26 across. The reserved suffix is there
 * so the rule is learned *before* the click rather than from the refusal after
 * it.
 */
export function describeCursor(
  level: LevelData,
  cell: Cell,
  mode: PaintMode,
): string {
  const { tx, ty, sub } = cell;
  if (!inField(tx, ty)) {
    return 'Off the field';
  }
  const parts = [
    `Tile ${tx},${ty}`,
    MATERIAL_NAMES[level.terrain[ty][tx]] ?? 'empty',
  ];
  if (mode === 'subcell') {
    const [sx, sy] = subPoint(cell);
    parts.push(`half-tile ${SUBCELL_NAMES[sub]} (subcell ${sx},${sy})`);
  }
  if (reservedTile(tx, ty) !== null) {
    parts.push('reserved');
  }
  return parts.join(' · ');
}
