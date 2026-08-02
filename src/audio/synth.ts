// src/audio/synth.ts — the instrument patch registry of audio §3.
//
// **Everything here is synthesized.** There is not one sample in this project
// and there never will be (GDD §3, audio §1): every sound is oscillators, a
// noise buffer the engine generates at start-up, biquad filters and gain
// envelopes. That constraint is what keeps the whole game code-only, and this
// file is where it is paid for.
//
// ## Three deliberate choices
//
// **Pulse waves are `PeriodicWave`s, not wave-shaped saws.** Audio §3 writes
// the recipe as "square via wave-shaper duty". A `WaveShaper` on a saw does
// produce a variable-duty pulse, and it also produces every alias above
// Nyquist that the shaped edge implies — at 12.5% duty, which is the engine
// hum, the folded partials are loud enough to hear as a metallic ring on high
// notes. `createPeriodicWave` band-limits by construction and is cheaper (one
// node instead of two). The Fourier coefficients of a duty-`d` pulse are
// closed-form, so the duty knob is exact rather than approximated. Reported for
// a §3 amendment; the *sound* the doc asks for is what ships.
//
// **The context is a parameter, never a global.** Every function here takes its
// `BaseAudioContext`, which is what lets the suite run in Node with no audio
// device and lets `scripts/capture-audio.ts` render the identical graph through
// an `OfflineAudioContext`.
//
// **Notes and voices are reused records, not fresh objects.** A busy board can
// fire a dozen SFX in a frame; `Note` is a mutable struct the caller owns and
// re-fills (the same trick `render/fx/fxSystem.ts` uses for particle spawns),
// and `VoiceSlot` is preallocated by the voice pool. Nothing in this file
// allocates a JS object per note except the Web Audio nodes themselves, which
// the API requires: `OscillatorNode.start()` may be called exactly once, so a
// source node genuinely cannot be pooled.

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** MIDI note number → Hz, A440. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Decibels → linear gain. −6 dB is 0.501, −12 dB is 0.251. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Semitones → a `detune` value in cents. */
export function semitones(st: number): number {
  return st * 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export type PatchId =
  | 'pulse50'
  | 'pulse25'
  | 'pulse12'
  | 'triBass'
  | 'kick'
  | 'snare'
  | 'hat'
  | 'pad'
  | 'bell'
  | 'noiseFx';

export const PATCH_IDS: readonly PatchId[] = Object.freeze([
  'pulse50',
  'pulse25',
  'pulse12',
  'triBass',
  'kick',
  'snare',
  'hat',
  'pad',
  'bell',
  'noiseFx',
]);

/** The three duties audio §3 names, and the only patches with a wave table. */
export type PulseId = 'pulse50' | 'pulse25' | 'pulse12';

/** Attack/decay/release in **milliseconds**, sustain as a 0..1 level. */
export interface Adsr {
  readonly a: number;
  readonly d: number;
  readonly s: number;
  readonly r: number;
}

/**
 * One row of audio §3's table, spelled out. Every field is present on every
 * patch — a `0` means "this patch does not use it" — so the table reads as a
 * table and `playNote` never has to ask whether a property exists.
 */
export interface PatchSpec {
  readonly env: Adsr;
  /** Envelope peak at velocity 1, before the bus and master gains. */
  readonly gain: number;
  /** Pulse duty 0..1; 0 for every non-pulse patch. */
  readonly duty: number;
  /** Oscillator shape for the non-pulse patches. */
  readonly wave: OscillatorType;
  /** Sub-oscillator level relative to the main one, in dB. 0 = no sub. */
  readonly subDb: number;
  /** Static voice filter. `filterType === null` means no filter. */
  readonly filterHz: number;
  readonly filterType: BiquadFilterType | null;
  readonly filterQ: number;
  /** Vibrato rate and depth. Depth 0 = off (audio §3 marks it "optional"). */
  readonly vibratoHz: number;
  readonly vibratoCents: number;
  /** Detune spread for stacked oscillators, in cents (pad: ±8). */
  readonly spreadCents: number;
  /** Haas width delay in ms (pad: 12). 0 = mono voice. */
  readonly haasMs: number;
  /** 2-op FM (bell): modulator ratio, index in multiples of f0, index decay. */
  readonly fmRatio: number;
  readonly fmIndex: number;
  readonly fmDecayMs: number;
  /** Pitch sweep. `sweepFromHz === 0` means "start at the note's own pitch". */
  readonly sweepFromHz: number;
  readonly sweepToHz: number;
  readonly sweepMs: number;
  /** Snare's sine body, in Hz. */
  readonly bodyHz: number;
  /** Hat's open-decay alternative, in ms (audio §3: D30 closed / D120 open). */
  readonly openDecayMs: number;
  /** Kick's click transient, in ms. */
  readonly clickMs: number;
}

const PATCH_DEFAULTS: PatchSpec = {
  env: { a: 5, d: 40, s: 0.7, r: 60 },
  gain: 0.5,
  duty: 0,
  wave: 'sine',
  subDb: 0,
  filterHz: 0,
  filterType: null,
  filterQ: 1,
  vibratoHz: 0,
  vibratoCents: 0,
  spreadCents: 0,
  haasMs: 0,
  fmRatio: 0,
  fmIndex: 0,
  fmDecayMs: 0,
  sweepFromHz: 0,
  sweepToHz: 0,
  sweepMs: 0,
  bodyHz: 0,
  openDecayMs: 0,
  clickMs: 0,
};

function patch(over: Partial<PatchSpec>): PatchSpec {
  return Object.freeze({ ...PATCH_DEFAULTS, ...over });
}

/**
 * Audio §3's table, transcribed. The ADSR numbers are the doc's own; the gains
 * are the mix balance that §6's "SFX peaks −6 dB below the limiter ceiling"
 * implies once every voice is summed through the shared compressor.
 */
export const PATCHES: Readonly<Record<PatchId, PatchSpec>> = Object.freeze({
  // "square via wave-shaper duty; vibrato 6 Hz ±10 cents optional; A5 D40 S0.7 R60"
  pulse50: patch({ duty: 0.5, vibratoHz: 6, gain: 0.32 }),
  pulse25: patch({ duty: 0.25, vibratoHz: 6, gain: 0.32 }),
  pulse12: patch({ duty: 0.125, vibratoHz: 6, gain: 0.28 }),
  // "triangle osc + subSine one octave down at −12 dB; A5 D30 S0.9 R80"
  triBass: patch({
    wave: 'triangle',
    subDb: -12,
    env: { a: 5, d: 30, s: 0.9, r: 80 },
    gain: 0.5,
  }),
  // "sine pitch-swept 150→48 Hz over 90 ms + click transient; A0 D90"
  kick: patch({
    wave: 'sine',
    env: { a: 0, d: 90, s: 0, r: 20 },
    sweepFromHz: 150,
    sweepToHz: 48,
    sweepMs: 90,
    clickMs: 3,
    gain: 0.85,
  }),
  // "white noise bandpass 1.8 kHz + 200 Hz sine body 60 ms"
  snare: patch({
    env: { a: 1, d: 60, s: 0, r: 30 },
    filterType: 'bandpass',
    filterHz: 1800,
    filterQ: 0.9,
    bodyHz: 200,
    gain: 0.55,
  }),
  // "white noise highpass 6 kHz, D30 (closed) / D120 (open)"
  hat: patch({
    env: { a: 1, d: 30, s: 0, r: 10 },
    filterType: 'highpass',
    filterHz: 6000,
    filterQ: 0.7,
    openDecayMs: 120,
    gain: 0.3,
  }),
  // "2 detuned saws (±8 cents) → lowpass 1.2 kHz, A400 D200 S0.6 R600,
  //  width via haas 12 ms"
  pad: patch({
    wave: 'sawtooth',
    env: { a: 400, d: 200, s: 0.6, r: 600 },
    filterType: 'lowpass',
    filterHz: 1200,
    filterQ: 0.8,
    spreadCents: 8,
    haasMs: 12,
    gain: 0.22,
  }),
  // "2-op FM, ratio 3.01, index decay 300 ms — power-ups/UI sparkle"
  bell: patch({
    wave: 'sine',
    env: { a: 2, d: 260, s: 0, r: 180 },
    fmRatio: 3.01,
    fmIndex: 2.4,
    fmDecayMs: 300,
    gain: 0.42,
  }),
  // "shaped noise bursts, per-SFX filters"
  noiseFx: patch({
    env: { a: 1, d: 90, s: 0, r: 40 },
    filterType: 'bandpass',
    filterHz: 800,
    filterQ: 1.2,
    gain: 0.6,
  }),
});

// ---------------------------------------------------------------------------
// The shared runtime — the things every voice borrows
// ---------------------------------------------------------------------------

/** Seconds of white noise held resident. Long enough that a random offset into
 *  it never repeats audibly across the burst lengths §5 asks for. */
const NOISE_SECONDS = 2;
/** Partials in a pulse wave table. 48 covers the audible band above ~450 Hz
 *  and costs nothing at run time — the table is built three times, ever. */
const PULSE_HARMONICS = 48;

/**
 * The noise buffer is generated from a **seeded** generator, not `Math.random`.
 * `docs/calibration/audio.json` records the peak, RMS and spectral centroid of
 * every rendered SFX as a regression net, and a net whose numbers drift by a
 * few tenths of a dB every run catches nothing.
 */
function seededNoise(length: number, out: Float32Array): void {
  let s = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  }
}

