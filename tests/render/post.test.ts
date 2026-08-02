// tests/render/post.test.ts — data-only, Vitest **node** environment. There is
// no DOM and no WebGL here, so nothing in this file builds a chain: it asserts
// the two things `post.ts` publishes as data — art §7's per-preset effect table
// and arch §5's auto-quality decision — plus the one behavioural rule that a
// preset switch depends on and that pixels cannot show you (disposal).
//
// What is deliberately NOT here: whether bloom actually blooms, what the
// vignette looks like, and what the chain costs. Those are pixels and
// milliseconds; they live in `npm run capture:post`
// (`docs/calibration/post.json`) and in the screenshot checklist.

import { describe, expect, it } from 'vitest';

import {
  ART7_BLOOM,
  ASSUMED_CORES,
  AUTO_THRESHOLDS,
  BLOOM_LAYER,
  GRADE,
  POST_PRESETS,
  concreteQuality,
  createSlot,
  decideAutoQuality,
  passChain,
  type DeviceSample,
  type PassKind,
  type PostPreset,
} from '../../src/render/post';
import { QUALITY_PRESETS, type Quality } from '../../src/render/materials';

// ---------------------------------------------------------------------------
// Art §7, transcribed. This table IS the spec — if the doc changes, change it
// here first and let the test go red.
//
// | Preset | Effects |
// |---|---|
// | High   | UnrealBloom (strength 0.55, radius 0.4, threshold 0.85) + SMAA +
// |        | vignette 0.25 + grade (teal shadows / warm highlights); DPR ≤ 2;
// |        | shadows on (2048) |
// | Medium | Bloom (0.4) + FXAA + vignette; DPR ≤ 1.5; shadows on (1024) |
// | Low    | FXAA only; DPR 1; shadows off |
//
// The threshold column is the one place the implementation deviates, and it
// deviates **loudly**: see the `ART7_BLOOM` block below.
// ---------------------------------------------------------------------------
interface Art7Row {
  readonly bloomStrength: number | null;
  readonly bloomRadius: number | null;
  readonly aa: 'smaa' | 'fxaa' | 'none';
  readonly vignette: number;
  readonly graded: boolean;
  readonly dprCap: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
}

const ART7: Readonly<Record<Quality, Art7Row>> = {
  high: {
    bloomStrength: 0.55,
    bloomRadius: 0.4,
    aa: 'smaa',
    vignette: 0.25,
    graded: true,
    dprCap: 2,
    shadows: true,
    shadowMapSize: 2048,
  },
  medium: {
    bloomStrength: 0.4,
    // §7 gives Medium a strength and nothing else; radius and vignette inherit
    // High's, which is the only reading that leaves the row implementable.
    bloomRadius: 0.4,
    aa: 'fxaa',
    vignette: 0.25,
    graded: false,
    dprCap: 1.5,
    shadows: true,
    shadowMapSize: 1024,
  },
  low: {
    bloomStrength: null,
    bloomRadius: null,
    aa: 'fxaa',
    vignette: 0,
    graded: false,
    dprCap: 1,
    shadows: false,
    shadowMapSize: 0,
  },
};

const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

describe('POST_PRESETS — art §7', () => {
  it('has exactly the three concrete presets', () => {
    expect(Object.keys(POST_PRESETS).sort()).toEqual(['high', 'low', 'medium']);
  });

  it.each(QUALITIES)('%s matches the doc row', (q) => {
    const preset: PostPreset = POST_PRESETS[q];
    const row = ART7[q];

    if (row.bloomStrength === null) {
      expect(preset.bloom).toBeNull();
    } else {
      expect(preset.bloom).not.toBeNull();
      expect(preset.bloom?.strength).toBe(row.bloomStrength);
      expect(preset.bloom?.radius).toBe(row.bloomRadius);
    }
    expect(preset.aa).toBe(row.aa);
    expect(preset.vignette).toBe(row.vignette);
    expect(preset.grade > 0).toBe(row.graded);
  });

  it.each(QUALITIES)('%s DPR cap and shadow map match the doc row', (q) => {
    // These live in `QUALITY_PRESETS` (materials.ts) because the renderer needs
    // them before a chain exists — but they are art §7's row too, and §7 is
    // mirrored here, so a doc change that moved only one of the two tables
    // would fail in this file rather than pass in both.
    expect(QUALITY_PRESETS[q].dprCap).toBe(ART7[q].dprCap);
    expect(QUALITY_PRESETS[q].shadows).toBe(ART7[q].shadows);
    expect(QUALITY_PRESETS[q].shadowMapSize).toBe(ART7[q].shadowMapSize);
  });

  it('is frozen, presets included', () => {
    expect(Object.isFrozen(POST_PRESETS)).toBe(true);
    for (const q of QUALITIES) {
      expect(Object.isFrozen(POST_PRESETS[q])).toBe(true);
    }
    expect(Object.isFrozen(POST_PRESETS.high.bloom)).toBe(true);
  });

  it('bloom strength is monotone with the preset ladder', () => {
    expect(POST_PRESETS.low.bloom).toBeNull();
    expect(POST_PRESETS.medium.bloom?.strength).toBeLessThan(
      POST_PRESETS.high.bloom?.strength ?? 0,
    );
  });
});

