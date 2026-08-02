// src/levels/analysis.ts — what a level looks like without playing it: the
// field the engine will actually build, how open it is, whether it can be
// finished, and the ASCII contact sheet the content review reads.
//
// Pure and dependency-free. `levels/` may import core *types* only (arch §2),
// so the field constants below are re-declared rather than imported from
// core/constants; `tests/levels/schema.test.ts` asserts the two agree, which is
// the guard against them drifting apart.
import type { EnemyType, LevelData } from '../core/types';

/** How a stage's data came to be — see docs/05-content-levels.md §2. */
export type Provenance = 'transcribed' | 'reconstructed';

/**
 * A level file as shipped: `LevelData` plus the transcription bookkeeping.
 *
 * These three fields are deliberately NOT part of `LevelData` and NOT checked
 * by `validateLevel`: they describe where a stage came from, which is a fact
 * about our campaign, not about the format. A user level imported into the
 * editor has no provenance and must still validate.
 */
export interface AnnotatedLevel extends LevelData {
  provenance?: Provenance;
  source?: string;
  notes?: string;
}

const FIELD_TILES = 13;
const TILE_COUNT = FIELD_TILES * FIELD_TILES;
const SUBCELLS = FIELD_TILES * 2;

type Tile = readonly [number, number];

const ENEMY_SPAWNS: readonly Tile[] = [
  [0, 0],
  [6, 0],
  [12, 0],
];
const PLAYER_SPAWNS: readonly Tile[] = [
  [4, 12],
  [8, 12],
];
const EAGLE: Tile = [6, 12];
const BASE_RING: readonly Tile[] = [
  [5, 11],
  [6, 11],
  [7, 11],
  [5, 12],
  [7, 12],
];

/**
 * Terrain a tank can work its way through, as opposed to terrain that stops it
 * for good. Brick is in the list because it is destructible: a brick wall costs
 * an enemy tank a few seconds, not access. Steel and water are not — no enemy
 * type can remove either.
 *
 * This is the reading the "must reach the base" half of the rule forces: the
 * eagle sits inside a brick ring stamped on every level (fidelity §2), so over
 * empty tiles alone no level could ever reach its own base.
 */
const TRAVERSABLE = '.TIB';

/** The share of the field each enemy spawn must be able to work its way to. */
export const MIN_SPAWN_REACH = 0.4;

export interface LevelAnalysis {
  /** Tile rows after the engine's automatic base stamp (fidelity §2). */
  tileRows: string[];
  /** The same field at subcell resolution, so `partials` are visible. */
  subcellRows: string[];
  /** Share of the 169 tiles that are empty, once the base is stamped. */
  openness: number;
  /** Per enemy spawn, the share of the field reachable from it. */
  spawnReach: number[];
  minSpawnReach: number;
  /** Can every enemy spawn work its way to the eagle tile? */
  baseReachable: boolean;
  /** Tile counts per terrain char, keyed by `.BSWTI`. */
  terrainCounts: Record<string, number>;
  enemyCounts: Record<EnemyType, number>;
  enemySpawns: number[][];
  playerSpawns: number[][];
  eagle: number[];
  baseRing: number[][];
}

/**
 * The tile grid the engine will build: the rows as authored, with the base ring
 * forced to brick and the eagle tile cleared (`buildTerrain` in core/game.ts).
 * `noAutoBase` is honoured for symmetry, though v1 content never sets it.
 */
export function stampedTileRows(level: LevelData): string[] {
  const rows = level.terrain.map((r) => r.split(''));
  if (!level.noAutoBase) {
    for (const [tx, ty] of BASE_RING) {
      rows[ty][tx] = 'B';
    }
    rows[EAGLE[1]][EAGLE[0]] = '.';
  }
  return rows.map((r) => r.join(''));
}

const SUBCELL_GLYPH: Record<string, string> = {
  '.': '.',
  B: '#',
  S: '@',
  W: '~',
  T: '%',
  I: '-',
};

/**
 * The field at 26x26 subcell resolution, mirroring core's `buildTerrain`: each
 * tile fills its 2x2 block, `partials` then carve B/S tiles down to the subcells
 * their mask keeps (1=TL 2=TR 4=BL 8=BR), and the base stamp lands last. The
 * eagle is drawn as `A` — it is an entity rather than terrain, but a contact
 * sheet that hid it would be harder to read, not more honest.
 */
