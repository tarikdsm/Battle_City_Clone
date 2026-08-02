// tests/audio/audio.test.ts — the bus graph, the mix chain and the ducking
// matrix of audio §2 and §6 (T5.1), against the injected fake context.
//
// Three things are worth a test here and only one of them is obvious:
//
//  1. **The chain is the chain.** Audio §2 draws `voices → sfxBus/musicBus →
//     compressor → limiter → masterGain`, and a bus wired straight to the
//     destination sounds perfectly fine right up until two explosions overlap.
//  2. **The ducks are numbers, not vibes.** −12 dB for 1.2 s with a 400 ms
//     release is four values and two nodes, and every one of them is asserted.
//  3. **The context stays suspended until a real gesture.** Chrome's autoplay
//     policy is not a suggestion, and a context resumed at construction time is
//     a context that is silently dead for the whole session.

import { describe, expect, it } from 'vitest';

import {
  CLOCK_FILTER,
  COMPRESSOR,
  DUCKS,
  DUCK_ATTACK_MS,
  LIMITER,
  REVERB,
  VOICE_BUDGET,
  createAudio,
  createAudioGraph,
  createVoicePool,
  type AudioGraph,
} from '../../src/audio/audio';
import { dbToGain } from '../../src/audio/synth';
import { createGame } from '../../src/core/game';
import type { LevelData } from '../../src/core/types';

import {
  FakeAudioContext,
  asAudioContext,
  fakeCompressor,
  fakeFilter,
  fakeGain,
  fakeNode,
} from './fakeContext';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

function graphRig(): { fake: FakeAudioContext; graph: AudioGraph } {
  const fake = new FakeAudioContext();
  return { fake, graph: createAudioGraph(asAudioContext(fake)) };
}

/** A `window` stand-in that records its listeners and can fire them. */
function blurTarget(): {
  target: {
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  };
  fire(type: string): void;
  count(): number;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    target: {
      addEventListener(type: string, fn: () => void): void {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, fn: () => void): void {
        listeners.get(type)?.delete(fn);
      },
    },
    fire(type: string): void {
      for (const fn of listeners.get(type) ?? []) {
        fn();
      }
    },
    count(): number {
      let n = 0;
      for (const set of listeners.values()) {
        n += set.size;
      }
      return n;
    },
  };
}