export interface SynthRuntime {
  readonly ctx: BaseAudioContext;
  /** One white-noise buffer, shared by every noise voice for the session. */
  readonly noise: AudioBuffer;
  readonly waves: Readonly<Record<PulseId, PeriodicWave>>;
}

/**
 * The Fourier series of a duty-`d` pulse: `real[n] = (2/nπ)·sin(nπd)`. At
 * d = 0.5 every even term vanishes and it is a square; at d = 0.125 the even
 * terms are what make the NES engine hum nasal instead of hollow.
 */
export function pulseWave(
  ctx: BaseAudioContext,
  duty: number,
  harmonics: number = PULSE_HARMONICS,
): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  return ctx.createPeriodicWave(real, imag);
}

export function createSynthRuntime(ctx: BaseAudioContext): SynthRuntime {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const noise = ctx.createBuffer(1, length, ctx.sampleRate);
  seededNoise(length, noise.getChannelData(0));
  return {
    ctx,
    noise,
    waves: Object.freeze({
      pulse50: pulseWave(ctx, PATCHES.pulse50.duty),
      pulse25: pulseWave(ctx, PATCHES.pulse25.duty),
      pulse12: pulseWave(ctx, PATCHES.pulse12.duty),
    }),
  };
}

// ---------------------------------------------------------------------------
// Notes and voices — mutable records, reused
// ---------------------------------------------------------------------------

