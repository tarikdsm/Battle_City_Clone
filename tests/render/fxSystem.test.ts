// tests/render/fxSystem.test.ts — the pooled particle/light machinery (T4.1),
// in the Vitest **node** environment. Same reach as `propView.test.ts`: no DOM
// and no WebGL, so everything here is either a pure table, a pure curve or a
// `PointLight` — none of which needs a GL context.
//
// What is deliberately NOT here: whether an explosion *looks* like an
// explosion. This commit draws nothing at all — T4.2 adds the view and the
// recipes — and even once it does, pixels are the only honest way to ask.
//
// What IS here is the machinery a screenshot cannot check: that the pool never
// reallocates, that a full pool evicts the lowest-priority particle instead of
// growing or refusing, that the light pool holds art §6's cap of 8, that a
// preset drop halves both budgets *now* rather than eventually, and that a
// paused frame is a frozen frame.

import { describe, expect, it } from 'vitest';

import { PointLight } from 'three';

import {
  FX_KINDS,
  FX_LIGHTS,
  LIGHT_CAP,
  PARTICLE_CAP,
  createLightPool,
  createParticlePool,
  hash01,
  sizeFactorAt,
  tintFactorAt,
  type FxKind,
  type ParticlePool,
} from '../../src/render/fx/fxSystem';

/** Spawns one particle of `kind` at `priority`, with a life of `lifeMs`. */
function push(
  pool: ParticlePool,
  priority: number,
  kind: FxKind = 'debris',
  lifeMs = 1000,
): number {
  const p = pool.begin(kind, priority);
  p.lifeMs = lifeMs;
  return pool.emit();
}