describe('the mix chain (audio §2)', () => {
  it('routes both buses through the compressor, the limiter and the master', () => {
    const { fake, graph } = graphRig();
    const master = fakeGain(graph.master);
    const comp = fakeCompressor(graph.compressor);
    const limit = fakeCompressor(graph.limiter);

    expect(fake.reaches(fakeGain(graph.sfxBus), comp)).toBe(true);
    expect(fake.reaches(fakeGain(graph.musicBus), comp)).toBe(true);
    expect(comp.outputs).toContain(limit);
    expect(limit.outputs).toContain(master);
    expect(master.outputs).toContain(fake.destination);
    // Nothing may reach the speakers around the limiter.
    expect(fake.feeding(fake.destination)).toEqual([master]);
  });

  it('puts the duck node between each bus and the compressor', () => {
    const { fake, graph } = graphRig();
    expect(fakeGain(graph.sfxBus).outputs).toContain(fakeGain(graph.sfxDuck));
    expect(fakeGain(graph.musicBus).outputs).toContain(
      fakeGain(graph.musicDuck),
    );
    // Audio §4: the clock freeze lowpasses "the whole bus", so the filter sits
    // on the music path rather than on each voice.
    expect(
      fake.reaches(fakeGain(graph.musicDuck), fakeFilter(graph.musicFilter)),
    ).toBe(true);
  });

  it('keeps the sting bus out of the duck it fires', () => {
    const { fake, graph } = graphRig();
    // The two `top`-priority SFX are the ones that duck "everything". If they
    // went through `sfxDuck` they would duck themselves, which is the opposite
    // of what audio §6 is asking for — so they have their own path in.
    expect(
      fake.reaches(fakeGain(graph.stingBus), fakeGain(graph.sfxDuck)),
    ).toBe(false);
    expect(fake.reaches(fakeGain(graph.stingBus), fakeGain(graph.master))).toBe(
      true,
    );
  });

  it('configures the compressor and the limiter to audio §2 and §6', () => {
    const { graph } = graphRig();
    const comp = fakeCompressor(graph.compressor);
    expect(comp.ratio.value).toBe(COMPRESSOR.ratio);
    expect(COMPRESSOR.ratio).toBe(2); // "2:1"
    expect(comp.threshold.value).toBe(COMPRESSOR.thresholdDb);
    expect(COMPRESSOR.thresholdDb).toBe(-18); // "−18 dB knee"

    const limit = fakeCompressor(graph.limiter);
    expect(limit.threshold.value).toBe(LIMITER.thresholdDb);
    expect(LIMITER.thresholdDb).toBe(-1); // "master limiter −1 dBTP"
    expect(limit.ratio.value).toBeGreaterThanOrEqual(20);
    expect(limit.knee.value).toBe(0);
  });

  it('synthesizes its reverb impulse rather than loading one', () => {
    const { fake, graph } = graphRig();
    // The project's hard constraint: no audio files, ever. The plate is a
    // decaying noise buffer the engine generates at construction.
    expect(graph.reverb.buffer).not.toBeNull();
    expect(fake.buffers.some((b) => b.duration > 0.2)).toBe(true);
    expect(REVERB.sfxWet).toBeCloseTo(0.08, 9);
    expect(REVERB.musicWet).toBeCloseTo(0.12, 9);
    // …and the sends really carry those depths.
    expect(fakeGain(graph.sfxReverbSend).gain.value).toBeCloseTo(0.08, 9);
    expect(fakeGain(graph.musicReverbSend).gain.value).toBeCloseTo(0.12, 9);
  });

  it('feeds its tempo-synced delay from the music bus only', () => {
    const { fake, graph } = graphRig();
    expect(fake.reaches(fakeGain(graph.musicBus), fakeNode(graph.delay))).toBe(
      true,
    );
    expect(fake.reaches(fakeGain(graph.sfxBus), fakeNode(graph.delay))).toBe(
      false,
    );
    // 3/16 at 120 BPM is 375 ms; the feedback is audio §3's 0.25.
    graph.setDelayTempo(120);
    expect(graph.delay.delayTime.value).toBeCloseTo(0.375, 6);
    expect(fakeGain(graph.delayFeedback).gain.value).toBeCloseTo(0.25, 9);
  });
});

describe('volumes', () => {
  it('moves the bus gains the settings sliders own', () => {
    const { graph } = graphRig();
    graph.setVolumes({ music: 0.4, sfx: 0.9 });
    expect(fakeGain(graph.musicBus).gain.value).toBeCloseTo(0.4, 9);
    expect(fakeGain(graph.sfxBus).gain.value).toBeCloseTo(0.9, 9);
    // The stings follow the SFX slider even though they bypass its duck.
    expect(fakeGain(graph.stingBus).gain.value).toBeCloseTo(0.9, 9);
  });

  it('makes a muted bus silent, and clamps nonsense', () => {
    const { graph } = graphRig();
    graph.setVolumes({ music: 0, sfx: 0 });
    expect(fakeGain(graph.musicBus).gain.value).toBe(0);
    expect(fakeGain(graph.sfxBus).gain.value).toBe(0);
    graph.setVolumes({ music: 5, sfx: -3 });
    expect(fakeGain(graph.musicBus).gain.value).toBe(1);
    expect(fakeGain(graph.sfxBus).gain.value).toBe(0);
    graph.setVolumes({ music: Number.NaN, sfx: Number.NaN });
    expect(Number.isFinite(fakeGain(graph.musicBus).gain.value)).toBe(true);
  });
});