/**
 * One note about to be played. **Owned and re-filled by the caller**: the SFX
 * registry keeps exactly one of these and rewrites it per event, so a busy
 * frame allocates nothing here.
 *
 * A `0` (or `null`) in any override field means "use the patch's own value".
 */
export interface Note {
  freq: number;
  /** 0..1; scales the envelope peak. */
  vel: number;
  /** Extra linear trim on top of velocity. 1 = the patch's own level. */
  gain: number;
  /** How long to hold the sustain before releasing, in ms. */
  holdMs: number;
  /** −1..1. A non-zero pan is what inserts the (single) panner node. */
  pan: number;
  detuneCents: number;
  releaseMs: number;
  decayMs: number;
  filterHz: number;
  filterQ: number;
  filterType: BiquadFilterType | null;
  sweepToHz: number;
  sweepMs: number;
  vibratoCents: number;
}

export function createNote(): Note {
  const note: Note = {
    freq: 440,
    vel: 1,
    gain: 1,
    holdMs: 0,
    pan: 0,
    detuneCents: 0,
    releaseMs: 0,
    decayMs: 0,
    filterHz: 0,
    filterQ: 0,
    filterType: null,
    sweepToHz: 0,
    sweepMs: 0,
    vibratoCents: 0,
  };
  return note;
}

export function resetNote(note: Note): void {
  note.freq = 440;
  note.vel = 1;
  note.gain = 1;
  note.holdMs = 0;
  note.pan = 0;
  note.detuneCents = 0;
  note.releaseMs = 0;
  note.decayMs = 0;
  note.filterHz = 0;
  note.filterQ = 0;
  note.filterType = null;
  note.sweepToHz = 0;
  note.sweepMs = 0;
  note.vibratoCents = 0;
}

