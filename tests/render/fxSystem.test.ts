// tests/render/fxSystem.test.ts — the pooled particle/light machinery (T4.1),
// in the Vitest **node** environment. Same reach as `propView.test.ts`: no DOM
// and no WebGL, so everything here is either a pure table, a pure curve, an
// `InstancedMesh` or a `PointLight` — none of which needs a GL context.
//
// What is deliberately NOT here: whether an explosion *looks* like an
// explosion. That is `scripts/capture-fx.ts`'s question, and pixels are the
// only honest way to ask it.
//
// What IS here is the machinery a screenshot cannot check: that the pool never
// reallocates, that a full pool evicts the lowest-priority particle instead of
// growing or refusing, that the light pool holds art §6's cap of 8, that a
// preset drop halves both budgets *now* rather than eventually, and that a
// paused frame is a frozen frame.

import { describe, expect, it } from 'vitest';

import { InstancedMesh, PointLight } from 'three';

import { createGame } from '../../src/core/game';
import type { GameState, LevelData } from '../../src/core/types';
import { createMaterials, type Materials } from '../../src/render/materials';
import { createSceneRoot, type SceneRoot } from '../../src/render/sceneRoot';
import {
  DEFAULT_FX_FLAGS,
  FX_KINDS,
  FX_LIGHTS,
  LIGHT_CAP,
  PARTICLE_CAP,
  createFxSystem,
  createLightPool,
  createParticlePool,
  hash01,
  sizeFactorAt,
  tintFactorAt,
  type FxKind,
  type FxSystem,
  type ParticlePool,
} from '../../src/render/fx/fxSystem';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

function game(): GameState {
  return createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 });
}

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

interface Mounted {
  fx: FxSystem;
  materials: Materials;
  root: SceneRoot;
  meshes: InstancedMesh[];
  dispose(): void;
}

function mount(): Mounted {
  const materials = createMaterials();
  const root = createSceneRoot(materials);
  const fx = createFxSystem(materials, root, { ...DEFAULT_FX_FLAGS });
  const meshes: InstancedMesh[] = [];
  root.entities.traverse((o) => {
    if (o instanceof InstancedMesh) meshes.push(o);
  });
  return {
    fx,
    materials,
    root,
    meshes,
    dispose(): void {
      fx.dispose();
      root.dispose();
      materials.dispose();
    },
  };
}

// ---------------------------------------------------------------------------

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
  it('stays inside art §6’s "max 8" and halves for Low (art §7)', () => {
    // Six, not eight: the eighth resident light is a measured cliff on the
    // reference machine (+1.1 ms of frame CPU, ~half the delivered frame rate)
    // and "max 8" is a ceiling. The table is in `LIGHT_CAP`'s own doc and in
    // `docs/calibration/fx.json`.
    expect(LIGHT_CAP.high).toBeLessThanOrEqual(8);
    expect(LIGHT_CAP.high).toBe(6);
    expect(LIGHT_CAP.medium).toBe(LIGHT_CAP.high);
    // Art §7's Low row: "lights pool halved".
    expect(LIGHT_CAP.low).toBe(LIGHT_CAP.high / 2);
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
    const live = pool.lights.filter((l) => l.intensity > 0);
    expect(live).toHaveLength(8);
    expect(live.some((l) => l.distance === FX_LIGHTS.baseExplosion.range)).toBe(
      true,
    );
  });

  it('never hides a light — it darkens it (the 1.4 s stall)', () => {
    // `WebGLRenderer.projectObject` skips an invisible object, so a hidden
    // light leaves `lights.state` and `numPointLights` drops — and that number
    // is part of `programCacheKey`, so every material recompiles on the
    // flicker. Measured: mean frame time 2.0 ms → 11.9 ms with a **1394 ms**
    // worst frame, on the first `capture:fx` run. Intensity is a uniform;
    // visibility is a program.
    const pool = createLightPool(4);
    const before = pool.lights.map((l) => l.visible);
    pool.acquire('explosion', 0, 0, 0, 1, 1, 1, true);
    pool.advance(FX_LIGHTS.explosion.ms + 1);
    pool.acquire('muzzle', 0, 0, 0, 1, 1, 1, true);
    pool.clear();
    expect(pool.lights.map((l) => l.visible)).toEqual(before);
    expect(pool.lights.every((l) => l.visible)).toBe(true);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
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
    expect(light.intensity).toBeGreaterThan(0);
    pool.advance(FX_LIGHTS.muzzle.ms + 1);
    expect(pool.count).toBe(0);
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
    const full = LIGHT_CAP.high;
    const half = LIGHT_CAP.low;
    const pool = createLightPool(full);
    for (let i = 0; i < full; i++) {
      // The weakest half are bullet glows, so the survivors are predictable.
      pool.acquire(
        i < full - half ? 'bulletGlow' : 'explosion',
        i,
        0,
        0,
        1,
        1,
        1,
        true,
      );
    }
    expect(pool.count).toBe(full);
    pool.setCap(half);
    expect(pool.count).toBe(half);
    // What survived is the explosions, not the glows.
    for (const light of pool.lights.filter((l) => l.intensity > 0)) {
      expect(light.distance).toBe(FX_LIGHTS.explosion.range);
    }
  });
});

