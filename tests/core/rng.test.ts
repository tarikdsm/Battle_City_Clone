import { describe, expect, it } from 'vitest';
import { createRng, nextFloat, nextInt } from '../../src/core/rng';

describe('rng (mulberry32)', () => {
  it('produces a frozen float snapshot for seed 12345', () => {
    // Recorded literals from the reference mulberry32 algorithm. The point is
    // bit-exact cross-run / cross-platform reproducibility, not any specific magic
    // value — if these ever change, determinism (and golden replays) have broken.
    const rng = createRng(12345);
    expect(nextFloat(rng)).toBe(0.9797282677609473);
    expect(nextFloat(rng)).toBe(0.3067522644996643);
    expect(nextFloat(rng)).toBe(0.484205421525985);
  });

  it('is repeatable across two independent instances of the same seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 100; i++) {
      expect(nextFloat(a)).toBe(nextFloat(b));
    }
  });

  it('stores plain-data state that advances on each draw', () => {
    const rng = createRng(999);
    expect(rng.s).toBe(999); // createRng seeds the state verbatim (int32)
    const first = nextFloat(rng);
    expect(rng.s).not.toBe(999); // state mutated by the draw
    // A fresh instance reproduces the same first draw.
    expect(nextFloat(createRng(999))).toBe(first);
  });

  it('nextInt(n) yields integers in [0, n)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i++) {
      const v = nextInt(rng, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
    }
  });

  it('nextInt(4) is approximately uniform — each bucket within +/-5%', () => {
    // NOTE: the brief specified 4000 draws, but at N=4000 a hard +/-5% per-bucket
    // bound is only ~1.8 sigma (std err ~= sqrt(N*0.25*0.75)/N ~= 1.4%), so a
    // sound PRNG is *expected* to breach it for some seeds — seed 12345 lands at
    // -5.4%. N=10000 makes +/-5% a comfortable ~2.9 sigma bound (observed max 1.8%).
    const rng = createRng(12345);
    const n = 10000;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) counts[nextInt(rng, 4)]++;
    const expected = n / 4;
    for (const c of counts) {
      expect(Math.abs(c - expected) / expected).toBeLessThanOrEqual(0.05);
    }
  });
});
