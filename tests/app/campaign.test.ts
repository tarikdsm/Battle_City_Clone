// tests/app/campaign.test.ts — the two campaigns, and the rules that differ
// between them (GDD §4, content §3, fidelity §11.5).
//
// This file exists because of a two-phase silence. T8.3 authored twelve Neo
// stages — validated, completability-checked, committed — and nothing routed a
// run through them, so `neoStage()` was a function no caller ever called and
// `SaveV1.highestNeoStage` was a field nothing ever wrote. Every test passed the
// whole time, because none of them asked whether the content was reachable.
//
// So the assertions below are deliberately about REACHABILITY and about the
// three places the campaigns genuinely differ: they have different lengths, one
// loops and one ends, and their spawn pressure comes from different places.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceStage,
  cadenceStageOf,
  campaignComplete,
  campaignLength,
  campaignLoops,
  createSession,
  highestReached,
  levelStageOf,
  stageLabelOf,
  unlockNeoStage,
  unlockReached,
  unlockStage,
  STAGE_LOOP,
} from '../../src/app/session';
import {
  NEO_STAGE_COUNT,
  neoEffectiveStage,
  neoStage,
} from '../../src/levels/campaign';

function installStorage(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
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
  };
}

beforeEach(() => {
  installStorage();
});

describe('campaign shapes', () => {
  it('has the two campaigns content §3 promises, at their stated lengths', () => {
    expect(campaignLength('original')).toBe(STAGE_LOOP);
    expect(campaignLength('original')).toBe(35);
    expect(campaignLength('neo')).toBe(NEO_STAGE_COUNT);
    expect(campaignLength('neo')).toBe(12);
  });

  it('loops the originals and ends the Neo campaign', () => {
    // Fidelity §11.5 is explicit that the NES loops after 35. Twelve authored
    // stages have an order and an end, and dropping the player into stage 1 of
    // a DIFFERENT campaign would read as a bug rather than as a victory.
    expect(campaignLoops('original')).toBe(true);
    expect(campaignLoops('neo')).toBe(false);
  });
});

describe('stage labels', () => {
  it('loops the original campaign past 35', () => {
    const s = createSession({ campaign: 'original', stageNumber: 36 });
    expect(stageLabelOf(s)).toBe(1);
    expect(levelStageOf(36)).toBe(1);
  });

  it('counts the Neo campaign straight through, without wrapping', () => {
    for (const n of [1, 2, 7, 12]) {
      expect(
        stageLabelOf(createSession({ campaign: 'neo', stageNumber: n })),
      ).toBe(n);
    }
  });

  it('clamps a finished Neo run to its last stage rather than off the table', () => {
    // `campaignComplete` is handled by the flow one beat later, and a label read
    // in between must not index past neo12.
    const done = createSession({ campaign: 'neo', stageNumber: 13 });
    expect(stageLabelOf(done)).toBe(12);
    expect(() => neoStage(stageLabelOf(done))).not.toThrow();
  });
});

describe('campaignComplete', () => {
  it('is never true for the looping campaign, however far it runs', () => {
    const s = createSession({ campaign: 'original', stageNumber: 1 });
    for (let i = 0; i < 40; i++) {
      expect(campaignComplete(s)).toBe(false);
      advanceStage(s);
    }
  });

  it('turns true exactly one advance past the twelfth Neo stage', () => {
    const s = createSession({ campaign: 'neo', stageNumber: 1 });
    for (let n = 1; n <= NEO_STAGE_COUNT; n++) {
      expect(campaignComplete(s), `on neo-${n}`).toBe(false);
      advanceStage(s);
    }
    expect(campaignComplete(s)).toBe(true);
  });
});

describe('spawn cadence per campaign (fidelity §7, content §4)', () => {
  it('hands core the rising counter for the originals', () => {
    // Uncapped on purpose: `spawnIntervalTicks` caps its own stage term, so
    // stage 36 must not play like stage 1.
    const s = createSession({ campaign: 'original', stageNumber: 40 });
    expect(cadenceStageOf(s)).toBe(40);
  });

  it("takes a Neo stage's pressure from its own file, not its position", () => {
    for (let n = 1; n <= NEO_STAGE_COUNT; n++) {
      const s = createSession({ campaign: 'neo', stageNumber: n });
      expect(cadenceStageOf(s)).toBe(neoEffectiveStage(n));
    }
  });

  it('puts the Neo campaign in the originals’ late difficulty band', () => {
    // Content §3's whole premise: twelve stages that play like the back half of
    // the original 35 rather than like its first twelve.
    const pressures = Array.from({ length: NEO_STAGE_COUNT }, (_, i) =>
      neoEffectiveStage(i + 1),
    );
    for (const p of pressures) {
      expect(p).toBeGreaterThanOrEqual(15);
      expect(p).toBeLessThanOrEqual(STAGE_LOOP);
    }
    // And it builds rather than wandering: the last stage is the hardest.
    expect(pressures[pressures.length - 1]).toBe(Math.max(...pressures));
  });
});

describe('progress is tracked per campaign', () => {
  it('starts both campaigns at stage 1', () => {
    expect(highestReached('original')).toBe(1);
    expect(highestReached('neo')).toBe(1);
  });

  it('keeps the two unlock lists apart', () => {
    // The bug this prevents is one field for two campaigns: clearing neo-03
    // must not hand the player original stage 3, and vice versa.
    unlockStage(20);
    expect(highestReached('original')).toBe(20);
    expect(highestReached('neo')).toBe(1);

    unlockNeoStage(4);
    expect(highestReached('neo')).toBe(4);
    expect(highestReached('original')).toBe(20);
  });

  it('routes through unlockReached by campaign', () => {
    unlockReached('neo', 6);
    expect(highestReached('neo')).toBe(6);
    expect(highestReached('original')).toBe(1);

    unlockReached('original', 9);
    expect(highestReached('original')).toBe(9);
    expect(highestReached('neo')).toBe(6);
  });

  it('is monotonic, and clamped to each campaign’s length', () => {
    unlockReached('neo', 9);
    unlockReached('neo', 3); // going backwards must not relock
    expect(highestReached('neo')).toBe(9);
    unlockReached('neo', 99); // past the end of the campaign
    expect(highestReached('neo')).toBe(NEO_STAGE_COUNT);
    unlockReached('original', 999);
    expect(highestReached('original')).toBe(STAGE_LOOP);
  });
});

describe('every Neo stage is actually loadable', () => {
  // The cheapest possible guard against the failure this whole file exists for.
  // `neoStage` validates, so a file that drifted out of schema throws here.
  it('loads all twelve and gives each a distinct id', () => {
    const ids = new Set<string>();
    for (let n = 1; n <= NEO_STAGE_COUNT; n++) {
      const level = neoStage(n);
      expect(level.terrain).toHaveLength(13);
      expect(level.enemies).toHaveLength(20);
      ids.add(level.id);
    }
    expect(ids.size).toBe(NEO_STAGE_COUNT);
  });
});
