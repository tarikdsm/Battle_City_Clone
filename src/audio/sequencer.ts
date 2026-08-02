// src/audio/sequencer.ts — audio §2's lookahead scheduler and song format.
//
// ## Why a lookahead scheduler and not `setTimeout(playNote, …)`
//
// JavaScript timers are jittery by tens of milliseconds under load and stop
// firing altogether in a backgrounded tab. The Web Audio clock is a sample
// counter and is exact. So the timer here decides only **when to look**, never
// when a note sounds: every `pump()` walks forward over the tick grid and hands
// the synth absolute `AudioContext` times for everything falling inside the
// next {@link LOOKAHEAD_S}. A frame that takes 200 ms costs the scheduler
// nothing, because the notes for those 200 ms were already scheduled.
//
// The two numbers are audio §2's: a 120 ms window looked at every 25 ms, which
// gives roughly a 5× safety margin over the timer's own jitter.
//
// ## Tempo changes and loops
//
// `nextTime` is advanced by one tick at a time, so a tempo change takes effect
// from the **next** tick boundary and never retroactively moves a note already
// handed to the clock. The loop wrap is a wrap of the *tick*, not of the time:
// the grid keeps marching forward while the pattern starts over.
//
// ## Layers
//
// Each track names a layer, each layer is a `GainNode`, and layer gains ramp
// over {@link LAYER_RAMP_S}. That is the whole mechanism T5.3's adaptive suite
// needs — arps in, lead out, danger pad up — and it lives here rather than in
// the music so that the music is only ever note data.

import {
  PATCHES,
  createNote,
  midiToFreq,
  playNote,
  resetNote,
  type Note,
  type PatchId,
  type SynthRuntime,
} from './synth';

/** Audio §2's song format: 4 ticks to the quarter, i.e. a tick is a 16th. */
export const PPQ = 4;
/** How far ahead of the audio clock notes are scheduled, in seconds. */
export const LOOKAHEAD_S = 0.12;
/** How often the scheduler looks, in milliseconds. */
export const SCHEDULER_INTERVAL_MS = 25;
/** Layer-gain smoothing, in seconds. */
export const LAYER_RAMP_S = 0.25;
/**
 * Pre-roll between `play()` and the downbeat. One lookahead window: enough that
 * the first tick is scheduled rather than already late, short enough that a
 * stage fanfare still feels like it starts when the stage does.
 */
export const START_PADDING_S = 0.05;

/** Most ticks one live lookahead pass may schedule. */
const LIVE_TICKS_PER_PUMP = 512;
/** …and one offline pass, which lays down a whole clip in one go. */
const OFFLINE_TICKS_PER_PUMP = 200_000;

/** `[tick, midi, durTicks, vel]` — audio §2, verbatim. */
export type SongStep = readonly [
  tick: number,
  midi: number,
  durTicks: number,
  vel: number,
];

export interface SongTrack {
  readonly instrument: PatchId;
  readonly layer: string;
  readonly steps: readonly SongStep[];
}

export interface Song {
  readonly bpm: number;
  readonly ppq: typeof PPQ;
  readonly tracks: readonly SongTrack[];
  readonly loopAtTick: number;
}

/** Seconds per tick at a tempo. A tick is a 16th note at `ppq: 4`. */
export function secondsPerTick(bpm: number): number {
  return 60 / (bpm * PPQ);
}

/** Sixteen sixteenths to a 4/4 bar at `ppq: 4`. */
export const TICKS_PER_BAR = PPQ * 4;

/** Seconds of content in a song — the end of its last note, not its loop point. */
export function songDurationS(song: Song): number {
  let last = 0;
  for (const track of song.tracks) {
    for (const step of track.steps) {
      const end = step[0] + step[2];
      last = end > last ? end : last;
    }
  }
  return last * secondsPerTick(song.bpm);
}

/**
 * A song plus how it is meant to be played. The `Song` itself stays exactly the
 * four fields audio §2 specifies — this is the wrapper that says whether the
 * piece repeats and, for the one-shots, when the sequencer should be stopped.
 */
export interface MusicPiece {
  readonly song: Song;
  readonly loops: boolean;
  readonly durationS: number;
}

export function piece(song: Song, loops: boolean): MusicPiece {
  return Object.freeze({ song, loops, durationS: songDurationS(song) });
}

// ---------------------------------------------------------------------------
// Composition helpers
//
// A song is note data, and these are the four operations that keep note data
// readable: place a phrase, repeat it, move it, and lay down an ostinato. They
// live here rather than in a songs/ helper because they operate on the song
// FORMAT, which is this file's business.
// ---------------------------------------------------------------------------