export function subcellRows(level: LevelData): string[] {
  const grid: string[][] = Array.from({ length: SUBCELLS }, () =>
    Array.from({ length: SUBCELLS }, () => '.'),
  );
  const fill = (tx: number, ty: number, glyph: string): void => {
    grid[ty * 2][tx * 2] = glyph;
    grid[ty * 2][tx * 2 + 1] = glyph;
    grid[ty * 2 + 1][tx * 2] = glyph;
    grid[ty * 2 + 1][tx * 2 + 1] = glyph;
  };

  for (let ty = 0; ty < FIELD_TILES; ty++) {
    for (let tx = 0; tx < FIELD_TILES; tx++) {
      fill(tx, ty, SUBCELL_GLYPH[level.terrain[ty][tx]] ?? '.');
    }
  }
  for (const { tx, ty, mask } of level.partials ?? []) {
    const glyph = SUBCELL_GLYPH[level.terrain[ty][tx]] ?? '.';
    grid[ty * 2][tx * 2] = (mask & 1) !== 0 ? glyph : '.';
    grid[ty * 2][tx * 2 + 1] = (mask & 2) !== 0 ? glyph : '.';
    grid[ty * 2 + 1][tx * 2] = (mask & 4) !== 0 ? glyph : '.';
    grid[ty * 2 + 1][tx * 2 + 1] = (mask & 8) !== 0 ? glyph : '.';
  }
  if (!level.noAutoBase) {
    for (const [tx, ty] of BASE_RING) {
      fill(tx, ty, '#');
    }
    fill(EAGLE[0], EAGLE[1], 'A');
  }
  return grid.map((r) => r.join(''));
}

/**
 * Tiles a tank starting on `from` can work its way to, over `TRAVERSABLE`.
 *
 * Tile-resolution and 4-connected, which makes it *conservative*: a tank is one
 * tile wide and moves in half-tile steps, so it can in fact slip through the
 * open half of a partial tile that this walk treats as solid. A level that
 * passes here therefore really is reachable; one that fails might, in an
 * unusual layout, still be squeezable through. Erring that way is the right
 * direction for a gate.
 */