/** The most source nodes any one patch builds (pad's saws, kick's click…). */
export const MAX_VOICE_SOURCES = 4;

/**
 * A live voice, as the pool sees it. Preallocated and rewritten; `sources` is
 * the same array for the lifetime of the slot.
 */
export interface VoiceSlot {
  active: boolean;
  patch: PatchId | '';
  startTime: number;
  endTime: number;
  /** The envelope gain, so a stolen voice can be faded rather than cut. */
  env: GainNode | null;
  sources: (AudioScheduledSourceNode | null)[];
  count: number;
}

export function createVoiceSlot(): VoiceSlot {
  const sources: (AudioScheduledSourceNode | null)[] = [];
  for (let i = 0; i < MAX_VOICE_SOURCES; i++) {
    sources.push(null);
  }
  return {
    active: false,
    patch: '',
    startTime: 0,
    endTime: 0,
    env: null,
    sources,
    count: 0,
  };
}

/** Where `playNote` writes when the caller does not care about the voice. */
const SCRATCH_SLOT: VoiceSlot = createVoiceSlot();
/** Reused so a `decayMs` override does not allocate an `Adsr` per note. */
const SCRATCH_ENV: { a: number; d: number; s: number; r: number } = {
  a: 0,
  d: 0,
  s: 0,
  r: 0,
};