/** Places a phrase whose ticks are written relative to its own start. */
export function phrase(at: number, entries: readonly SongStep[]): SongStep[] {
  return entries.map((e) => [at + e[0], e[1], e[2], e[3]] as SongStep);
}

/** `times` copies of `steps`, `everyTicks` apart. */
export function repeat(
  steps: readonly SongStep[],
  times: number,
  everyTicks: number,
): SongStep[] {
  const out: SongStep[] = [];
  for (let i = 0; i < times; i++) {
    for (const s of steps) {
      out.push([s[0] + i * everyTicks, s[1], s[2], s[3]]);
    }
  }
  return out;
}

/** The same notes, `semitones` higher. */
export function transpose(
  steps: readonly SongStep[],
  semitones: number,
): SongStep[] {
  return steps.map((s) => [s[0], s[1] + semitones, s[2], s[3]] as SongStep);
}

/**
 * A note every `everyTicks` from `from` (inclusive) to `to` (exclusive),
 * cycling through `midis`. This is how the L0 ostinato — the musicalised
 * engine hum — is written, and it is the one figure in the suite that runs
 * unbroken from the first tick to the last.
 */
export function ostinato(
  from: number,
  to: number,
  everyTicks: number,
  midis: readonly number[],
  durTicks: number,
  vel: number,
): SongStep[] {
  const out: SongStep[] = [];
  let i = 0;
  for (let t = from; t < to; t += everyTicks) {
    out.push([t, midis[i % midis.length], durTicks, vel]);
    i++;
  }
  return out;
}