describe('the bloom threshold deviates from art §7, on purpose', () => {
  it('records the superseded doc value and the shipped one, and they differ', () => {
    expect(ART7_BLOOM.supersededThreshold).toBe(0.85);
    expect(ART7_BLOOM.shipped).toBe(0);
    expect(ART7_BLOOM.shipped).not.toBe(ART7_BLOOM.supersededThreshold);
    expect(ART7_BLOOM.reason).toMatch(/BLOOM_LAYER/);
  });

  it('every preset with bloom ships the measured value, not the doc one', () => {
    for (const q of QUALITIES) {
      const bloom = POST_PRESETS[q].bloom;
      if (bloom !== null) {
        expect(bloom.threshold).toBe(ART7_BLOOM.shipped);
      }
    }
  });

  it('selection is a layer, and it is not layer 0', () => {
    // Layer 0 is every object's default; a bloom layer that WAS 0 would put the
    // whole scene into the source pass, which is the "glows everything" failure
    // the layer approach exists to make impossible.
    expect(BLOOM_LAYER).toBeGreaterThan(0);
    expect(Number.isInteger(BLOOM_LAYER)).toBe(true);
    expect(BLOOM_LAYER).toBeLessThan(32);
  });
});

// `createPostChain` assembles the composer by iterating `passChain(preset)`, so
// these are assertions about the chain that ships rather than about a parallel
// re-statement of the same conditionals (T2.5 review).
describe('passChain — art §7 order', () => {
  const chains: Record<Quality, readonly PassKind[]> = {
    high: ['beauty', 'bloom', 'smaa', 'grade'],
    medium: ['beauty', 'bloom', 'fxaa', 'grade'],
    low: ['beauty', 'fxaa'],
  };

  it.each(QUALITIES)('%s assembles the documented passes in order', (q) => {
    expect(passChain(POST_PRESETS[q])).toEqual(chains[q]);
  });

  it('always starts from the beauty frame', () => {
    for (const q of QUALITIES) {
      expect(passChain(POST_PRESETS[q])[0]).toBe('beauty');
    }
  });

  it('drops the grade pass only when both halves are off', () => {
    const vignetteOnly: PostPreset = {
      bloom: null,
      aa: 'none',
      vignette: 0.25,
      grade: 0,
    };
    const gradeOnly: PostPreset = {
      bloom: null,
      aa: 'none',
      vignette: 0,
      grade: 1,
    };
    const neither: PostPreset = {
      bloom: null,
      aa: 'none',
      vignette: 0,
      grade: 0,
    };
    expect(passChain(vignetteOnly)).toEqual(['beauty', 'grade']);
    expect(passChain(gradeOnly)).toEqual(['beauty', 'grade']);
    expect(passChain(neither)).toEqual(['beauty']);
  });
});

describe('GRADE', () => {
  it('is multiplicative and slight — art §6 survives it by construction', () => {
    // Every art §6 target is a RATIO (rendered ÷ token, shadow ÷ lit), and a
    // per-channel multiply leaves every ratio between two samples of the same
    // colour untouched. "Slight" is the doc's word: ±5% per channel.
    for (const gain of [...GRADE.shadow, ...GRADE.highlight]) {
      expect(gain).toBeGreaterThan(0.94);
      expect(gain).toBeLessThan(1.06);
    }
  });

  it('cools the shadows and warms the highlights (art §7)', () => {
    // teal = blue up, red down; warm = the mirror image.
    expect(GRADE.shadow[2]).toBeGreaterThan(GRADE.shadow[0]);
    expect(GRADE.highlight[0]).toBeGreaterThan(GRADE.highlight[2]);
  });

  it('leaves the middle of the frame alone', () => {
    // The vignette only starts at `vignetteInner` of the way to the corner, so
    // the playfield's centre — where every §6 probe samples — is untouched.
    expect(GRADE.vignetteInner).toBeGreaterThan(0);
    expect(GRADE.vignetteInner).toBeLessThan(1);
  });
});

