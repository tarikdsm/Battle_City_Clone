// src/audio/audio.ts — the bus graph, the mix chain, the ducking matrix and
// Contract Zero's `AudioSystem` (audio §2 and §6, arch §6).
//
// This layer is a **peer of the renderer**: it reads `GameState`, it consumes
// `GameEvent`s, and it writes to neither (arch §2/§3.3). Nothing below it knows
// the game exists; nothing above it knows Web Audio does.
//
// ## The chain
//
//   sfx voices  → sfxBus  → sfxDuck   ─┐
//   sting voices→ stingBus ───────────┐│
//   sequencer   → musicBus → musicDuck → musicFilter ─┐
//                                     └─► delay ──────┤
//                            (sends) ──► reverb ──────┤
//                                                     ▼
//                             compressor → limiter → master → destination
//
// Two details in that picture are decisions rather than transcription:
//
// **The sting bus exists because `baseExplode` ducks "everything".** Taken
// literally that includes the explosion doing the ducking, which is the exact
// opposite of what audio §6 wants (the boom should stand alone in the hole it
// digs). So the two `top`-priority sounds — the player's death and the base's —
// go in on their own path, past the SFX duck, and still through the shared
// compressor so the mix "breathes as one".
//
// **The music filter is on the bus, not on the voices.** Audio §4 says the
// clock freeze "filters the whole bus", and one biquad on the bus is both what
// the doc says and one node instead of one per voice.
//
// ## Autoplay
//
// The context is constructed **suspended** and only ever resumed from a real
// user gesture, which arrives through the input layer (`createInput`'s
// `onUserGesture`) rather than through a second listener of our own. `resume()`
// is idempotent and safe to call on every key press, which is what makes a
// first attempt the browser refuses recoverable on the next one.

import type { GameEvent } from '../core/events';
import type { GameState } from '../core/types';
import { createSequencer, type Sequencer } from './sequencer';
import {
  createSynthRuntime,
  createVoiceSlot,
  dbToGain,
  stopVoice,
  type SynthRuntime,
  type VoiceSlot,
} from './synth';

// ---------------------------------------------------------------------------
// The numbers audio §2 and §6 fix
// ---------------------------------------------------------------------------

/**
 * Audio §2: "compressor (2:1, −18 dB knee)".
 *
 * Web Audio's `DynamicsCompressorNode` has a `threshold` in dB and a `knee`
 * that is a **width** in dB above it, so "−18 dB knee" is read here as a
 * threshold of −18 dB with a soft knee over it. That is the only reading that
 * maps onto the API; the alternative (a knee parameter of −18) is not a legal
 * value. Noted for a §2 amendment.
 */
export const COMPRESSOR = Object.freeze({
  ratio: 2,
  thresholdDb: -18,
  kneeDb: 12,
  attackS: 0.006,
  releaseS: 0.25,
});

/**
 * Audio §6: "master limiter −1 dBTP".
 *
 * Web Audio has **no true-peak limiter**. `DynamicsCompressorNode` is a soft
 * compressor with a lookahead of a few milliseconds; driven at ratio 20 with a
 * hard knee it behaves like one for material this transient, but it does not
 * guarantee an inter-sample ceiling and nothing in the API does. The honest
 * description is "a brick-wall-ish compressor at −1 dB"; the measured peak of
 * every rendered SFX is in `docs/calibration/audio.json` precisely so that the
 * claim is checkable rather than asserted. Reported for a §6 amendment.
 */
export const LIMITER = Object.freeze({
  ratio: 20,
  thresholdDb: -1,
  kneeDb: 0,
  attackS: 0.001,
  releaseS: 0.06,
});

/** Audio §3's send FX: "small plate-style reverb (SFX 8% wet, music 12%)". */
export const REVERB = Object.freeze({
  sfxWet: 0.08,
  musicWet: 0.12,
  decayS: 0.8,
  preDelayS: 0.008,
});

