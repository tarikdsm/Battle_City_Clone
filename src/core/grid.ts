// src/core/grid.ts — pure AABB / grid math, no state. Coordinates are in `u`
// unless named `sx`/`sy` (subcell coords, 0..25) or `tx`/`ty` (tile coords, 0..12).
import { FIELD_SUBCELLS, FIELD_TILES, SUBCELL, TILE } from './constants';

export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Strict overlap: boxes that merely touch along an edge do NOT overlap.
export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

// Subcell coords -> flat tile index (ty*13 + tx). Two subcells span one tile.
export function tileAt(sx: number, sy: number): number {
  const tx = Math.floor(sx / 2);
  const ty = Math.floor(sy / 2);
  return ty * FIELD_TILES + tx;
}

// Subcell coords -> flat subcell index (sy*26 + sx).
export function subcellIndex(sx: number, sy: number): number {
  return sy * FIELD_SUBCELLS + sx;
}

// Nearest multiple of 8 (a subcell boundary), clamped to >= 0. Used for turn-snap (§4).
export function snap8(v: number): number {
  return Math.max(0, Math.round(v / SUBCELL) * SUBCELL);
}

// Tiles (clipped to the field) that the AABB overlaps, in row-major order.
export function tilesInAabb(a: Aabb): { tx: number; ty: number }[] {
  const txMin = Math.max(0, Math.floor(a.x / TILE));
  const tyMin = Math.max(0, Math.floor(a.y / TILE));
  const txMax = Math.min(FIELD_TILES - 1, Math.ceil((a.x + a.w) / TILE) - 1);
  const tyMax = Math.min(FIELD_TILES - 1, Math.ceil((a.y + a.h) / TILE) - 1);
  const out: { tx: number; ty: number }[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      out.push({ tx, ty });
    }
  }
  return out;
}

// Invoke `cb` for every subcell (clipped to the field) the AABB overlaps, row-major.
export function forEachSubcellUnder(
  a: Aabb,
  cb: (sx: number, sy: number) => void,
): void {
  const sxMin = Math.max(0, Math.floor(a.x / SUBCELL));
  const syMin = Math.max(0, Math.floor(a.y / SUBCELL));
  const sxMax = Math.min(
    FIELD_SUBCELLS - 1,
    Math.ceil((a.x + a.w) / SUBCELL) - 1,
  );
  const syMax = Math.min(
    FIELD_SUBCELLS - 1,
    Math.ceil((a.y + a.h) / SUBCELL) - 1,
  );
  for (let sy = syMin; sy <= syMax; sy++) {
    for (let sx = sxMin; sx <= sxMax; sx++) {
      cb(sx, sy);
    }
  }
}