describe('FxSystem — the assembled layer', () => {
  it('is five instanced meshes, one per particle kind', () => {
    // Art §8's ~180-particle cap has to cost a handful of draw calls, not 180.
    const m = mount();
    expect(m.meshes).toHaveLength(FX_KINDS.length);
    expect(new Set(m.meshes.map((mesh) => mesh.material)).size).toBe(
      FX_KINDS.length,
    );
    for (const mesh of m.meshes) {
      // Every one is registered, so the shadow-recompile sweep and disposal
      // reach it (the rule `materials.test.ts` pins for the whole layer).
      expect(m.materials.all).toContain(mesh.material);
      // A particle that casts a shadow puts its kind in the shadow pass too.
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(false);
      expect(mesh.instanceMatrix.count).toBe(PARTICLE_CAP.high);
    }
    m.dispose();
  });

  it.each(['ring', 'flash'] as const)(
    'winds the flat %s to face the camera, not the floor',
    (kind) => {
      // The bug this pins cost a whole capture round: both flat kinds were
      // wound the "obvious" way — angle increasing from +x toward +z — which
      // puts the geometric normal at **−y**, and `FrontSide` then culls them
      // against art §2's overhead camera. Every shockwave in art §8 was simply
      // absent, and nothing failed: the `normal` attribute said +y, but
      // `MeshBasicMaterial` never reads it and culling does not care.
      const m = mount();
      const mesh = m.meshes[FX_KINDS.indexOf(kind)];
      const p = mesh.geometry.getAttribute('position');
      expect(p.count).toBeGreaterThan(0);
      expect(p.count % 3).toBe(0);
      for (let i = 0; i < p.count; i += 3) {
        const ax = p.getX(i);
        const az = p.getZ(i);
        // Only the y component of the cross product matters for a flat piece.
        const ny =
          (p.getZ(i + 1) - az) * (p.getX(i + 2) - ax) -
          (p.getX(i + 1) - ax) * (p.getZ(i + 2) - az);
        expect(ny, `${kind} triangle ${i / 3}`).toBeGreaterThan(0);
      }
      m.dispose();
    },
  );

  it('draws nothing at all until something happens', () => {
    const m = mount();
    m.fx.update(game(), 16);
    for (const mesh of m.meshes) {
      expect(mesh.count).toBe(0);
    }
    expect(m.fx.stats().activeKinds).toBe(0);
    m.dispose();
  });

  it('puts art §6’s eight lights in the scene and no more', () => {
    const m = mount();
    const lights: PointLight[] = [];
    m.root.scene.traverse((o) => {
      if (o instanceof PointLight) lights.push(o);
    });
    expect(lights).toHaveLength(LIGHT_CAP.high);
    for (const light of lights) {
      // A shadow-casting point light is six extra render passes each.
      expect(light.castShadow).toBe(false);
    }
    m.dispose();
  });

  it('drops to four resident lights on Low and back up again', () => {
    const m = mount();
    const count = (): number => {
      let n = 0;
      m.root.scene.traverse((o) => {
        if (o instanceof PointLight) n++;
      });
      return n;
    };
    expect(count()).toBe(LIGHT_CAP.high);
    m.fx.setQuality('low');
    // Removed from the scene, not merely darkened: three compiles
    // NUM_POINT_LIGHTS into every program, so eight idle lights would still
    // cost eight iterations per fragment on the preset that can least afford it.
    expect(count()).toBe(LIGHT_CAP.low);
    m.fx.setQuality('high');
    expect(count()).toBe(LIGHT_CAP.high);
    m.dispose();
  });

  it('freezes every particle while the simulation is paused', () => {
    const m = mount();
    const state = game();
    m.fx.onEvent({
      t: 'brickHit',
      tx: 3,
      ty: 3,
      removedMask: 3,
      x: 50,
      y: 50,
      dir: 0,
    });
    m.fx.update(state, 16);
    const live = m.fx.stats().particles;
    expect(live).toBeGreaterThan(0);

    state.paused = true;
    for (let i = 0; i < 200; i++) {
      m.fx.update(state, 16); // 3.2 s of real time — every particle has expired
    }
    expect(m.fx.stats().particles).toBe(live);

    state.paused = false;
    for (let i = 0; i < 200; i++) {
      m.fx.update(state, 16);
    }
    expect(m.fx.stats().particles).toBe(0);
    m.dispose();
  });

  it('holds the global cap however hard the board is hit', () => {
    const m = mount();
    const state = game();
    for (let i = 0; i < 400; i++) {
      m.fx.onEvent({
        t: 'tankDestroyed',
        tankId: 5,
        kind: 'enemy',
        enemyType: 'basic',
        points: 100,
        x: (i * 17) % 200,
        y: (i * 29) % 200,
      });
      if (i % 5 === 0) m.fx.update(state, 16);
    }
    m.fx.update(state, 16);
    expect(m.fx.stats().particles).toBeLessThanOrEqual(PARTICLE_CAP.high);
    // …and it is still five meshes, not 180.
    expect(m.fx.stats().activeKinds).toBeLessThanOrEqual(FX_KINDS.length);
    let drawn = 0;
    for (const mesh of m.meshes) {
      drawn += mesh.count;
      expect(mesh.count).toBeLessThanOrEqual(mesh.instanceMatrix.count);
    }
    expect(drawn).toBe(m.fx.stats().particles);
    m.dispose();
  });

  it('lights the power-up while it is on the field, and not after', () => {
    // Art §6's "power-up idle pulse", the seam `propView.ts` left open.
    const m = mount();
    const state = game();
    state.powerup = { type: 'star', x: 64, y: 64 };
    m.fx.update(state, 16);
    expect(m.fx.stats().lights).toBeGreaterThan(0);
    state.powerup = null;
    m.fx.update(state, 16);
    m.fx.update(state, 16);
    expect(m.fx.stats().lights).toBe(0);
    m.dispose();
  });

  it('smokes from the ruined eagle until a stage puts it back', () => {
    // Art §4's "destroyed → … smoke wisps", the other seam.
    const m = mount();
    const state = game();
    state.eagleAlive = false;
    m.fx.onEvent({ t: 'baseDestroyed' });
    // The one-shot explosion, then the continuing wisps.
    m.fx.update(state, 16);
    const afterBlast = m.fx.stats().particles;
    expect(afterBlast).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) {
      m.fx.update(state, 16);
    }
    // Long past the explosion, something is still coming off the wreck.
    expect(m.fx.stats().particles).toBeGreaterThan(0);

    state.eagleAlive = true;
    for (let i = 0; i < 200; i++) {
      m.fx.update(state, 16);
    }
    expect(m.fx.stats().particles).toBe(0);
    m.dispose();
  });

  it('suppresses the screen flash under either accessibility flag', () => {
    // Art §11: "…no screen flash; **all gameplay information preserved**".
    const state = game();
    const death = {
      t: 'tankDestroyed' as const,
      tankId: 0,
      kind: 'player' as const,
      points: 0,
      x: 80,
      y: 80,
    };

    const plain = mount();
    plain.fx.onEvent(death);
    plain.fx.update(state, 16);
    const withFlash = plain.materials.fxScreenFlash.opacity;
    const particles = plain.fx.stats().particles;
    expect(withFlash).toBeGreaterThan(0);
    plain.dispose();

    for (const flags of [
      { reducedMotion: true, reducedFlash: false },
      { reducedMotion: false, reducedFlash: true },
    ]) {
      const m = mount();
      m.fx.setFlags(flags);
      m.fx.onEvent(death);
      m.fx.update(state, 16);
      expect(m.materials.fxScreenFlash.opacity).toBe(0);
      // Every particle the same recipe emits still spawns: the flag removes the
      // full-frame blast, not the information that a tank just died.
      expect(m.fx.stats().particles).toBe(particles);
      m.dispose();
    }
  });

  it('halves both budgets on Low (art §7)', () => {
    const m = mount();
    const state = game();
    m.fx.setQuality('low');
    for (let i = 0; i < 60; i++) {
      m.fx.onEvent({
        t: 'tankDestroyed',
        tankId: 5,
        kind: 'enemy',
        enemyType: 'armor',
        points: 400,
        x: (i * 13) % 200,
        y: (i * 31) % 200,
      });
    }
    m.fx.update(state, 16);
    expect(m.fx.stats().particles).toBeLessThanOrEqual(PARTICLE_CAP.low);
    expect(m.fx.stats().lights).toBeLessThanOrEqual(LIGHT_CAP.low);
    m.dispose();
  });

  it('gives the same event the same spray twice', () => {
    // The property `scripts/capture-fx.ts` rests on: a screenshot harness
    // cannot compare two runs of a frame it cannot re-derive.
    const positions = (m: Mounted): number[] => {
      const out: number[] = [];
      const mesh = m.meshes[0];
      for (let i = 0; i < mesh.count * 16; i++) {
        out.push((mesh.instanceMatrix.array as Float32Array)[i]);
      }
      return out;
    };
    const hit = {
      t: 'brickHit' as const,
      tx: 4,
      ty: 7,
      removedMask: 5,
      x: 70,
      y: 118,
      dir: 1 as const,
    };
    const a = mount();
    a.fx.onEvent(hit);
    a.fx.update(game(), 16);
    const first = positions(a);
    a.dispose();

    const b = mount();
    b.fx.onEvent(hit);
    b.fx.update(game(), 16);
    expect(positions(b)).toEqual(first);
    b.dispose();

    // …and a different brick shatters differently.
    const c = mount();
    c.fx.onEvent({ ...hit, tx: 5, x: 86 });
    c.fx.update(game(), 16);
    expect(positions(c)).not.toEqual(first);
    c.dispose();
  });

  it('disposes cleanly, taking its lights out of the scene', () => {
    const m = mount();
    m.fx.dispose();
    let lights = 0;
    let meshes = 0;
    m.root.scene.traverse((o) => {
      if (o instanceof PointLight) lights++;
      if (o instanceof InstancedMesh) meshes++;
    });
    expect(lights).toBe(0);
    expect(meshes).toBe(0);
    m.root.dispose();
    m.materials.dispose();
  });
});