/** Every live particle's priority, in slot order — the eviction assertions. */
function priorities(pool: ParticlePool): number[] {
  const out: number[] = [];
  for (let i = 0; i < pool.count; i++) {
    out.push(pool.data.priority[pool.data.live[i]]);
  }
  return out.sort((a, b) => a - b);
}
describe('particle pool — capacity and eviction (art §8)', () => {
  it('fills to its cap without evicting anything', () => {
    const pool = createParticlePool(8);
    for (let i = 0; i < 8; i++) {
      push(pool, 10 + i);
    }
    expect(pool.count).toBe(8);
    expect(pool.capacity).toBe(8);
    expect(priorities(pool)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('drops the LOWEST-priority live particle when full — never refuses', () => {
    const pool = createParticlePool(4);
    push(pool, 50);
    push(pool, 10); // the weakest
    push(pool, 40);
    push(pool, 30);
    expect(pool.count).toBe(4);

    // Art §8: "FxSystem drops lowest-priority when exceeded". The new particle
    // is admitted — refusing it would mean the loudest event on screen could be
    // silenced by a crowd of tree leaves.
    push(pool, 99);
    expect(pool.count).toBe(4);
    expect(priorities(pool)).toEqual([30, 40, 50, 99]);
  });

  it('breaks a priority tie by age — the oldest goes first', () => {
    const pool = createParticlePool(3);
    const first = push(pool, 20);
    push(pool, 20);
    push(pool, 20);
    push(pool, 20); // evicts `first`, which has been on screen longest
    expect(pool.count).toBe(3);
    // The slot is reused, so it is still live — but as the NEW particle, i.e.
    // with a fresh sequence number and a zero age.
    expect(pool.data.age[first]).toBe(0);
    expect(pool.data.seq[first]).toBe(3);
  });

  it('never grows, and never reallocates its arrays', () => {
    const pool = createParticlePool(16);
    // Capture the identities after a warm-up, then churn far past capacity.
    for (let i = 0; i < 16; i++) {
      push(pool, i);
    }
    const before = { ...pool.data };
    for (let i = 0; i < 5000; i++) {
      push(pool, (i * 7) % 100, FX_KINDS[i % FX_KINDS.length]);
      if (i % 13 === 0) pool.advance(400);
    }
    expect(pool.capacity).toBe(16);
    expect(pool.count).toBeLessThanOrEqual(16);
    // The proof of "zero steady-state allocation" a node test can actually
    // make: every typed array is the *same object* it was 5 000 spawns ago.
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      expect(pool.data[key], key).toBe(before[key]);
    }
  });

  it('reuses a retired slot rather than leaking it', () => {
    const pool = createParticlePool(2);
    const a = push(pool, 10, 'debris', 100);
    push(pool, 10, 'debris', 100);
    expect(pool.count).toBe(2);
    pool.advance(150); // both expire
    expect(pool.count).toBe(0);
    // Two more spawns must fit — a pool that lost the slots would evict here.
    const c = push(pool, 10);
    const d = push(pool, 10);
    expect(pool.count).toBe(2);
    expect(new Set([c, d]).size).toBe(2);
    expect([c, d]).toContain(a);
  });

  it('lowers the budget by evicting immediately, not by waiting', () => {
    // Art §7's Low row halves the particle budget; a preset drop is a request
    // for less work *now*, so 180 live particles cannot survive it.
    const pool = createParticlePool(PARTICLE_CAP.high);
    for (let i = 0; i < PARTICLE_CAP.high; i++) {
      push(pool, i);
    }
    expect(pool.count).toBe(PARTICLE_CAP.high);
    pool.setCap(PARTICLE_CAP.low);
    expect(pool.count).toBe(PARTICLE_CAP.low);
    // …and what survived is the important half.
    expect(Math.min(...priorities(pool))).toBe(
      PARTICLE_CAP.high - PARTICLE_CAP.low,
    );
    // The arrays are untouched — the budget moved, the allocation did not.
    expect(pool.capacity).toBe(PARTICLE_CAP.high);
  });

  it('halves at Low and stays whole at Medium (art §7)', () => {
    expect(PARTICLE_CAP.high).toBe(180); // art §8's "global cap ~180 (High)"
    expect(PARTICLE_CAP.low).toBe(PARTICLE_CAP.high / 2);
    // Art §7 names only the Low row: "particle budgets halved".
    expect(PARTICLE_CAP.medium).toBe(PARTICLE_CAP.high);
  });
});

describe('particle pool — integration (art §8)', () => {
  it('retires a particle exactly at the end of its life', () => {
    const pool = createParticlePool(4);
    push(pool, 1, 'debris', 700);
    pool.advance(699);
    expect(pool.count).toBe(1);
    pool.advance(1);
    expect(pool.count).toBe(0);
  });

  it('applies gravity and bounces exactly ONCE (art §8 brick chunks)', () => {
    const pool = createParticlePool(4);
    const p = pool.begin('debris', 50);
    p.y = 10;
    p.vy = 0;
    p.gravity = 600;
    p.bounce = true;
    p.lifeMs = 5000;
    const slot = pool.emit();

    // Fall to the board, frame by frame, watching for the one bounce: the
    // frame it happens on is the only frame where it is ON the board and
    // moving UP.
    let bounces = 0;
    for (let i = 0; i < 400; i++) {
      pool.advance(16);
      if (pool.data.y[slot] === 0 && pool.data.vy[slot] > 0) bounces++;
    }
    expect(bounces).toBe(1);

    // …and the second contact settles it rather than rippling forever.
    expect(pool.data.y[slot]).toBe(0);
    expect(pool.data.vy[slot]).toBe(0);
    expect(pool.data.vx[slot]).toBe(0);
  });

  it('does not advance a particle on a paused frame (art §9)', () => {
    // The rule T3.3 established for animation, applied to FX: the loop hands
    // the renderer a real dtMs even while frozen, and the board must not move.
    const pool = createParticlePool(4);
    const slot = push(pool, 1, 'debris', 1000);
    pool.advance(0);
    expect(pool.data.age[slot]).toBe(0);
    expect(pool.count).toBe(1);
  });
});

describe('per-kind envelopes', () => {
  it.each(FX_KINDS)('%s vanishes exactly at the end of its life', (kind) => {
    // No kind can fade by alpha (`InstancedMesh` has no per-instance alpha in
    // three 0.185.1), so every one has to reach zero SIZE or it pops.
    expect(sizeFactorAt(kind, 1)).toBe(0);
    expect(sizeFactorAt(kind, 1.5)).toBe(0);
  });

  it.each(FX_KINDS)('%s is fully present at birth', (kind) => {
    expect(sizeFactorAt(kind, 0)).toBeGreaterThan(0);
    expect(tintFactorAt(kind, 0)).toBe(1);
  });

  it('additive kinds fade their colour to nothing; blended kinds do not', () => {
    // An additive surface at colour 0 IS invisible, which is how a spark, a
    // ring and a flash disappear. A lit surface at colour 0 is a black hole in
    // the board, which is why smoke and debris keep their colour and shrink.
    for (const kind of ['spark', 'ring', 'flash'] as const) {
      expect(tintFactorAt(kind, 1), kind).toBe(0);
    }
    expect(tintFactorAt('debris', 0.99)).toBe(1);
    expect(tintFactorAt('smoke', 0.99)).toBeGreaterThan(0.5);
  });

  it('holds a debris chunk at full size for most of its life', () => {
    // Art §5's ice skid marks "fade in 2 s" and art §8's brick chunks live
    // 0.7 s: both ride this envelope, so it must not start shrinking early.
    expect(sizeFactorAt('debris', 0.5)).toBe(1);
    expect(sizeFactorAt('debris', 0.69)).toBe(1);
    expect(sizeFactorAt('debris', 0.85)).toBeLessThan(1);
  });

  it('puffs smoke out and back in', () => {
    const early = sizeFactorAt('smoke', 0.05);
    const peak = sizeFactorAt('smoke', 0.4);
    const late = sizeFactorAt('smoke', 0.9);
    expect(peak).toBeGreaterThan(early);
    expect(late).toBeLessThan(peak);
  });
});

describe('deterministic randomness', () => {
  it('is a pure function of (seed, index)', () => {
    expect(hash01(1234, 7)).toBe(hash01(1234, 7));
    expect(hash01(1234, 7)).not.toBe(hash01(1235, 7));
    expect(hash01(1234, 7)).not.toBe(hash01(1234, 8));
  });

  it('stays inside [0, 1) across a wide sweep', () => {
    let sum = 0;
    for (let i = 0; i < 4000; i++) {
      const v = hash01(i * 2654435761, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    // Not a statistics test — just enough to catch a hash that collapsed.
    expect(sum / 4000).toBeGreaterThan(0.4);
    expect(sum / 4000).toBeLessThan(0.6);
  });
});

describe('dynamic light pool (art §6)', () => {
  it('caps at 8 — art §6’s "max 8"', () => {
    expect(LIGHT_CAP.high).toBe(8);
    expect(LIGHT_CAP.medium).toBe(8);
    // Art §7's Low row: "lights pool halved".
    expect(LIGHT_CAP.low).toBe(4);
  });

  it('carries art §6’s ranges and durations verbatim', () => {
    expect(FX_LIGHTS.muzzle.range).toBe(40);
    expect(FX_LIGHTS.muzzle.ms).toBe(60);
    expect(FX_LIGHTS.explosion.range).toBe(90);
    expect(FX_LIGHTS.explosion.ms).toBe(400);
    expect(FX_LIGHTS.explosion.curve).toBe('quadratic'); // "quadratic decay"
    expect(FX_LIGHTS.baseExplosion.range).toBe(160);
    expect(FX_LIGHTS.baseExplosion.ms).toBe(1200);
    expect(FX_LIGHTS.powerupPulse.range).toBe(24);
    expect(FX_LIGHTS.powerupPulse.curve).toBe('sine');
    expect(FX_LIGHTS.spawnStar.range).toBe(30);
    // Art §8's steel row: "*clink* light 40 ms".
    expect(FX_LIGHTS.clink.ms).toBe(40);
  });

  it('fills to 8 and then evicts the least important', () => {
    const pool = createLightPool(8);
    for (let i = 0; i < 8; i++) {
      pool.acquire('muzzle', i, 0, 0, 1, 1, 1, true);
    }
    expect(pool.count).toBe(8);
    const base = pool.acquire('baseExplosion', 99, 0, 0, 1, 1, 1, true);
    expect(base).not.toBeNull();
    expect(pool.count).toBe(8); // still 8 — one muzzle flash lost its slot
    const live = pool.lights.filter((l) => l.visible);
    expect(live).toHaveLength(8);
    expect(live.some((l) => l.distance === FX_LIGHTS.baseExplosion.range)).toBe(
      true,
    );
  });

  it('lets the attached lights take a free slot but never steal one', () => {
    // Art §6's bullet glow is "tiny, attached" and is re-requested every frame;
    // if it could evict, a stream of bullets would push an explosion's own
    // light off the board.
    const pool = createLightPool(2);
    expect(pool.acquire('bulletGlow', 0, 0, 0, 1, 1, 1, false)).not.toBeNull();
    expect(pool.acquire('bulletGlow', 1, 0, 0, 1, 1, 1, false)).not.toBeNull();
    expect(pool.acquire('bulletGlow', 2, 0, 0, 1, 1, 1, false)).toBeNull();
    // …but a real event still gets through, by evicting one of them.
    expect(pool.acquire('explosion', 3, 0, 0, 1, 1, 1, true)).not.toBeNull();
  });

  it('releases a light at the end of its life and darkens it', () => {
    const pool = createLightPool(2);
    const light = pool.acquire('muzzle', 0, 0, 0, 1, 1, 1, true) as PointLight;
    expect(light.visible).toBe(true);
    expect(light.intensity).toBeGreaterThan(0);
    pool.advance(FX_LIGHTS.muzzle.ms + 1);
    expect(pool.count).toBe(0);
    expect(light.visible).toBe(false);
    expect(light.intensity).toBe(0);
  });

  it('decays the explosion light quadratically (art §6)', () => {
    const pool = createLightPool(1);
    const light = pool.acquire(
      'explosion',
      0,
      0,
      0,
      1,
      1,
      1,
      true,
    ) as PointLight;
    const peak = light.intensity;
    pool.advance(FX_LIGHTS.explosion.ms / 2);
    // Quadratic: half way through it is at a QUARTER, not a half.
    expect(light.intensity / peak).toBeCloseTo(0.25, 3);
  });

  it('freezes on a paused frame', () => {
    const pool = createLightPool(1);
    const light = pool.acquire(
      'explosion',
      0,
      0,
      0,
      1,
      1,
      1,
      true,
    ) as PointLight;
    const before = light.intensity;
    pool.advance(0);
    expect(pool.count).toBe(1);
    expect(light.intensity).toBe(before);
  });

  it('evicts down when the budget halves', () => {
    const pool = createLightPool(8);
    for (let i = 0; i < 8; i++) {
      pool.acquire(i < 4 ? 'bulletGlow' : 'explosion', i, 0, 0, 1, 1, 1, true);
    }
    expect(pool.count).toBe(8);
    pool.setCap(LIGHT_CAP.low);
    expect(pool.count).toBe(4);
    // The four that survived are the explosions, not the glows.
    for (const light of pool.lights.filter((l) => l.visible)) {
      expect(light.distance).toBe(FX_LIGHTS.explosion.range);
    }
  });
});
