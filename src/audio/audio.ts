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

import { BASE_RING_TILES } from '../core/constants';
import type { GameEvent } from '../core/events';
import { subcellIndex } from '../core/grid';
import { Terrain, type GameState, type StagePhase } from '../core/types';
import {
  START_PADDING_S,
  TICKS_PER_BAR,
  createSequencer,
  secondsPerTick,
  type MusicPiece,
  type Sequencer,
} from './sequencer';
import { createSfxPlayer, type SfxId, type SfxPlayer } from './sfx';
import { fanfare } from './songs/fanfare';
import { gameover } from './songs/gameover';
import { hiscore } from './songs/hiscore';
import { pause as pauseJingle } from './songs/pause';
import { SUITE_LAYERS, suite, type SuiteLayer } from './songs/suite';
import { tally } from './songs/tally';
import { title } from './songs/title';
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

/**
 * The fixed trim between the sequencer's layer sum and the music slider.
 *
 * Audio §6 asks for a "music bed ~−16 LUFS-ish **under gameplay**", and the
 * first render of T5.3 came in at −11.5 dBFS RMS peaking at 0.0 — louder than
 * the base explosion, with the limiter working hard enough that three
 * different intensity levels of the suite measured **identically**. That is
 * what a bed does when it is not a bed.
 *
 * It is a separate node from `musicBus` on purpose: the balance between the
 * music and the rest of the mix is the *composer's* decision and belongs in
 * the graph, while `musicBus` belongs to the player's slider. Folding one into
 * the other means every future tweak to the mix silently moves what "70%"
 * means.
 */
export const MUSIC_TRIM_DB = -9;

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
  /** Where the sequencer plays: the composer's trim, ahead of the slider. */
  readonly musicTrim: GainNode;
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
  // **Post-duck**, not post-bus. A send taken before the duck leaves a wet
  // ghost of everything the duck just removed, ringing on at −18 dB under a
  // signal that is supposed to have got out of the way — which is audible on
  // the base explosion, the one place the whole mechanism exists for.
  sfxDuck.connect(sfxReverbSend);
  sfxReverbSend.connect(reverb);

  const stingBus = ctx.createGain();
  stingBus.gain.value = clamp01(volumes.sfx);
  stingBus.connect(compressor);
  // The stings share the SFX plate but join it after the duck node, so their
  // own tails are the one thing in the mix that does not get out of their way.
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

  const musicTrim = ctx.createGain();
  musicTrim.gain.value = dbToGain(MUSIC_TRIM_DB);
  musicTrim.connect(musicBus);

  const musicReverbSend = ctx.createGain();
  musicReverbSend.gain.value = REVERB.musicWet;
  musicDuck.connect(musicReverbSend); // post-duck, for the reason above
  musicReverbSend.connect(reverb);

  // Music only, per audio §3. The send is taken BEFORE the duck and the tail
  // rejoins before it too, which is what makes the echoes duck and freeze with
  // the notes that produced them — and is also the only routing that does not
  // put the duck node inside the feedback loop.
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
    musicTrim,
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
        musicTrim,
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
// The music map (audio §4) and the intensity logic that drives it
// ---------------------------------------------------------------------------

export type MusicId =
  'title' | 'fanfare' | 'suite' | 'tally' | 'gameover' | 'hiscore' | 'pause';

/** Audio §4's music map. Every piece is note data; nothing here is a file. */
export const MUSIC: Readonly<Record<MusicId, MusicPiece>> = Object.freeze({
  title,
  fanfare,
  suite,
  tally,
  gameover,
  hiscore,
  pause: pauseJingle,
});

/** Audio §4: "L1 groove … enters after 2 bars". */
export const SUITE_L1_BARS = 2;
/** Audio §4: "L2 arps … ≥3 enemies on field". */
export const SUITE_L2_ENEMIES_ON_FIELD = 3;
/** Audio §4: "L3 lead … ≤5 enemies left to destroy". */
export const SUITE_L3_ENEMIES_LEFT = 5;

