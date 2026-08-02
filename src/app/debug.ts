// src/app/debug.ts — URL debug flags (arch §12).
//
// Dev builds only. `isDev` is a parameter rather than a module-level constant so
// this file stays pure and testable; `main.ts` passes `import.meta.env.DEV`,
// which Vite folds to the literal `false` in a production bundle (verified:
// the built call reads `parseDebugFlags(location.search, !1)`). The guard below
// then short-circuits before a single query parameter is read, so no URL can
// turn a debug facility on in a shipped build.

/** Stage count of the original campaign (GDD §2). */
const MAX_STAGE = 35;
/** Enemies per stage (fidelity §3.2). The `?enemies=` ceiling. */
const ENEMY_TOTAL = 20;
const QUALITIES: readonly string[] = ['low', 'medium', 'high'];
/** Query values that read as "off" for a switch-style flag. */
const OFF_VALUES: readonly string[] = ['0', 'false', 'off', 'no'];

export interface DebugFlags {
  stage?: number;
  seed?: number;
  quality?: 'low' | 'medium' | 'high';
  overlay: boolean;
  /**
   * Shorten the stage's enemy queue to `n` (1…20).
   *
   * A **content** knob, not a rules knob: it truncates `LevelData.enemies`
   * before `createGame` ever sees it, so every rule in fidelity §7 still holds
   * exactly — the cadence formula, the 4-enemy cap, the carrier ordinals and
   * the "cleared when the pool is empty and the field is clear" test are all
   * untouched, they simply have fewer tanks to run against.
   *
   * It exists because the stage-clear beat and the tally screen (fidelity
   * §11.2) are otherwise 20 kills away, which no capture script or manual
   * check can reach in reasonable time — and a screen nobody can look at is a
   * screen nobody can review. Dev-only, like every flag here.
   */
  enemies?: number;
}

export function parseDebugFlags(search: string, isDev: boolean): DebugFlags {
  // Production: no parsing at all, so nothing in the URL can change the build.
  if (!isDev) {
    return { overlay: false };
  }

  const params = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const flags: DebugFlags = { overlay: switchFlag(params.get('overlay')) };

  const stage = integer(params.get('stage'));
  if (stage !== null && stage >= 1 && stage <= MAX_STAGE) {
    flags.stage = stage;
  }

  const enemies = integer(params.get('enemies'));
  if (enemies !== null && enemies >= 1 && enemies <= ENEMY_TOTAL) {
    flags.enemies = enemies;
  }

  const seed = integer(params.get('seed'));
  if (seed !== null) {
    flags.seed = seed;
  }

  const quality = params.get('quality');
  if (quality !== null && QUALITIES.includes(quality)) {
    flags.quality = quality as DebugFlags['quality'];
  }

  return flags;
}

/**
 * An invalid value is ignored rather than defaulted — `?stage=abc` must leave
 * the campaign alone, not silently start stage 1.
 */
function integer(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** Present with no value (`?overlay`) counts as on; `?overlay=0` as off. */
function switchFlag(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  return !OFF_VALUES.includes(raw.toLowerCase());
}
