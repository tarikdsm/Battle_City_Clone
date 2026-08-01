// src/levels/schema.ts — runtime validation for LevelData (content doc 05 §1).
// levels/ may import core *types* only (arch §2). Every failure appends a
// user-readable English message (the editor surfaces these on import), and all
// problems are collected — validation never stops at the first error.
import type { LevelData } from '../core/types';

export type { LevelData } from '../core/types';

const VALID_TERRAIN_CHARS = '.BSWTI';
const VALID_ENEMIES = ['basic', 'fast', 'power', 'armor'];
// Tiles that must be left empty (content doc 05 §1 / fidelity §2).
const ENEMY_SPAWN_TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [6, 0],
  [12, 0],
];
const PLAYER_SPAWN_TILES: readonly (readonly [number, number])[] = [
  [4, 12],
  [8, 12],
];

export function validateLevel(
  data: unknown,
): { ok: true; level: LevelData } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['Level must be a JSON object.'] };
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    errors.push(
      `version must be exactly 1 (got ${JSON.stringify(obj.version)}).`,
    );
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    errors.push('id must be a non-empty string.');
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    errors.push('name must be a non-empty string.');
  }

  // `rows` is non-null only when the grid is structurally indexable (13 rows of
  // 13-char strings); spawn/partial-tile checks depend on that.
  const rows = validateTerrain(obj.terrain, errors);
  validateEnemies(obj.enemies, errors);
  validatePartials(obj.partials, rows, errors);
  if (rows) {
    validateSpawnClearances(rows, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, level: data as LevelData };
}

function validateTerrain(terrain: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(terrain)) {
    errors.push('terrain must be an array of 13 strings.');
    return null;
  }
  if (terrain.length !== 13) {
    errors.push(`terrain must have exactly 13 rows (got ${terrain.length}).`);
  }
  let structural = terrain.length === 13;
  terrain.forEach((row, y) => {
    if (typeof row !== 'string') {
      errors.push(`terrain row ${y} must be a string.`);
      structural = false;
      return;
    }
    if (row.length !== 13) {
      errors.push(
        `terrain row ${y} has invalid row length ${row.length} (must be 13).`,
      );
      structural = false;
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (!VALID_TERRAIN_CHARS.includes(ch)) {
        errors.push(
          `terrain row ${y} col ${x}: invalid char ${JSON.stringify(ch)} (allowed: . B S W T I).`,
        );
      }
    }
  });
  return structural ? (terrain as string[]) : null;
}

function validateEnemies(enemies: unknown, errors: string[]): void {
  if (!Array.isArray(enemies)) {
    errors.push('enemies must be an array of 20 enemy types.');
    return;
  }
  if (enemies.length !== 20) {
    errors.push(
      `enemies list must have exactly 20 enemies (got ${enemies.length}).`,
    );
  }
  enemies.forEach((e, i) => {
    if (typeof e !== 'string' || !VALID_ENEMIES.includes(e)) {
      errors.push(
        `enemies[${i}] must be one of basic|fast|power|armor (got ${JSON.stringify(e)}).`,
      );
    }
  });
}

function validatePartials(
  partials: unknown,
  rows: string[] | null,
  errors: string[],
): void {
  if (partials === undefined) {
    return;
  }
  if (!Array.isArray(partials)) {
    errors.push('partials must be an array when present.');
    return;
  }
  partials.forEach((p, i) => {
    if (typeof p !== 'object' || p === null) {
      errors.push(`partials[${i}] must be an object { tx, ty, mask }.`);
      return;
    }
    const pp = p as Record<string, unknown>;
    const { tx, ty, mask } = pp;
    const txOk = isIntInRange(tx, 0, 12);
    const tyOk = isIntInRange(ty, 0, 12);
    if (!txOk) {
      errors.push(
        `partials[${i}].tx must be an integer in 0..12 (got ${JSON.stringify(tx)}).`,
      );
    }
    if (!tyOk) {
      errors.push(
        `partials[${i}].ty must be an integer in 0..12 (got ${JSON.stringify(ty)}).`,
      );
    }
    if (!isIntInRange(mask, 1, 15)) {
      errors.push(
        `partials[${i}].mask must be an integer in 1..15 (got ${JSON.stringify(mask)}).`,
      );
    }
    if (rows && txOk && tyOk) {
      const ch = rows[ty as number][tx as number];
      if (ch !== 'B' && ch !== 'S') {
        errors.push(
          `partial at (${tx as number},${ty as number}) targets a '${ch}' tile but partials are only valid on B or S tiles.`,
        );
      }
    }
  });
}

function validateSpawnClearances(rows: string[], errors: string[]): void {
  for (const [tx, ty] of ENEMY_SPAWN_TILES) {
    const ch = rows[ty][tx];
    if (ch !== '.') {
      errors.push(
        `enemy spawn tile (${tx},${ty}) must be empty '.' but is '${ch}'.`,
      );
    }
  }
  for (const [tx, ty] of PLAYER_SPAWN_TILES) {
    const ch = rows[ty][tx];
    if (ch !== '.') {
      errors.push(
        `player spawn tile (${tx},${ty}) must be empty '.' but is '${ch}'.`,
      );
    }
  }
}

function isIntInRange(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
