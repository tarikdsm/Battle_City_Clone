import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fixtureJson from '../fixtures/level-basic.json';
import type { LevelData } from '../../src/core/types';
import {
  loadCustomLevels,
  loadSave,
  loadScores,
  loadSettings,
  saveCustomLevels,
  saveSave,
  saveScores,
  saveSettings,
  type ScoreEntry,
} from '../../src/app/storage';

const fixtureLevel = fixtureJson as unknown as LevelData;

// The wire keys are part of the contract (a save must survive a reload), so
// they are spelled out here rather than imported from the module under test.
const KEYS = {
  save: 'bc.save.v1',
  scores: 'bc.scores.v1',
  settings: 'bc.settings.v1',
  customLevels: 'bc.customLevels.v1',
} as const;

// Node ships its own (warning-emitting) `localStorage` accessor; capture the
// descriptor up front and put it back after every test so nothing leaks.
const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install(impl: object): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: impl,
    configurable: true,
    writable: true,
  });
}

let store: Map<string, string>;

function installMemoryStorage(): void {
  store = new Map<string, string>();
  install({
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      store.set(k, v);
    },
    removeItem: (k: string): void => {
      store.delete(k);
    },
    clear: (): void => {
      store.clear();
    },
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    get length(): number {
      return store.size;
    },
  });
}

/** Private mode / quota exhausted: every access throws. */
function installThrowingStorage(): void {
  const boom = (): never => {
    throw new Error('QuotaExceededError');
  };
  install({
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    get length(): number {
      return boom();
    },
  });
}

const DEFAULT_SETTINGS = {
  music: 0.7,
  sfx: 0.8,
  quality: 'auto',
  screenShake: true,
  reducedFlash: false,
  bindings: {},
};

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  if (ORIGINAL) {
    Object.defineProperty(globalThis, 'localStorage', ORIGINAL);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('storage (arch §4.2)', () => {
  it('round-trips all four versioned keys', () => {
    saveSave({ highestStage: 12, highestNeoStage: 3 });
    saveScores([{ score: 4200, initials: 'TAR', stage: 9 }]);
    saveSettings({
      music: 0.25,
      sfx: 0,
      quality: 'high',
      screenShake: false,
      reducedFlash: true,
      bindings: { p1Fire: 'KeyJ' },
    });
    saveCustomLevels([fixtureLevel]);

    expect([...store.keys()].sort()).toEqual(
      [KEYS.save, KEYS.scores, KEYS.settings, KEYS.customLevels].sort(),
    );

    expect(loadSave()).toEqual({ highestStage: 12, highestNeoStage: 3 });
    expect(loadScores()).toEqual([{ score: 4200, initials: 'TAR', stage: 9 }]);
    expect(loadSettings()).toEqual({
      music: 0.25,
      sfx: 0,
      quality: 'high',
      screenShake: false,
      reducedFlash: true,
      bindings: { p1Fire: 'KeyJ' },
    });
    expect(loadCustomLevels()).toEqual([fixtureLevel]);
  });

  it('falls back to defaults on corrupt JSON in every key, without throwing', () => {
    for (const key of Object.values(KEYS)) {
      store.set(key, '{ this is not json');
    }

    expect(loadSave()).toEqual({ highestStage: 1, highestNeoStage: 1 });
    expect(loadScores()).toEqual([]);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadCustomLevels()).toEqual([]);
  });

  it('falls back field-wise: a bad volume does not cost the good one', () => {
    store.set(
      KEYS.settings,
      JSON.stringify({
        music: 'loud',
        sfx: 0.25,
        quality: 'medium',
        screenShake: false,
        reducedFlash: 'yes',
        bindings: { p1Fire: 'KeyJ', p2Fire: 7 },
      }),
    );

    expect(loadSettings()).toEqual({
      music: 0.7, // invalid type ⇒ default
      sfx: 0.25, // valid ⇒ kept
      quality: 'medium',
      screenShake: false,
      reducedFlash: false, // invalid type ⇒ default
      bindings: { p1Fire: 'KeyJ' }, // non-string binding dropped
    });
  });

  it('rejects out-of-range numbers', () => {
    store.set(KEYS.settings, JSON.stringify({ music: 5, sfx: -1 }));
    const settings = loadSettings();
    expect(settings.music).toBe(0.7);
    expect(settings.sfx).toBe(0.8);

    store.set(
      KEYS.save,
      JSON.stringify({ highestStage: -3, highestNeoStage: 2.5 }),
    );
    expect(loadSave()).toEqual({ highestStage: 1, highestNeoStage: 1 });
  });

  it('keeps the top 10 scores sorted descending', () => {
    const entries: ScoreEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      entries.push({ score: i * 100, initials: `P${i}`, stage: i });
    }
    saveScores(entries);

    const loaded = loadScores();
    expect(loaded).toHaveLength(10);
    expect(loaded[0]).toEqual({ score: 1200, initials: 'P12', stage: 12 });
    expect(loaded.at(-1)?.score).toBe(300);
    expect(loaded.map((e) => e.score)).toEqual(
      [...loaded.map((e) => e.score)].sort((a, b) => b - a),
    );
  });

  it('drops malformed score entries and non-array payloads', () => {
    store.set(KEYS.scores, JSON.stringify({ nope: true }));
    expect(loadScores()).toEqual([]);

    store.set(
      KEYS.scores,
      JSON.stringify([
        { score: 100, initials: 'AAA', stage: 1 },
        { score: 'lots', initials: 'BBB', stage: 2 },
        null,
        { score: 300, initials: 4, stage: 3 },
      ]),
    );
    expect(loadScores()).toEqual([{ score: 100, initials: 'AAA', stage: 1 }]);
  });

  it('drops custom levels that fail schema validation', () => {
    store.set(
      KEYS.customLevels,
      JSON.stringify([fixtureLevel, { version: 1, id: 'broken' }, 42]),
    );
    expect(loadCustomLevels()).toEqual([fixtureLevel]);
  });

  it('survives a localStorage that throws on every access', () => {
    installThrowingStorage();

    expect(loadSave()).toEqual({ highestStage: 1, highestNeoStage: 1 });
    expect(loadScores()).toEqual([]);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadCustomLevels()).toEqual([]);

    expect(() => {
      saveSave({ highestStage: 4, highestNeoStage: 1 });
    }).not.toThrow();
    expect(() => {
      saveScores([{ score: 1, initials: 'AAA', stage: 1 }]);
    }).not.toThrow();
    expect(() => {
      saveSettings(loadSettings());
    }).not.toThrow();
    expect(() => {
      saveCustomLevels([fixtureLevel]);
    }).not.toThrow();
  });
});