export interface MusicIntensity {
  readonly layers: Readonly<Record<SuiteLayer, number>>;
  /** Audio §4: the Clock lowpasses the whole bus for its duration. */
  readonly clockFilter: boolean;
}

/** Enemy tanks currently on the board. */
export function enemiesOnField(state: GameState): number {
  let n = 0;
  for (let i = 0; i < state.tanks.length; i++) {
    const tank = state.tanks[i];
    if (tank.alive && tank.kind === 'enemy') {
      n++;
    }
  }
  return n;
}

/** Enemies left to destroy: the ones on the board plus the ones still queued. */
export function enemiesRemaining(state: GameState): number {
  return state.spawner.queue.length + enemiesOnField(state);
}

/**
 * Is the eagle exposed? True the moment **any** subcell of fidelity §2's brick
 * ring is gone — a single shot through one corner is the danger the layer is
 * for, not the whole wall coming down. The shovel's steel phase reads as intact
 * because steel is not `Empty`, which is exactly right: while the shovel holds,
 * the base is safer than it started.
 */
export function baseBreached(state: GameState): boolean {
  if (!state.eagleAlive) {
    return true;
  }
  for (const [tx, ty] of BASE_RING_TILES) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (
          state.terrain[subcellIndex(tx * 2 + dx, ty * 2 + dy)] ===
          Terrain.Empty
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Is any active player down to their last tank? */
export function onLastLife(state: GameState): boolean {
  for (const player of state.players) {
    if (player.active && player.lives <= 0) {
      return true;
    }
  }
  return false;
}

/**
 * Audio §4's layer table, as a pure function of the simulation.
 *
 * Pure and exported because this is where the music becomes a claim about the
 * game — "the arps mean three tanks are hunting you" is only true if this
 * function says so, and a claim like that deserves a test rather than a
 * listen.
 *
 * @param elapsedBars bars since the suite started, for L1's two-bar entry.
 */
export function musicLayerTargets(
  state: GameState,
  elapsedBars: number,
): MusicIntensity {
  const danger = baseBreached(state) || onLastLife(state);
  const lead = enemiesRemaining(state) <= SUITE_L3_ENEMIES_LEFT;
  return {
    layers: {
      L0: 1,
      L1: elapsedBars >= SUITE_L1_BARS ? 1 : 0,
      L2: enemiesOnField(state) >= SUITE_L2_ENEMIES_ON_FIELD ? 1 : 0,
      // §4: "L4 overrides L3's lead with a tenser variation". One line, and it
      // is the whole override — the two leads never sound together.
      L3: lead && !danger ? 1 : 0,
      L4: danger ? 1 : 0,
    },
    clockFilter: state.clockT > 0,
  };
}

/** Seconds in one bar of the gameplay suite. */
const SUITE_BAR_S = TICKS_PER_BAR * secondsPerTick(suite.song.bpm);

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
  oneShots: number;
  music: MusicId | null;
  layers: Readonly<Record<SuiteLayer, number>>;
}

export interface AudioSystem {
  onEvent(e: GameEvent): void;
  update(state: GameState, dtMs: number): void;
  setVolumes(v: Volumes): void;
  resume(): void;
  suspend(): void;
  // --- beyond Contract Zero, and deliberately -----------------------------
  /**
   * Fires one §5 sound directly.
   *
   * Four of audio §5's rows — `uiMove`, `uiSelect`, `uiBack` and `tallyTick` —
   * are **menu and tally sounds with no core event behind them**, because the
   * simulation does not know that menus exist. Contract Zero's five methods
   * cannot reach them, so this is the sixth. It is also what a settings screen
   * needs to preview a volume slider.
   */
  play(id: SfxId, pan?: number, intensity?: number): void;
  /**
   * Starts one piece of audio §4's music map, replacing whatever was playing.
   *
   * The play screen never calls this: the stage phase and the pause flag drive
   * it from `update`, because "which music is playing" is a function of the
   * simulation's state and not of anything the UI knows. It is public for the
   * title and high-score screens (T6.x), which have no simulation behind them.
   */
  playMusic(id: MusicId): void;
  stopMusic(): void;
  /** The live graph, or `null` when no context could be built. Read by the
   *  offline capture harness and the tests; never written. */
  readonly graph: AudioGraph | null;
  readonly sequencer: Sequencer | null;
  readonly sfx: SfxPlayer | null;
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
          // The trim, not the bus: the sequencer plays at the level the mix
          // wants, and the slider scales that.
          destination: graph.musicTrim,
          synth: graph.synth,
        });
  const sfx: SfxPlayer | null =
    graph === null ? null : createSfxPlayer(graph, pool);

  /** Which piece is playing, when it started, and where its layers sit. */
  let currentMusic: MusicId | null = null;
  let musicStartedAt = 0;
  /**
   * Seconds the gameplay suite has been *running*, which is not the same as
   * seconds since it last started: a pause replaces the suite with the pause
   * chirp and restarts it on the way out, and L1's two-bar entry must not
   * reset every time the player takes a breath.
   */
  let suiteElapsedS = 0;
  let lastPhase: StagePhase | null = null;
  let wasPaused = false;
  let clockFiltered = false;
  const layerAt = new Map<SuiteLayer, number>();

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

  /**
   * Is the context actually running? **Nothing is scheduled when it is not.**
   *
   * This is not an optimisation. A suspended context's `currentTime` does not
   * advance, so every voice built before the first gesture is scheduled at
   * time 0 and would all fire **at once** the moment the player presses a key —
   * and Chrome logs "The AudioContext was not allowed to start" for each one on
   * the way there (measured: ten warnings over the two-second stage-intro
   * curtain, which is a spawn bell per enemy plus the engine hum).
   *
   * Deliberately checked here rather than inside `sfx.ts`: an
   * `OfflineAudioContext` also reports `'suspended'` until `startRendering()`,
   * so a gate down there would make `scripts/capture-audio.ts` render silence.
   * This is the one layer that knows it owns a real-time context.
   */
  function audible(): boolean {
    return ctx !== null && ctx.state === 'running';
  }

  function playMusic(id: MusicId): void {
    if (graph === null || sequencer === null || !audible()) {
      return;
    }
    const chosen = MUSIC[id];
    // The layer gains have to be right BEFORE the first note, or every layer
    // arrives at full and ramps down — the loudest possible way to start a
    // piece that is supposed to fade in.
    if (id === 'suite') {
      for (const layer of SUITE_LAYERS) {
        const start = layer === 'L0' ? 1 : 0;
        sequencer.setLayerGain(layer, start, 0);
        layerAt.set(layer, start);
      }
    }
    graph.setDelayTempo(chosen.song.bpm);
    sequencer.play(chosen.song);
    currentMusic = id;
    musicStartedAt = graph.ctx.currentTime;
  }

  function stopMusic(): void {
    sequencer?.stop();
    currentMusic = null;
  }

  /**
   * Which piece belongs to which stage phase. This is the whole music driver:
   * the phase machine is already the game's narrative, so the music follows it
   * rather than keeping a second copy of the same story.
   */
  function onPhase(phase: StagePhase): void {
    switch (phase) {
      case 'intro':
        suiteElapsedS = 0;
        playMusic('fanfare');
        break;
      case 'playing':
        playMusic('suite');
        break;
      case 'cleared':
        playMusic('tally');
        break;
      case 'baseLost':
        // Nothing. The base explosion is a 1.2 s boom that ducks everything by
        // −12 dB; putting music under it would be putting music under a duck
        // built to remove it.
        stopMusic();
        break;
      case 'gameOver':
        playMusic('gameover');
        break;
    }
  }

  function updateMusic(state: GameState, dtMs: number): void {
    if (graph === null || sequencer === null) {
      return;
    }
    const now = graph.ctx.currentTime;

    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      onPhase(state.phase);
    }

    if (state.paused !== wasPaused) {
      wasPaused = state.paused;
      if (state.paused) {
        // Audio §4: "faithful two-note pause chirp; music halts while paused".
        // One action, not two: the chirp REPLACES the suite, and because it is
        // a one-shot the silence after it is the halt.
        playMusic('pause');
      } else if (state.phase === 'playing') {
        playMusic('suite');
      }
    }

    // A one-shot stops itself; there is no timer, because the audio clock is
    // already the only clock that matters here.
    if (currentMusic !== null && !MUSIC[currentMusic].loops) {
      const piece = MUSIC[currentMusic];
      if (now - musicStartedAt >= piece.durationS + START_PADDING_S) {
        stopMusic();
      }
    }

    if (currentMusic === 'suite' && !state.paused) {
      suiteElapsedS += dtMs / 1000;
      const targets = musicLayerTargets(state, suiteElapsedS / SUITE_BAR_S);
      for (const layer of SUITE_LAYERS) {
        const want = targets.layers[layer];
        // Only on a change: a 250 ms ramp re-scheduled sixty times a second is
        // a ramp that never arrives.
        if (layerAt.get(layer) !== want) {
          layerAt.set(layer, want);
          sequencer.setLayerGain(layer, want);
        }
      }
    }

    // Driven from `clockT` rather than from `clockStarted`/`clockEnded`: the
    // filter is a statement about a *duration*, and a state-derived flag cannot
    // be left stuck open by an event that arrived while the context was still
    // suspended.
    const wantFilter = state.clockT > 0;
    if (wantFilter !== clockFiltered) {
      clockFiltered = wantFilter;
      graph.setClockFreeze(wantFilter, now);
    }
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
    get sfx(): SfxPlayer | null {
      return sfx;
    },

    onEvent(e: GameEvent): void {
      if (graph === null || !audible()) {
        return;
      }
      // The sound first, then the hole it digs: `duck` anchors its ramp at the
      // gain's value *now*, and firing it before the voice exists would be the
      // same automation either way — but a reader should see the cause before
      // the consequence.
      sfx?.onEvent(e);
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
        default:
          break;
      }
    },

    update(state: GameState, dtMs: number): void {
      if (graph === null || !audible()) {
        return;
      }
      sinceReclaimMs += dtMs;
      if (sinceReclaimMs >= RECLAIM_INTERVAL_MS) {
        sinceReclaimMs = 0;
        pool.reclaim(graph.ctx.currentTime);
      }
      // The engine hums, the shield hum, the ice whoosh, the power-up sparkle
      // and the clock's tick-tock — everything that is a *state* rather than
      // an event.
      sfx?.update(state, dtMs);
      updateMusic(state, dtMs);
    },

    setVolumes(v: Volumes): void {
      graph?.setVolumes(v);
    },

    play(id: SfxId, pan = 0, intensity = 1): void {
      if (!audible()) {
        return;
      }
      sfx?.trigger(id, pan, intensity);
    },

    playMusic,
    stopMusic,

    resume,
    suspend,

    stats(): AudioStats {
      return {
        voices: pool.activeCount(),
        state: ctx?.state ?? 'none',
        running: ctx?.state === 'running',
        oneShots: sfx?.stats().oneShots ?? 0,
        music: currentMusic,
        layers: {
          L0: layerAt.get('L0') ?? 0,
          L1: layerAt.get('L1') ?? 0,
          L2: layerAt.get('L2') ?? 0,
          L3: layerAt.get('L3') ?? 0,
          L4: layerAt.get('L4') ?? 0,
        },
      };
    },

    dispose(): void {
      if (target !== null) {
        target.removeEventListener('blur', onBlur);
        target.removeEventListener('focus', onFocus);
      }
      sfx?.dispose();
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
