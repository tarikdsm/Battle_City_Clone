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