describe('the ducking matrix (audio §6)', () => {
  it('carries the documented depths, holds and releases', () => {
    expect(DUCKS.baseExplode).toEqual({
      targets: ['music', 'sfx'],
      depthDb: -12,
      holdMs: 1200,
      releaseMs: 400,
    });
    expect(DUCKS.playerExplode).toEqual({
      targets: ['music'],
      depthDb: -6,
      holdMs: 0,
      releaseMs: 400,
    });
  });

  it('ducks everything −12 dB for 1.2 s on baseExplode', () => {
    const { graph } = graphRig();
    graph.duck('baseExplode', 10);

    const attack = DUCK_ATTACK_MS / 1000;
    for (const node of [graph.musicDuck, graph.sfxDuck]) {
      const gain = fakeGain(node).gain;
      expect(gain.ops('cancel')[0]?.time).toBeCloseTo(10, 9);
      const down = gain.ops('linear')[0];
      expect(down.value).toBeCloseTo(dbToGain(-12), 6);
      expect(down.time).toBeCloseTo(10 + attack, 9);
      // Held at depth for the full 1.2 s, then back up over 400 ms.
      const up = gain.last('linear');
      expect(up?.value).toBe(1);
      expect(up?.time).toBeCloseTo(10 + 1.2 + 0.4, 9);
    }
    // The sting bus is not ducked by its own explosion.
    expect(fakeGain(graph.stingBus).gain.events).toHaveLength(0);
  });

  it('ducks only the music −6 dB on playerExplode', () => {
    const { graph } = graphRig();
    graph.duck('playerExplode', 4);

    const music = fakeGain(graph.musicDuck).gain;
    expect(music.ops('linear')[0].value).toBeCloseTo(dbToGain(-6), 6);
    expect(music.last('linear')?.time).toBeCloseTo(
      4 + DUCK_ATTACK_MS / 1000 + 0.4,
      9,
    );
    expect(fakeGain(graph.sfxDuck).gain.events).toHaveLength(0);
  });

  it('lowpasses the music for the clock freeze without touching a gain', () => {
    const { graph } = graphRig();
    graph.setClockFreeze(true, 2);

    const cutoff = fakeFilter(graph.musicFilter).frequency;
    const down = cutoff.last('exp');
    expect(down?.value).toBeCloseTo(CLOCK_FILTER.hz, 6);
    expect(CLOCK_FILTER.hz).toBe(400); // audio §4: "lowpass sweep to 400 Hz"
    expect(down?.time).toBeCloseTo(2 + CLOCK_FILTER.sweepMs / 1000, 9);
    // "…no gain duck": the matrix says so in as many words.
    expect(fakeGain(graph.musicDuck).gain.events).toHaveLength(0);

    graph.setClockFreeze(false, 6);
    expect(fakeFilter(graph.musicFilter).frequency.last('exp')?.value).toBe(
      CLOCK_FILTER.openHz,
    );
  });
});

describe('the voice pool (audio §2)', () => {
  it('holds the documented budget of 24 voices', () => {
    expect(VOICE_BUDGET).toBe(24);
    const pool = createVoicePool();
    for (let i = 0; i < VOICE_BUDGET; i++) {
      const slot = pool.acquire(1, 1, 99, 0);
      expect(slot, `voice ${i}`).not.toBeNull();
      // A voice that outlives the whole test, so the budget really fills.
      if (slot !== null) {
        slot.endTime = 100;
      }
    }
    expect(pool.activeCount()).toBe(VOICE_BUDGET);
    expect(pool.acquire(1, 0, 99, 0)).toBeNull(); // lower priority: refused
  });

  it('reuses a slot whose envelope has already finished', () => {
    const pool = createVoicePool();
    const first = pool.acquire(3, 2, 4, 0);
    if (first === null) {
      throw new Error('expected a free slot');
    }
    first.endTime = 0.5;
    expect(pool.activeCount()).toBe(1);
    pool.reclaim(1);
    expect(pool.activeCount()).toBe(0);
    expect(pool.acquire(3, 2, 4, 1)).toBe(first);
  });

  it('steals the oldest voice of the same sound past its poly cap', () => {
    const pool = createVoicePool();
    const a = pool.acquire(7, 2, 2, 0);
    const b = pool.acquire(7, 2, 2, 1);
    if (a === null || b === null) {
      throw new Error('expected two free slots');
    }
    a.endTime = 100;
    b.endTime = 100;
    expect(pool.taggedCount(7)).toBe(2);

    // The cap is 2, so the third takes the FIRST one's slot, not the second's.
    const c = pool.acquire(7, 2, 2, 2);
    expect(c).toBe(a);
    expect(pool.taggedCount(7)).toBe(2);
    // …and a different sound is untouched by another sound's cap.
    expect(pool.acquire(8, 2, 2, 2)).not.toBeNull();
  });

  it('lets a higher priority take a slot from a lower one', () => {
    const pool = createVoicePool(2);
    const low = pool.acquire(1, 0, 9, 0);
    const mid = pool.acquire(2, 1, 9, 1);
    if (low === null || mid === null) {
      throw new Error('expected two free slots');
    }
    low.endTime = 100;
    mid.endTime = 100;
    // `top` outranks both, and takes the oldest of the ones it outranks.
    expect(pool.acquire(3, 3, 9, 2)).toBe(low);
  });
});

