// src/app/storage.ts — versioned localStorage persistence (arch §4.2).
//
// Rules that hold for every loader here: it never throws, it validates
// field-wise, and it never returns a half-typed object. A corrupt payload costs
// the player the corrupt field and nothing else — the game always boots.

import type { LevelData } from '../core/types';
import { validateLevel } from '../levels/schema';

const KEY_SAVE = 'bc.save.v1';
const KEY_SCORES = 'bc.scores.v1';
const KEY_SETTINGS = 'bc.settings.v1';
const KEY_CUSTOM_LEVELS = 'bc.customLevels.v1';

/** Campaign lengths (GDD §2): 35 original stages, 12 Neo stages. */
const MAX_STAGE = 35;
const MAX_NEO_STAGE = 12;
/** Arcade table size (GDD §8). */
const MAX_SCORES = 10;
/** Arcade initials are 3 characters. */
const MAX_INITIALS = 3;

export interface SaveV1 {
  highestStage: number;
  highestNeoStage: number;
}

export interface ScoreEntry {
  score: number;
  initials: string;
  stage: number;
}

export interface SettingsV1 {
  music: number;
  sfx: number;
  quality: 'auto' | 'low' | 'medium' | 'high';
  screenShake: boolean;
  reducedFlash: boolean;
  bindings: Record<string, string>;
}

const DEFAULT_SAVE: SaveV1 = { highestStage: 1, highestNeoStage: 1 };
const DEFAULT_SETTINGS: SettingsV1 = {
  music: 0.7,
  sfx: 0.8,
  quality: 'auto',
  screenShake: true,
  reducedFlash: false,
  bindings: {},
};
const QUALITIES: readonly string[] = ['auto', 'low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// localStorage access — every call site is wrapped. Private browsing, a full
// quota and a disabled-storage policy all surface as exceptions, and none of
// them may reach the game loop.
// ---------------------------------------------------------------------------

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined; // unreadable storage or corrupt JSON — same answer: defaults
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing sensible to do: losing a save beats crashing the game.
  }
}

// ---------------------------------------------------------------------------
// Field validators — each returns null for "not usable", never a coerced value.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return null;
  }
  return v as Record<string, unknown>;
}

function intInRange(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
    ? v
    : null;
}

/** A volume: a finite number in 0..1. `5` is not "loud", it is corrupt. */
function volume(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
    ? v
    : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function quality(v: unknown): SettingsV1['quality'] | null {
  return typeof v === 'string' && QUALITIES.includes(v)
    ? (v as SettingsV1['quality'])
    : null;
}

function bindings(v: unknown): Record<string, string> | null {
  const rec = asRecord(v);
  if (!rec) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [action, code] of Object.entries(rec)) {
    if (typeof code === 'string') {
      out[action] = code; // a non-string binding is dropped, the rest survive
    }
  }
  return out;
}

function scoreEntry(v: unknown): ScoreEntry | null {
  const rec = asRecord(v);
  if (!rec) {
    return null;
  }
  const score = intInRange(rec.score, 0, Number.MAX_SAFE_INTEGER);
  const stage = intInRange(rec.stage, 1, MAX_STAGE);
  const initials = rec.initials;
  if (
    score === null ||
    stage === null ||
    typeof initials !== 'string' ||
    initials.length === 0 ||
    initials.length > MAX_INITIALS
  ) {
    return null; // a score row is all-or-nothing: there is no sane partial row
  }
  return { score, initials, stage };
}

function topScores(entries: ScoreEntry[]): ScoreEntry[] {
  // Array.sort is stable, so equal scores keep their insertion order.
  return [...entries].sort((a, b) => b.score - a.score).slice(0, MAX_SCORES);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadSave(): SaveV1 {
  const rec = asRecord(readJson(KEY_SAVE));
  return {
    highestStage:
      intInRange(rec?.highestStage, 1, MAX_STAGE) ?? DEFAULT_SAVE.highestStage,
    highestNeoStage:
      intInRange(rec?.highestNeoStage, 1, MAX_NEO_STAGE) ??
      DEFAULT_SAVE.highestNeoStage,
  };
}

export function saveSave(v: SaveV1): void {
  writeJson(KEY_SAVE, {
    highestStage: v.highestStage,
    highestNeoStage: v.highestNeoStage,
  });
}

export function loadScores(): ScoreEntry[] {
  const raw = readJson(KEY_SCORES);
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: ScoreEntry[] = [];
  for (const item of raw) {
    const entry = scoreEntry(item);
    if (entry) {
      entries.push(entry);
    }
  }
  return topScores(entries);
}

export function saveScores(v: ScoreEntry[]): void {
  writeJson(KEY_SCORES, topScores(v));
}

export function loadSettings(): SettingsV1 {
  const rec = asRecord(readJson(KEY_SETTINGS));
  return {
    music: volume(rec?.music) ?? DEFAULT_SETTINGS.music,
    sfx: volume(rec?.sfx) ?? DEFAULT_SETTINGS.sfx,
    quality: quality(rec?.quality) ?? DEFAULT_SETTINGS.quality,
    screenShake: bool(rec?.screenShake) ?? DEFAULT_SETTINGS.screenShake,
    reducedFlash: bool(rec?.reducedFlash) ?? DEFAULT_SETTINGS.reducedFlash,
    bindings: bindings(rec?.bindings) ?? { ...DEFAULT_SETTINGS.bindings },
  };
}

export function saveSettings(v: SettingsV1): void {
  writeJson(KEY_SETTINGS, {
    music: v.music,
    sfx: v.sfx,
    quality: v.quality,
    screenShake: v.screenShake,
    reducedFlash: v.reducedFlash,
    bindings: v.bindings,
  });
}

export function loadCustomLevels(): LevelData[] {
  const raw = readJson(KEY_CUSTOM_LEVELS);
  if (!Array.isArray(raw)) {
    return [];
  }
  const levels: LevelData[] = [];
  for (const item of raw) {
    // Same validator the editor and the importer use: a level that would break
    // the sim never reaches it, whatever put it in storage.
    const result = validateLevel(item);
    if (result.ok) {
      levels.push(result.level);
    }
  }
  return levels;
}

export function saveCustomLevels(v: LevelData[]): void {
  // Written verbatim: the editor validates before saving, and silently dropping
  // a player's work here would be worse than storing a level it can flag later.
  writeJson(KEY_CUSTOM_LEVELS, v);
}