describe('decideAutoQuality — arch §5', () => {
  const sample = (fps: number, dpr: number, cores: number): DeviceSample => ({
    fps,
    dpr,
    cores,
  });

  it('the brief’s three cases', () => {
    expect(decideAutoQuality(sample(30, 2, 8))).toBe('low');
    expect(decideAutoQuality(sample(60, 2, 8))).toBe('high');
    expect(decideAutoQuality(sample(50, 2, 8))).toBe('medium');
  });

  it('pins the fps thresholds exactly', () => {
    expect(AUTO_THRESHOLDS.lowFps).toBe(45);
    expect(AUTO_THRESHOLDS.highFps).toBe(55);
    // Just below / exactly at each boundary.
    expect(decideAutoQuality(sample(44.99, 2, 8))).toBe('low');
    expect(decideAutoQuality(sample(45, 2, 8))).toBe('medium');
    expect(decideAutoQuality(sample(54.99, 2, 8))).toBe('medium');
    expect(decideAutoQuality(sample(55, 2, 8))).toBe('high');
  });

  it('pins the core requirement, and that it depends on DPR', () => {
    expect(AUTO_THRESHOLDS.hiDpr).toBe(2);
    expect(AUTO_THRESHOLDS.hiDprCores).toBe(8);
    expect(AUTO_THRESHOLDS.loDprCores).toBe(4);
    // A HiDPI device fills 4× the fragments, so it is asked for more cores.
    expect(decideAutoQuality(sample(60, 2, 7))).toBe('medium');
    expect(decideAutoQuality(sample(60, 2, 8))).toBe('high');
    // …and a 1× display gets High on half of them.
    expect(decideAutoQuality(sample(60, 1, 4))).toBe('high');
    expect(decideAutoQuality(sample(60, 1, 3))).toBe('medium');
    // DPR 3 is treated as HiDPI, not as a third tier.
    expect(decideAutoQuality(sample(60, 3, 8))).toBe('high');
    expect(decideAutoQuality(sample(60, 3, 7))).toBe('medium');
  });

  it('a slow sample outranks every other signal', () => {
    expect(decideAutoQuality(sample(20, 3, 32))).toBe('low');
    expect(decideAutoQuality(sample(0, 1, 1))).toBe('low');
  });

  it('only ever answers with a concrete preset', () => {
    for (const fps of [0, 30, 45, 55, 60, 144]) {
      for (const dpr of [1, 1.5, 2, 3]) {
        for (const cores of [1, 4, 8, 32]) {
          expect(QUALITIES).toContain(
            decideAutoQuality(sample(fps, dpr, cores)),
          );
        }
      }
    }
  });
});

describe('concreteQuality — the override rules', () => {
  it('the debug flag beats a stored setting', () => {
    expect(concreteQuality('low', 'high')).toBe('high');
    expect(concreteQuality('auto', 'low')).toBe('low');
  });

  it('a concrete stored setting skips the probe', () => {
    expect(concreteQuality('medium')).toBe('medium');
    expect(concreteQuality('high')).toBe('high');
    expect(concreteQuality('low')).toBe('low');
  });

  it('“auto” with no override is the only case that probes', () => {
    expect(concreteQuality('auto')).toBeNull();
    expect(concreteQuality('auto', undefined)).toBeNull();
  });

  it('assumes a modest core count when the browser hides it', () => {
    expect(ASSUMED_CORES).toBe(4);
  });
});

describe('createSlot — a preset switch must not leak', () => {
  const fake = (): { dispose(): void; disposed: number } => ({
    disposed: 0,
    dispose(): void {
      this.disposed++;
    },
  });

  it('disposes what it replaces', () => {
    const slot = createSlot<ReturnType<typeof fake>>();
    const a = fake();
    const b = fake();
    slot.set(a);
    expect(a.disposed).toBe(0);
    slot.set(b);
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(0);
    expect(slot.current).toBe(b);
  });

  it('does not dispose the occupant when it is re-set to itself', () => {
    const slot = createSlot<ReturnType<typeof fake>>();
    const a = fake();
    slot.set(a);
    slot.set(a);
    expect(a.disposed).toBe(0);
    expect(slot.current).toBe(a);
  });

  it('clear() disposes and empties, and is idempotent', () => {
    const slot = createSlot<ReturnType<typeof fake>>();
    const a = fake();
    slot.set(a);
    slot.clear();
    expect(a.disposed).toBe(1);
    expect(slot.current).toBeNull();
    slot.clear();
    expect(a.disposed).toBe(1);
  });

  it('an empty slot survives being cleared', () => {
    const slot = createSlot<ReturnType<typeof fake>>();
    expect(() => {
      slot.clear();
    }).not.toThrow();
    expect(slot.current).toBeNull();
  });

  it('a throwing dispose still empties the slot', () => {
    // The slot drops its reference BEFORE disposing, so a pass whose dispose()
    // throws cannot leave the chain holding a half-dead object it would then
    // try to render.
    const slot = createSlot<{ dispose(): void }>();
    const bad = {
      dispose(): void {
        throw new Error('boom');
      },
    };
    slot.set(bad);
    expect(() => {
      slot.set(null);
    }).toThrow('boom');
    expect(slot.current).toBeNull();
  });
});