/** Audio §3: "tempo-synced delay (3/16, feedback 0.25, music only)". */
export const DELAY = Object.freeze({
  noteFraction: 3 / 16,
  feedback: 0.25,
  sendGain: 0.22,
  maxS: 1.5,
});

export type DuckTarget = 'music' | 'sfx';
export type DuckId = 'baseExplode' | 'playerExplode';

export interface DuckSpec {
  readonly targets: readonly DuckTarget[];
  readonly depthDb: number;
  /** How long the duck is held at depth **from the moment it fires**. */
  readonly holdMs: number;
  readonly releaseMs: number;
}

/**
 * Audio §6's ducking matrix, verbatim:
 *
 * > baseExplode → all −12 dB, 1.2 s, 400 ms release; playerExplode → music
 * > −6 dB, 400 ms; clockFreeze → music lowpassed (no gain duck).
 *
 * `playerExplode` is given one number, so it is read as the whole gesture:
 * bite immediately, recover over 400 ms, no hold. `baseExplode` is given two,
 * so its 1.2 s is the hold and the 400 ms is the recovery on top.
 */
export const DUCKS: Readonly<Record<DuckId, DuckSpec>> = Object.freeze({
  baseExplode: Object.freeze({
    targets: Object.freeze(['music', 'sfx'] as DuckTarget[]),
    depthDb: -12,
    holdMs: 1200,
    releaseMs: 400,
  }),
  playerExplode: Object.freeze({
    targets: Object.freeze(['music'] as DuckTarget[]),
    depthDb: -6,
    holdMs: 0,
    releaseMs: 400,
  }),
});

/** How fast a duck bites. Fast enough to be under the transient, slow enough
 *  not to be a click of its own. */
export const DUCK_ATTACK_MS = 20;

/** Audio §4: "Clock freeze filters the whole bus (lowpass sweep to 400 Hz)". */
export const CLOCK_FILTER = Object.freeze({
  hz: 400,
  openHz: 20000,
  sweepMs: 600,
});

/** Audio §2: "Voice budget 24". */
export const VOICE_BUDGET = 24;
/** Fade applied to a stolen voice, so the theft is not a click. */
export const STEAL_FADE_MS = 8;

// ---------------------------------------------------------------------------
// The voice pool
// ---------------------------------------------------------------------------

export interface VoicePool {
  /**
   * A slot for one new voice, or `null` when the budget is full of things that
   * matter more.
   *
   * @param tag      caller's identity for the sound (the SFX index), for caps
   * @param priority higher wins; a full pool steals from `<=` this
   * @param polyCap  most simultaneous voices of this `tag`
   */
  acquire(
    tag: number,
    priority: number,
    polyCap: number,
    now: number,
  ): VoiceSlot | null;
  /** Frees every slot whose envelope has finished. */
  reclaim(now: number): void;
  activeCount(): number;
  taggedCount(tag: number): number;
  /** Stops everything — screen changes, teardown. */
  releaseAll(now: number): void;
  readonly size: number;
}

/**
 * Fixed size, allocated once, never grown — the same rule the particle pool
 * follows (`render/fx/fxSystem.ts`). A budget enforced by growing the pool is
 * not a budget, and 25 simultaneous oscillator voices is where a mid-range
 * laptop starts to crackle.
 */