describe('createAudio — the Contract Zero facade', () => {
  it('leaves the context suspended until a gesture resumes it', () => {
    const fake = new FakeAudioContext();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: null,
    });
    // Constructed, wired, and silent: this is the autoplay contract.
    expect(fake.state).toBe('suspended');
    expect(fake.resumeCalls).toBe(0);

    audio.resume();
    expect(fake.resumeCalls).toBe(1);
    expect(fake.state).toBe('running');
    // Idempotent: the input layer calls this on every key press, because a
    // rejected first resume must be retried on the next gesture.
    audio.resume();
    audio.resume();
    expect(fake.resumeCalls).toBe(1);

    audio.suspend();
    expect(fake.suspendCalls).toBe(1);
    audio.resume();
    expect(fake.resumeCalls).toBe(2);
    audio.dispose();
  });

  it('mutes on blur and comes back on focus — but only if it was unlocked', () => {
    const fake = new FakeAudioContext();
    const win = blurTarget();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: win.target,
      muteOnBlur: true,
    });

    // Never gesture-unlocked: focus must not resume a context the browser
    // would refuse anyway, and must not count as the first gesture.
    win.fire('blur');
    win.fire('focus');
    expect(fake.resumeCalls).toBe(0);

    audio.resume();
    win.fire('blur');
    expect(fake.state).toBe('suspended');
    win.fire('focus');
    expect(fake.state).toBe('running');

    audio.dispose();
    expect(win.count()).toBe(0); // listeners really are removed
  });

  it('honours mute-on-blur being switched off', () => {
    const fake = new FakeAudioContext();
    const win = blurTarget();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: win.target,
      muteOnBlur: false,
    });
    audio.resume();
    win.fire('blur');
    expect(fake.state).toBe('running');
    audio.dispose();
  });

  it('passes the volumes through to the buses', () => {
    const fake = new FakeAudioContext();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: null,
    });
    audio.setVolumes({ music: 0.25, sfx: 0.5 });
    const graph = audio.graph;
    if (graph === null) {
      throw new Error('expected a graph on a working context');
    }
    expect(fakeGain(graph.musicBus).gain.value).toBeCloseTo(0.25, 9);
    expect(fakeGain(graph.sfxBus).gain.value).toBeCloseTo(0.5, 9);
    audio.dispose();
  });

  it('schedules absolutely nothing while the context is suspended', () => {
    const fake = new FakeAudioContext();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: null,
    });
    const state = createGame(OPEN, { players: 1, seed: 1, stageNumber: 1 });
    const built = fake.created.length;

    // A suspended context's clock does not advance, so a voice built now is a
    // voice scheduled at t = 0 — and every one of them would fire at once the
    // moment the player presses a key. Measured in real Chromium before this
    // gate existed: ten "AudioContext was not allowed to start" warnings over
    // the stage-intro curtain, and a burst of stale spawn bells on the first
    // keypress.
    audio.onEvent({ t: 'baseDestroyed' });
    audio.onEvent({ t: 'brickHit', tx: 1, ty: 1, removedMask: 3, x: 16, y: 16, dir: 0 }); // prettier-ignore
    audio.update(state, 16);
    audio.play('uiSelect');
    expect(fake.created.length).toBe(built);
    expect(audio.stats().oneShots).toBe(0);

    audio.resume();
    audio.onEvent({ t: 'brickHit', tx: 1, ty: 1, removedMask: 3, x: 16, y: 16, dir: 0 }); // prettier-ignore
    expect(fake.created.length).toBeGreaterThan(built);
    expect(audio.stats().oneShots).toBeGreaterThan(0);
    audio.dispose();
  });

  it('survives a context factory that throws, and stays silent', () => {
    // A browser that refuses to construct an AudioContext (a locked-down
    // policy, an exhausted context quota) must cost the player the sound and
    // nothing else — the game still has to boot.
    const audio = createAudio({
      createContext: () => {
        throw new Error('no audio device');
      },
      blurTarget: null,
    });
    expect(audio.graph).toBeNull();
    expect(() => {
      audio.resume();
      audio.setVolumes({ music: 1, sfx: 1 });
      audio.onEvent({ t: 'baseDestroyed' });
      audio.dispose();
    }).not.toThrow();
  });
});