function withDecay(base: Adsr, decayMs: number): Adsr {
  SCRATCH_ENV.a = base.a;
  SCRATCH_ENV.d = decayMs;
  SCRATCH_ENV.s = base.s;
  SCRATCH_ENV.r = base.r;
  return SCRATCH_ENV;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Smallest positive value an exponential ramp may target (it cannot reach 0). */
const EXP_FLOOR = 1e-4;
/** Slack between the end of the envelope and the source's `stop()`. */
export const STOP_PAD_S = 0.02;

/**
 * Schedules audio §3's ADSR onto one `AudioParam` and returns the time the
 * envelope reaches silence.
 *
 * Linear ramps throughout, deliberately: an exponential ramp cannot reach zero,
 * and the difference between a linear and an exponential 60 ms tail is not
 * audible on sounds this short — while "the release never actually ended" is a
 * voice that never frees its slot.
 *
 * @param holdS how long the sustain is held **from `when`**. A hold shorter
 *              than A+D simply releases out of the decay.
 * @param releaseMs 0 = the patch's own R.
 */
export function applyAdsr(
  param: AudioParam,
  when: number,
  peak: number,
  env: Adsr,
  holdS: number,
  releaseMs = 0,
): number {
  const a = env.a / 1000;
  const d = env.d / 1000;
  const r = (releaseMs > 0 ? releaseMs : env.r) / 1000;
  const sustain = peak * env.s;

  param.setValueAtTime(0, when);
  if (a > 0) {
    param.linearRampToValueAtTime(peak, when + a);
  } else {
    // A0 is a jump, not a zero-length ramp: a ramp whose end time equals the
    // previous event's is a no-op in some implementations, and a kick that
    // starts at zero has no click at all.
    param.setValueAtTime(peak, when);
  }
  param.linearRampToValueAtTime(sustain, when + a + d);

  const releaseAt = Math.max(when + a + d, when + holdS);
  if (releaseAt > when + a + d) {
    param.setValueAtTime(sustain, releaseAt);
  }
  param.linearRampToValueAtTime(0, releaseAt + r);
  return releaseAt + r;
}

// ---------------------------------------------------------------------------
// Voice construction
// ---------------------------------------------------------------------------

function addSource(slot: VoiceSlot, node: AudioScheduledSourceNode): void {
  if (slot.count < MAX_VOICE_SOURCES) {
    slot.sources[slot.count] = node;
    slot.count++;
  }
}

/** A noise source over the shared buffer, entering at a pseudo-random offset. */
function noiseSource(
  rt: SynthRuntime,
  when: number,
  stopAt: number,
  slot: VoiceSlot,
): AudioBufferSourceNode {
  const src = rt.ctx.createBufferSource();
  src.buffer = rt.noise;
  src.loop = true;
  // Derived from the start time rather than drawn: two shots in the same frame
  // must not phase-cancel, and the render harness must be reproducible.
  const offset = (when * 977) % (rt.noise.duration * 0.9);
  src.start(when, offset);
  src.stop(stopAt);
  addSource(slot, src);
  return src;
}

function oscSource(
  rt: SynthRuntime,
  type: OscillatorType,
  freq: number,
  when: number,
  stopAt: number,
  slot: VoiceSlot,
): OscillatorNode {
  const osc = rt.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  osc.start(when);
  osc.stop(stopAt);
  addSource(slot, osc);
  return osc;
}

/**
 * Plays one note of one patch, starting at `when` on the context's clock.
 *
 * @param slot filled in with the live voice, for the pool's budget and voice
 *             stealing. `null` uses a shared scratch record.
 * @returns the time the voice falls silent.
 */
export function playNote(
  rt: SynthRuntime,
  patchId: PatchId,
  note: Note,
  when: number,
  dest: AudioNode,
  slot: VoiceSlot | null,
): number {
  const ctx = rt.ctx;
  const spec = PATCHES[patchId];
  const target = slot ?? SCRATCH_SLOT;
  const freq = note.freq > 0 ? note.freq : 440;
  const peak = spec.gain * clamp(note.vel, 0, 1) * (note.gain > 0 ? note.gain : 1); // prettier-ignore

  target.active = true;
  target.patch = patchId;
  target.startTime = when;
  target.count = 0;

  // --- the envelope, and everything downstream of it ----------------------
  const envNode = ctx.createGain();
  const env = note.decayMs > 0 ? withDecay(spec.env, note.decayMs) : spec.env;
  const end = applyAdsr(
    envNode.gain,
    when,
    peak,
    env,
    note.holdMs / 1000,
    note.releaseMs,
  );
  const stopAt = end + STOP_PAD_S;
  target.env = envNode;
  target.endTime = end;

  if (spec.haasMs > 0) {
    // Audio §3's pad width: the same signal in both ears, one of them late by
    // 12 ms. Below the ~30 ms echo threshold the ear reads the delay as width.
    const left = ctx.createStereoPanner();
    left.pan.value = -0.7;
    const right = ctx.createStereoPanner();
    right.pan.value = 0.7;
    const haas = ctx.createDelay(0.1);
    haas.delayTime.value = spec.haasMs / 1000;
    envNode.connect(left);
    left.connect(dest);
    envNode.connect(haas);
    haas.connect(right);
    right.connect(dest);
  } else if (note.pan !== 0) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(note.pan, -1, 1);
    envNode.connect(panner);
    panner.connect(dest);
  } else {
    envNode.connect(dest);
  }

  // --- the voice filter ----------------------------------------------------
  const filterType = note.filterType ?? spec.filterType;
  const filterHz = note.filterHz > 0 ? note.filterHz : spec.filterHz;
  let head: AudioNode = envNode;
  if (filterType !== null && filterHz > 0) {
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterHz;
    filter.Q.value = note.filterQ > 0 ? note.filterQ : spec.filterQ;
    filter.connect(envNode);
    head = filter;
  }

  // --- the sources ---------------------------------------------------------
  switch (patchId) {
    case 'pulse50':
    case 'pulse25':
    case 'pulse12': {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(rt.waves[patchId]);
      osc.frequency.setValueAtTime(freq, when);
      applySweep(osc.frequency, freq, note, spec, when);
      if (note.detuneCents !== 0) {
        osc.detune.value = note.detuneCents;
      }
      const vibCents =
        note.vibratoCents > 0 ? note.vibratoCents : spec.vibratoCents;
      if (vibCents > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = spec.vibratoHz;
        const depth = ctx.createGain();
        depth.gain.value = vibCents;
        lfo.connect(depth);
        depth.connect(osc.detune);
        lfo.start(when);
        lfo.stop(stopAt);
        addSource(target, lfo);
      }
      osc.connect(head);
      osc.start(when);
      osc.stop(stopAt);
      addSource(target, osc);
      break;
    }

    case 'triBass': {
      const osc = oscSource(rt, spec.wave, freq, when, stopAt, target);
      applySweep(osc.frequency, freq, note, spec, when);
      osc.connect(head);
      // The sub is an octave down, at the level audio §3 prints.
      const sub = oscSource(rt, 'sine', freq / 2, when, stopAt, target);
      const trim = ctx.createGain();
      trim.gain.value = dbToGain(spec.subDb);
      sub.connect(trim);
      trim.connect(head);
      break;
    }

    case 'kick': {
      const body = oscSource(
        rt,
        spec.wave,
        spec.sweepFromHz,
        when,
        stopAt,
        target,
      );
      body.frequency.exponentialRampToValueAtTime(
        Math.max(spec.sweepToHz, EXP_FLOOR),
        when + spec.sweepMs / 1000,
      );
      body.connect(head);
      // The click: a few milliseconds of top-end that the sweep alone has no
      // way to produce, and the difference between a kick and a bass note.
      const click = noiseSource(rt, when, when + spec.clickMs / 1000, target);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      const clickGain = ctx.createGain();
      applyAdsr(clickGain.gain, when, 0.5, CLICK_ENV, 0, 0);
      click.connect(hp);
      hp.connect(clickGain);
      clickGain.connect(head);
      break;
    }

    case 'snare': {
      noiseSource(rt, when, stopAt, target).connect(head);
      const body = oscSource(rt, 'sine', spec.bodyHz, when, stopAt, target);
      body.frequency.exponentialRampToValueAtTime(
        spec.bodyHz * 0.7,
        when + spec.env.d / 1000,
      );
      const bodyGain = ctx.createGain();
      bodyGain.gain.value = 0.7;
      body.connect(bodyGain);
      bodyGain.connect(envNode); // the body bypasses the noise band-pass
      break;
    }

    case 'hat':
    case 'noiseFx': {
      noiseSource(rt, when, stopAt, target).connect(head);
      break;
    }

    case 'pad': {
      for (let i = 0; i < 2; i++) {
        const saw = oscSource(rt, spec.wave, freq, when, stopAt, target);
        saw.detune.value =
          (i === 0 ? -spec.spreadCents : spec.spreadCents) + note.detuneCents;
        saw.connect(head);
      }
      break;
    }

    case 'bell': {
      const carrier = oscSource(rt, 'sine', freq, when, stopAt, target);
      carrier.connect(head);
      const mod = oscSource(rt, 'sine', freq * spec.fmRatio, when, stopAt, target); // prettier-ignore
      // The index is in Hz of carrier deviation, so it scales with the note —
      // that is what keeps the timbre constant up the keyboard.
      const index = ctx.createGain();
      const peakIndex = freq * spec.fmIndex;
      index.gain.setValueAtTime(peakIndex, when);
      index.gain.exponentialRampToValueAtTime(
        Math.max(peakIndex * 0.01, EXP_FLOOR),
        when + spec.fmDecayMs / 1000,
      );
      mod.connect(index);
      index.connect(carrier.frequency);
      break;
    }
  }

  for (let i = target.count; i < MAX_VOICE_SOURCES; i++) {
    target.sources[i] = null;
  }
  return end;
}