function reachable(rows: string[], from: Tile): Set<number> {
  const seen = new Set<number>([from[1] * FIELD_TILES + from[0]]);
  const queue: Tile[] = [from];
  const steps: readonly Tile[] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (const [dx, dy] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= FIELD_TILES || ny >= FIELD_TILES) continue;
      const key = ny * FIELD_TILES + nx;
      if (seen.has(key)) continue;
      if (!TRAVERSABLE.includes(rows[ny][nx])) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

export function analyseLevel(level: LevelData): LevelAnalysis {
  const tileRows = stampedTileRows(level);

  const terrainCounts: Record<string, number> = {
    '.': 0,
    B: 0,
    S: 0,
    W: 0,
    T: 0,
    I: 0,
  };
  for (const row of tileRows) {
    for (const ch of row) {
      terrainCounts[ch] = (terrainCounts[ch] ?? 0) + 1;
    }
  }

  const enemyCounts: Record<EnemyType, number> = {
    basic: 0,
    fast: 0,
    power: 0,
    armor: 0,
  };
  for (const e of level.enemies) {
    enemyCounts[e] += 1;
  }

  const eagleKey = EAGLE[1] * FIELD_TILES + EAGLE[0];
  const reach = ENEMY_SPAWNS.map((spawn) => reachable(tileRows, spawn));

  return {
    tileRows,
    subcellRows: subcellRows(level),
    openness: terrainCounts['.'] / TILE_COUNT,
    spawnReach: reach.map((r) => r.size / TILE_COUNT),
    minSpawnReach: Math.min(...reach.map((r) => r.size / TILE_COUNT)),
    baseReachable: reach.every((r) => r.has(eagleKey)),
    terrainCounts,
    enemyCounts,
    enemySpawns: ENEMY_SPAWNS.map(([x, y]) => [x, y]),
    playerSpawns: PLAYER_SPAWNS.map(([x, y]) => [x, y]),
    eagle: [EAGLE[0], EAGLE[1]],
    baseRing: BASE_RING.map(([x, y]) => [x, y]),
  };
}

/**
 * Is this level playable? Every enemy spawn must be able to work its way to at
 * least `MIN_SPAWN_REACH` of the field and to the eagle; otherwise the wave
 * either cannot deploy or cannot threaten the base, and the stage is a dud.
 *
 * Messages are user-readable for the same reason `validateLevel`'s are: the
 * editor shows them on import.
 */
export function completabilityErrors(level: LevelData): string[] {
  const errors: string[] = [];
  const rows = stampedTileRows(level);
  const eagleKey = EAGLE[1] * FIELD_TILES + EAGLE[0];

  for (const spawn of ENEMY_SPAWNS) {
    const seen = reachable(rows, spawn);
    const share = seen.size / TILE_COUNT;
    const where = `enemy spawn (${spawn[0]},${spawn[1]})`;
    if (share < MIN_SPAWN_REACH) {
      errors.push(
        `${where} can only reach ${pct(share)} of the field (at least ${pct(MIN_SPAWN_REACH)} required) — ` +
          `it is walled in by steel or water.`,
      );
    }
    if (!seen.has(eagleKey)) {
      errors.push(
        `${where} cannot reach the base at (${EAGLE[0]},${EAGLE[1]}) — the stage cannot be lost, so it is not a stage.`,
      );
    }
  }
  return errors;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// --- Contact sheet ---------------------------------------------------------

const SHEET_HEADER = `Battle City — level contact sheet
Generated by \`npm run levels:preview\` (scripts/level-preview.ts). Do not edit by hand.

Legend   .  empty    #  brick    @  steel    ~  water    %  trees    -  ice    A  eagle

Each map is the field at 26x26 subcell resolution (2x2 subcells per tile), after
the engine stamps the brick ring around the eagle, so what is drawn is what the
player meets. Enemy spawns are the top corners and top centre; the two player
spawns flank the base.

openness   share of the 169 tiles left empty (docs/05-content-levels.md §4).
reach      share of the field each enemy spawn (left/centre/right) can work its
           way to, counting brick as traversable because it is destructible.
enemies    the 20-tank wave in spawn order; the 4th, 11th and 18th are carriers.
`;

const SHEET_RULE = '='.repeat(78);

/** The whole sheet, as a string. Pure: same levels in, same bytes out. */
export function renderContactSheet(levels: readonly AnnotatedLevel[]): string {
  const out: string[] = [SHEET_HEADER];
  for (const level of levels) {
    out.push(SHEET_RULE, ...renderLevel(level), '');
  }
  out.push(SHEET_RULE, ...renderSummary(levels), '');
  return out.join('\n');
}

function renderLevel(level: AnnotatedLevel): string[] {
  const a = analyseLevel(level);
  const lines: string[] = [];
  lines.push(
    `${level.id}  ${level.name}  [${level.provenance ?? 'unlabelled'}]`,
  );
  lines.push(
    `  openness ${pct(a.openness).padStart(6)}   ` +
      `reach ${a.spawnReach.map((r) => pct(r).padStart(6)).join(' ')}   ` +
      `base ${a.baseReachable ? 'reachable' : 'UNREACHABLE'}`,
  );
  lines.push(
    `  terrain  ` +
      ['B', 'S', 'W', 'T', 'I']
        .map((k) => `${k}:${String(a.terrainCounts[k]).padStart(3)}`)
        .join(' ') +
      `   partials ${String(level.partials?.length ?? 0).padStart(3)}`,
  );
  lines.push(`  enemies  ${enemyLine(level, a)}`);
  if (level.source !== undefined) {
    lines.push(`  source   ${level.source}`);
  }
  if (level.notes !== undefined) {
    lines.push(`  note     ${level.notes}`);
  }
  lines.push('');
  for (const row of a.subcellRows) {
    lines.push(`  ${row}`);
  }
  return lines;
}

const ENEMY_LETTER: Record<EnemyType, string> = {
  basic: 'b',
  fast: 'f',
  power: 'p',
  armor: 'a',
};

function enemyLine(level: AnnotatedLevel, a: LevelAnalysis): string {
  const counts = (['basic', 'fast', 'power', 'armor'] as const)
    .map((t) => `${String(a.enemyCounts[t]).padStart(2)} ${t}`)
    .join(' · ');
  const queue = level.enemies.map((e) => ENEMY_LETTER[e]).join('');
  return `${counts}   order ${queue}`;
}

function renderSummary(levels: readonly AnnotatedLevel[]): string[] {
  const lines = [
    'Summary',
    '',
    '  id          openness   min reach   basic fast power armor   provenance',
  ];
  for (const level of levels) {
    const a = analyseLevel(level);
    lines.push(
      `  ${level.id.padEnd(11)} ${pct(a.openness).padStart(7)}     ` +
        `${pct(a.minSpawnReach).padStart(7)}   ` +
        (['basic', 'fast', 'power', 'armor'] as const)
          .map((t) => String(a.enemyCounts[t]).padStart(5))
          .join(' ') +
        `   ${level.provenance ?? 'unlabelled'}`,
    );
  }
  return lines;
}