export function createVoicePool(size: number = VOICE_BUDGET): VoicePool {
  const slots: VoiceSlot[] = [];
  const tags = new Int32Array(size);
  const priorities = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    slots.push(createVoiceSlot());
    tags[i] = -1;
  }

  function reclaim(now: number): void {
    for (let i = 0; i < size; i++) {
      const slot = slots[i];
      if (slot.active && slot.endTime <= now) {
        slot.active = false;
        tags[i] = -1;
      }
    }
  }

  function take(
    index: number,
    tag: number,
    priority: number,
    now: number,
  ): VoiceSlot {
    // prettier-ignore
    const slot = slots[index];
    if (slot.active) {
      stopVoice(slot, now, STEAL_FADE_MS);
    }
    tags[index] = tag;
    priorities[index] = priority;
    slot.active = true;
    slot.startTime = now;
    // Until `playNote` writes the real envelope end, the voice is live: a
    // placeholder of `now` would let the next `acquire` in the same frame
    // reclaim the slot it just handed out.
    slot.endTime = Number.POSITIVE_INFINITY;
    return slot;
  }

  return {
    size,

    acquire(tag, priority, polyCap, now): VoiceSlot | null {
      reclaim(now);

      // 1. The per-sound cap, which is about how a *sound* stacks — three brick
      //    hits are a wall coming down, ten are a static burst.
      let held = 0;
      let oldest = -1;
      for (let i = 0; i < size; i++) {
        if (!slots[i].active || tags[i] !== tag) {
          continue;
        }
        held++;
        if (oldest < 0 || slots[i].startTime < slots[oldest].startTime) {
          oldest = i;
        }
      }
      if (held >= polyCap && oldest >= 0) {
        return take(oldest, tag, priority, now);
      }

      // 2. A free slot.
      for (let i = 0; i < size; i++) {
        if (!slots[i].active) {
          return take(i, tag, priority, now);
        }
      }

      // 3. The global budget: steal the oldest voice this one outranks or ties.
      let victim = -1;
      for (let i = 0; i < size; i++) {
        if (priorities[i] > priority) {
          continue;
        }
        if (victim < 0 || slots[i].startTime < slots[victim].startTime) {
          victim = i;
        }
      }
      return victim >= 0 ? take(victim, tag, priority, now) : null;
    },

    reclaim,

    activeCount(): number {
      let n = 0;
      for (let i = 0; i < size; i++) {
        if (slots[i].active) {
          n++;
        }
      }
      return n;
    },

    taggedCount(tag): number {
      let n = 0;
      for (let i = 0; i < size; i++) {
        if (slots[i].active && tags[i] === tag) {
          n++;
        }
      }
      return n;
    },

    releaseAll(now): void {
      for (let i = 0; i < size; i++) {
        if (slots[i].active) {
          stopVoice(slots[i], now, STEAL_FADE_MS);
        }
        tags[i] = -1;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export interface Volumes {
  music: number;
  sfx: number;
}

export interface AudioGraph {
  readonly ctx: BaseAudioContext;
  readonly synth: SynthRuntime;
  /** Where one-shot SFX voices go. */
  readonly sfxBus: GainNode;
  readonly sfxDuck: GainNode;
  /** The two `top`-priority SFX, past the duck they fire. */
  readonly stingBus: GainNode;
  readonly musicBus: GainNode;
  readonly musicDuck: GainNode;
  readonly musicFilter: BiquadFilterNode;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter: DynamicsCompressorNode;
  readonly master: GainNode;
  readonly reverb: ConvolverNode;
  readonly sfxReverbSend: GainNode;
  readonly musicReverbSend: GainNode;
  readonly delay: DelayNode;
  readonly delayFeedback: GainNode;
  setVolumes(v: Volumes): void;
  /** Fires one row of audio §6's matrix at `when` on the context clock. */
  duck(id: DuckId, when: number): void;
  setClockFreeze(on: boolean, when: number): void;
  /** Re-syncs the 3/16 delay to a tempo. */
  setDelayTempo(bpm: number): void;
  dispose(): void;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * A small plate, synthesized. Exponentially decaying noise with a short
 * pre-delay and a soft onset — dense enough to read as a room, short enough
 * that an 8% send does not smear the transients it is there to flatter.
 *
 * Seeded, like every other generated buffer here, so the offline render is
 * bit-reproducible and `docs/calibration/audio.json` means something.
 */
function createPlateIr(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * REVERB.decayS));
  const preDelay = Math.floor(ctx.sampleRate * REVERB.preDelayS);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let s = ch === 0 ? 0x2545f491 : 0x814fd3b7;
    for (let i = preDelay; i < length; i++) {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const white = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
      const k = (i - preDelay) / Math.max(1, length - preDelay);
      data[i] = white * Math.pow(1 - k, 2.2) * Math.min(1, k * 60);
    }
  }
  return buffer;
}

export function createAudioGraph(
  ctx: BaseAudioContext,
  volumes: Volumes = { music: 0.7, sfx: 0.8 },
): AudioGraph {
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.kneeDb;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attackS;
  limiter.release.value = LIMITER.releaseS;
  limiter.connect(master);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR.thresholdDb;
  compressor.knee.value = COMPRESSOR.kneeDb;
  compressor.ratio.value = COMPRESSOR.ratio;
  compressor.attack.value = COMPRESSOR.attackS;
  compressor.release.value = COMPRESSOR.releaseS;
  compressor.connect(limiter);

  // --- the shared plate ----------------------------------------------------
  const reverb = ctx.createConvolver();
  reverb.normalize = true;
  reverb.buffer = createPlateIr(ctx);
  reverb.connect(compressor);

  // --- SFX -----------------------------------------------------------------
  const sfxDuck = ctx.createGain();
  sfxDuck.connect(compressor);

  const sfxBus = ctx.createGain();
  sfxBus.gain.value = clamp01(volumes.sfx);
  sfxBus.connect(sfxDuck);

  const sfxReverbSend = ctx.createGain();
  sfxReverbSend.gain.value = REVERB.sfxWet;
  sfxBus.connect(sfxReverbSend);
  sfxReverbSend.connect(reverb);

  const stingBus = ctx.createGain();
  stingBus.gain.value = clamp01(volumes.sfx);
  stingBus.connect(compressor);
  stingBus.connect(sfxReverbSend);

  // --- music ---------------------------------------------------------------
  const musicFilter = ctx.createBiquadFilter();
  musicFilter.type = 'lowpass';
  musicFilter.frequency.value = CLOCK_FILTER.openHz;
  musicFilter.Q.value = 0.7;
  musicFilter.connect(compressor);

  const musicDuck = ctx.createGain();
  musicDuck.connect(musicFilter);

  const musicBus = ctx.createGain();
  musicBus.gain.value = clamp01(volumes.music);
  musicBus.connect(musicDuck);

  const musicReverbSend = ctx.createGain();
  musicReverbSend.gain.value = REVERB.musicWet;
  musicBus.connect(musicReverbSend);
  musicReverbSend.connect(reverb);

  // Music only, per audio §3. The delay's output rejoins BEFORE the duck, so
  // the tail ducks and freezes with everything else it belongs to.
  const delay = ctx.createDelay(DELAY.maxS);
  const delaySend = ctx.createGain();
  delaySend.gain.value = DELAY.sendGain;
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = DELAY.feedback;
  musicBus.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delay.connect(musicDuck);

  function duckNode(node: GainNode, spec: DuckSpec, when: number): void {
    const depth = dbToGain(spec.depthDb);
    const attackAt = when + DUCK_ATTACK_MS / 1000;
    const gain = node.gain;
    gain.cancelScheduledValues(when);
    gain.setValueAtTime(gain.value, when);
    gain.linearRampToValueAtTime(depth, attackAt);
    const releaseAt = Math.max(attackAt, when + spec.holdMs / 1000);
    if (releaseAt > attackAt) {
      gain.setValueAtTime(depth, releaseAt);
    }
    gain.linearRampToValueAtTime(1, releaseAt + spec.releaseMs / 1000);
  }

  function setDelayTempo(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) {
      return;
    }
    // 3/16 of a bar of four quarters: three sixteenth notes.
    const seconds = (60 / bpm) * 4 * DELAY.noteFraction;
    delay.delayTime.value = Math.min(DELAY.maxS, seconds);
  }
  setDelayTempo(120);

  return {
    ctx,
    synth: createSynthRuntime(ctx),
    sfxBus,
    sfxDuck,
    stingBus,
    musicBus,
    musicDuck,
    musicFilter,
    compressor,
    limiter,
    master,
    reverb,
    sfxReverbSend,
    musicReverbSend,
    delay,
    delayFeedback,

    setVolumes(v: Volumes): void {
      const sfx = clamp01(v.sfx);
      musicBus.gain.value = clamp01(v.music);
      sfxBus.gain.value = sfx;
      // The stings bypass the SFX duck but not the SFX slider.
      stingBus.gain.value = sfx;
    },

    duck(id: DuckId, when: number): void {
      const spec = DUCKS[id];
      for (let i = 0; i < spec.targets.length; i++) {
        duckNode(spec.targets[i] === 'music' ? musicDuck : sfxDuck, spec, when);
      }
    },

    setClockFreeze(on: boolean, when: number): void {
      const cutoff = musicFilter.frequency;
      cutoff.cancelScheduledValues(when);
      cutoff.setValueAtTime(cutoff.value, when);
      // Exponential, because pitch and cutoff are heard logarithmically: a
      // linear sweep to 400 Hz spends most of its time in the top octave and
      // then falls off a cliff.
      cutoff.exponentialRampToValueAtTime(
        on ? CLOCK_FILTER.hz : CLOCK_FILTER.openHz,
        when + CLOCK_FILTER.sweepMs / 1000,
      );
    },

    setDelayTempo,

    dispose(): void {
      for (const node of [
        master,
        limiter,
        compressor,
        reverb,
        sfxDuck,
        sfxBus,
        sfxReverbSend,
        stingBus,
        musicFilter,
        musicDuck,
        musicBus,
        musicReverbSend,
        delay,
        delaySend,
        delayFeedback,
      ]) {
        node.disconnect();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Contract Zero
// ---------------------------------------------------------------------------

/** The `blur`/`focus` source for mute-on-blur. `window` in the game. */
export interface BlurTarget {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface AudioOptions {
  /** Injected so the suite runs headless and the capture harness can render
   *  the identical graph offline. Default: a suspended `AudioContext`. */
  createContext?: () => AudioContext;
  /** `null` opts out. Default: the global object when it can listen. */
  blurTarget?: BlurTarget | null;
  /** Audio §2: "mute-on-blur (setting, default on)". */
  muteOnBlur?: boolean;
  volumes?: Volumes;
}

export interface AudioStats {
  voices: number;
  state: string;
  running: boolean;
}

export interface AudioSystem {
  onEvent(e: GameEvent): void;
  update(state: GameState, dtMs: number): void;
  setVolumes(v: Volumes): void;
  resume(): void;
  suspend(): void;
  // --- beyond Contract Zero, and deliberately -----------------------------
  /** The live graph, or `null` when no context could be built. Read by the
   *  offline capture harness and the tests; never written. */
  readonly graph: AudioGraph | null;
  readonly sequencer: Sequencer | null;
  stats(): AudioStats;
  /** Releases the listeners, the voices and the context. */
  dispose(): void;
}

function defaultBlurTarget(): BlurTarget | null {
  const g = globalThis as unknown as Partial<BlurTarget>;
  return typeof g.addEventListener === 'function'
    ? (g as unknown as BlurTarget)
    : null;
}

/**
 * How often the pool is swept for finished voices, in milliseconds of frame
 * time. Every frame would be 60 sweeps a second over 24 slots for no benefit —
 * a voice that lingers an extra 100 ms in the bookkeeping is inaudible, and the
 * sweep is what keeps the budget honest rather than what makes the sound stop.
 */
const RECLAIM_INTERVAL_MS = 100;

export function createAudio(opts: AudioOptions = {}): AudioSystem {
  let ctx: AudioContext | null = null;
  let graph: AudioGraph | null = null;
  try {
    const make =
      opts.createContext ??
      ((): AudioContext => new AudioContext({ latencyHint: 'interactive' }));
    ctx = make();
    graph = createAudioGraph(ctx, opts.volumes);
  } catch (err) {
    // A browser that refuses to build a context (a locked-down policy, an
    // exhausted context quota, a headless runner) costs the player the sound
    // and nothing else. A warning, not an error: the e2e smoke asserts a clean
    // console, and this is not a bug in the game.
    console.warn('audio disabled:', err);
    ctx = null;
    graph = null;
  }

  const pool = createVoicePool();
  const sequencer =
    graph === null
      ? null
      : createSequencer({
          ctx: graph.ctx,
          destination: graph.musicBus,
          synth: graph.synth,
        });

  const muteOnBlur = opts.muteOnBlur ?? true;
  const target =
    opts.blurTarget !== undefined ? opts.blurTarget : defaultBlurTarget();
  /** Has a user gesture ever succeeded in starting the context? */
  let unlocked = false;
  let sinceReclaimMs = 0;

  function resume(): void {
    if (ctx === null || ctx.state === 'running' || ctx.state === 'closed') {
      unlocked = unlocked || ctx?.state === 'running';
      return;
    }
    unlocked = true;
    void ctx.resume().catch(() => {
      // The gesture was not good enough for this browser. Stay silent and let
      // the next key press try again — which is exactly why `resume()` is wired
      // to every key down rather than to a one-shot listener.
      unlocked = false;
    });
  }

  function suspend(): void {
    if (ctx === null || ctx.state !== 'running') {
      return;
    }
    void ctx.suspend().catch(() => {
      /* a context that will not suspend is not a failure worth surfacing */
    });
  }

  const onBlur = (): void => {
    if (muteOnBlur) {
      suspend();
    }
  };
  const onFocus = (): void => {
    if (muteOnBlur && unlocked) {
      resume();
    }
  };
  if (target !== null) {
    target.addEventListener('blur', onBlur);
    target.addEventListener('focus', onFocus);
  }

  return {
    // Getters, not fields: `dispose()` drops the graph, and a snapshot taken at
    // construction would keep handing out a disposed one.
    get graph(): AudioGraph | null {
      return graph;
    },
    get sequencer(): Sequencer | null {
      return sequencer;
    },

    onEvent(e: GameEvent): void {
      if (graph === null) {
        return;
      }
      const now = graph.ctx.currentTime;
      switch (e.t) {
        case 'baseDestroyed':
          graph.duck('baseExplode', now);
          break;
        case 'tankDestroyed':
          if (e.kind === 'player') {
            graph.duck('playerExplode', now);
          }
          break;
        case 'clockStarted':
          graph.setClockFreeze(true, now);
          break;
        case 'clockEnded':
          graph.setClockFreeze(false, now);
          break;
        default:
          break;
      }
    },

    update(state: GameState, dtMs: number): void {
      if (graph === null) {
        return;
      }
      sinceReclaimMs += dtMs;
      if (sinceReclaimMs >= RECLAIM_INTERVAL_MS) {
        sinceReclaimMs = 0;
        pool.reclaim(graph.ctx.currentTime);
      }
      // Audio §4: "music halts while paused". The sequencer is the thing that
      // halts; the SFX voices already in flight are left to finish, because
      // cutting a tail on the pause frame is a click.
      if (sequencer !== null && state.paused && sequencer.playing()) {
        sequencer.stop();
      }
    },

    setVolumes(v: Volumes): void {
      graph?.setVolumes(v);
    },

    resume,
    suspend,

    stats(): AudioStats {
      return {
        voices: pool.activeCount(),
        state: ctx?.state ?? 'none',
        running: ctx?.state === 'running',
      };
    },

    dispose(): void {
      if (target !== null) {
        target.removeEventListener('blur', onBlur);
        target.removeEventListener('focus', onFocus);
      }
      sequencer?.dispose();
      if (graph !== null) {
        pool.releaseAll(graph.ctx.currentTime);
        graph.dispose();
      }
      if (ctx !== null && ctx.state !== 'closed') {
        void ctx.close().catch(() => {
          /* already gone */
        });
      }
      ctx = null;
      graph = null;
    },
  };
}