/** The kick's click transient — short enough to be a transient, not a noise. */
const CLICK_ENV: Adsr = Object.freeze({ a: 0, d: 3, s: 0, r: 1 });

function applySweep(
  param: AudioParam,
  freq: number,
  note: Note,
  spec: PatchSpec,
  when: number,
): void {
  const to = note.sweepToHz > 0 ? note.sweepToHz : spec.sweepToHz;
  const ms = note.sweepMs > 0 ? note.sweepMs : spec.sweepMs;
  if (to <= 0 || ms <= 0 || to === freq) {
    return;
  }
  param.exponentialRampToValueAtTime(Math.max(to, EXP_FLOOR), when + ms / 1000);
}

/**
 * Ends a voice early — the voice-stealing path. The envelope is ramped out over
 * `fadeMs` rather than cut, because a source stopped mid-cycle is a click, and
 * a stolen voice that clicks is worse than the voice it made room for.
 */
export function stopVoice(slot: VoiceSlot, when: number, fadeMs: number): void {
  if (!slot.active) {
    return;
  }
  const at = when + fadeMs / 1000;
  const env = slot.env;
  if (env !== null) {
    env.gain.cancelScheduledValues(when);
    env.gain.setValueAtTime(env.gain.value, when);
    env.gain.linearRampToValueAtTime(0, at);
  }
  for (let i = 0; i < slot.count; i++) {
    slot.sources[i]?.stop(at);
  }
  slot.active = false;
  slot.endTime = at;
}