/** Concatenates note lists, for a track built from several figures. */
export function merge(...lists: readonly SongStep[][]): SongStep[] {
  const out: SongStep[] = [];
  for (const list of lists) {
    for (const s of list) {
      out.push(s);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * How a scheduled step becomes sound. Injected so the tests can watch the
 * scheduler without a synth, and so T5.3 can re-voice a song without touching
 * this file.
 */
export type NoteSink = (
  patch: PatchId,
  freq: number,
  when: number,
  holdS: number,
  vel: number,
  dest: AudioNode,
) => void;

export interface SequencerOptions {
  ctx: BaseAudioContext;
  /** Where the layer gains connect — the music bus. */
  destination: AudioNode;
  /** Defaults to `synth.playNote` when a {@link SynthRuntime} is given. */
  emit?: NoteSink;
  synth?: SynthRuntime;
  /** Defaults to `setInterval`; injected in tests. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface Sequencer {
  play(song: Song): void;
  /** Stops scheduling. Notes already handed to the clock still sound. */
  stop(): void;
  playing(): boolean;
  setBpm(bpm: number): void;
  bpm(): number;
  /** Ramps a layer to `target` over {@link LAYER_RAMP_S}. */
  setLayerGain(layer: string, target: number, rampS?: number): void;
  layerGain(layer: string): number;
  /** The layer's gain node, created on first use. */
  layerNode(layer: string): GainNode | null;
  /** One lookahead pass. The timer calls this; tests call it by hand. */
  pump(): void;
  /**
   * Schedules every note up to an absolute context time.
   *
   * `pump()` is this with the lookahead horizon. It exists because an
   * `OfflineAudioContext` renders from a `currentTime` that never advances, so
   * the capture harness has to lay the whole clip down before it starts —
   * there is no later in which to pump.
   */
  pumpTo(horizonS: number): void;
  dispose(): void;
}

export function createSequencer(opts: SequencerOptions): Sequencer {
  const ctx = opts.ctx;
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): number =>
      setInterval(fn, ms) as unknown as number);
  const clearTimer =
    opts.clearTimer ??
    ((handle: number): void => {
      clearInterval(handle);
    });

  const synth = opts.synth ?? null;
  // One shared note record for the whole sequencer — a song is note data, and
  // note data does not allocate.
  const scratch: Note = createNote();
  const emit: NoteSink =
    opts.emit ??
    ((patch, freq, when, holdS, vel, dest): void => {
      if (synth === null) {
        return;
      }
      resetNote(scratch);
      scratch.freq = freq;
      scratch.vel = vel;
      scratch.holdMs = holdS * 1000;
      // Audio §3: "hat … D30 (closed) / D120 (open)". A percussive patch has
      // `s: 0`, so holding a step longer does nothing to it — a step longer
      // than one tick is the only way the song format can ask for the open
      // one, and this is what makes that ask mean something.
      const spec = PATCHES[patch];
      if (spec.openDecayMs > 0 && holdS > spt * 1.5) {
        scratch.decayMs = spec.openDecayMs;
      }
      playNote(synth, patch, scratch, when, dest, null);
    });

  const layers = new Map<string, GainNode>();
  const layerTargets = new Map<string, number>();

  let song: Song | null = null;
  /** Steps per track, sorted by tick. Rebuilt once per `play`. */
  let tracks: SongStep[][] = [];
  let cursors: number[] = [];
  let dests: (GainNode | null)[] = [];
  let handle: number | null = null;
  let spt = secondsPerTick(120);
  let tempo = 120;
  let nextTick = 0;
  let nextTime = 0;

  function layerNode(layer: string): GainNode {
    const found = layers.get(layer);
    if (found !== undefined) {
      return found;
    }
    const node = ctx.createGain();
    node.gain.value = layerTargets.get(layer) ?? 1;
    node.connect(opts.destination);
    layers.set(layer, node);
    layerTargets.set(layer, node.gain.value);
    return node;
  }

  function scheduleTick(tick: number, when: number): void {
    for (let t = 0; t < tracks.length; t++) {
      const steps = tracks[t];
      const track = song?.tracks[t];
      if (track === undefined) {
        continue;
      }
      let cursor = cursors[t];
      // Steps are sorted, so this is a walk, not a search: at most one
      // comparison per track per tick when the tick is empty.
      while (cursor < steps.length && steps[cursor][0] === tick) {
        const step = steps[cursor];
        const dest = dests[t];
        if (dest !== null) {
          emit(
            track.instrument,
            midiToFreq(step[1]),
            when,
            step[2] * spt,
            step[3],
            dest,
          );
        }
        cursor++;
      }
      cursors[t] = cursor;
    }
  }

  function walkTo(horizon: number, maxTicks: number): void {
    if (song === null || !(spt > 0)) {
      return;
    }
    let guard = 0;
    while (nextTime < horizon && guard < maxTicks) {
      guard++;
      scheduleTick(nextTick, nextTime);
      nextTime += spt;
      nextTick++;
      if (nextTick >= song.loopAtTick) {
        nextTick = 0;
        for (let i = 0; i < cursors.length; i++) {
          cursors[i] = 0;
        }
      }
    }
  }

  function pump(): void {
    // The live path, bounded: a tab that was suspended for a minute comes back
    // with a horizon far ahead of `nextTime`, and dumping a minute of notes
    // into the graph at once is how a returning tab locks up.
    walkTo(ctx.currentTime + LOOKAHEAD_S, LIVE_TICKS_PER_PUMP);
  }

  return {
    play(next: Song): void {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      song = next;
      tempo = next.bpm;
      spt = secondsPerTick(tempo);
      tracks = next.tracks.map((t) => [...t.steps].sort((a, b) => a[0] - b[0]));
      cursors = next.tracks.map(() => 0);
      dests = next.tracks.map((t) => layerNode(t.layer));
      nextTick = 0;
      nextTime = ctx.currentTime + START_PADDING_S;
      pump();
      handle = setTimer(pump, SCHEDULER_INTERVAL_MS);
    },

    stop(): void {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      song = null;
    },

    playing(): boolean {
      return song !== null;
    },

    setBpm(bpm: number): void {
      if (!Number.isFinite(bpm) || bpm <= 0) {
        return;
      }
      tempo = bpm;
      spt = secondsPerTick(bpm);
    },

    bpm(): number {
      return tempo;
    },

    setLayerGain(layer: string, target: number, rampS = LAYER_RAMP_S): void {
      const value = Number.isFinite(target) ? Math.max(0, Math.min(1, target)) : 0; // prettier-ignore
      const node = layerNode(layer);
      const now = ctx.currentTime;
      // Cancel-then-anchor: without the `setValueAtTime` a second change mid-ramp
      // jumps to wherever the previous ramp *started* instead of bending from
      // where the gain actually is.
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(value, now + rampS);
      layerTargets.set(layer, value);
    },

    layerGain(layer: string): number {
      return layerTargets.get(layer) ?? 1;
    },

    layerNode(layer: string): GainNode | null {
      return layers.get(layer) ?? null;
    },

    pump,

    pumpTo(horizonS: number): void {
      walkTo(horizonS, OFFLINE_TICKS_PER_PUMP);
    },

    dispose(): void {
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      song = null;
      for (const node of layers.values()) {
        node.disconnect();
      }
      layers.clear();
      layerTargets.clear();
    },
  };
}
