// tests/audio/sequencer.test.ts — the lookahead scheduler of audio §2 (T5.1).
//
// The scheduler is the one piece of the audio layer where being wrong is
// inaudible until it is unbearable: a note scheduled from a `setTimeout`
// callback instead of against `AudioContext.currentTime` sounds fine on an idle
// machine and falls apart the moment a frame takes 40 ms. So the whole point of
// this suite is that **every note-on time is computed from the audio clock**,
// that the timer only ever decides *when to look*, and that the answer survives
// a tempo change and a loop wrap.
//
// Both the context and the timer are injected, so this runs in Node with no
// audio device and no real time passing.

import { describe, expect, it, vi } from 'vitest';

import type { PatchId } from '../../src/audio/synth';
import {
  LAYER_RAMP_S,
  LOOKAHEAD_S,
  PPQ,
  SCHEDULER_INTERVAL_MS,
  createSequencer,
  secondsPerTick,
  type Sequencer,
  type Song,
} from '../../src/audio/sequencer';

import {
  FakeAudioContext,
  asAudioContext,
  fakeGain,
  fakeNode,
} from './fakeContext';

interface Emitted {
  patch: PatchId;
  freq: number;
  when: number;
  holdS: number;
  vel: number;
  dest: AudioNode;
}

interface Rig {
  fake: FakeAudioContext;
  seq: Sequencer;
  out: GainNode;
  notes: Emitted[];
  /** Run the scheduler timer the way the browser would. */
  fire(): void;
  intervalMs: number;
}

function rig(): Rig {
  const fake = new FakeAudioContext();
  const ctx = asAudioContext(fake);
  const out = ctx.createGain();
  const notes: Emitted[] = [];
  let timer: (() => void) | null = null;
  let intervalMs = 0;

  const seq = createSequencer({
    ctx,
    destination: out,
    emit: (patch, freq, when, holdS, vel, dest) => {
      notes.push({ patch, freq, when, holdS, vel, dest });
    },
    setTimer: (fn, ms) => {
      timer = fn;
      intervalMs = ms;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  });

  return {
    fake,
    seq,
    out,
    notes,
    fire: (): void => {
      timer?.();
    },
    get intervalMs(): number {
      return intervalMs;
    },
  };
}

/** Two tracks, so layer routing has something to route. */
function song(over?: Partial<Song>): Song {
  return {
    bpm: 120,
    ppq: PPQ,
    tracks: [
      {
        instrument: 'pulse50',
        layer: 'lead',
        steps: [
          [0, 69, 2, 1],
          [2, 71, 2, 0.8],
          [5, 72, 1, 0.6],
        ],
      },
      {
        instrument: 'triBass',
        layer: 'bass',
        steps: [
          [0, 45, 4, 1],
          [4, 43, 4, 1],
        ],
      },
    ],
    loopAtTick: 8,
    ...over,
  };
}

/** Drive the scheduler forward `seconds` of audio time, 25 ms at a time. */
function run(r: Rig, seconds: number): void {
  const stepS = SCHEDULER_INTERVAL_MS / 1000;
  for (let t = 0; t < seconds; t += stepS) {
    r.fake.advance(stepS);
    r.fire();
  }
}

describe('song format (audio §2)', () => {
  it('uses the documented ppq and derives seconds per tick from it', () => {
    expect(PPQ).toBe(4);
    // 120 BPM, 4 ticks per quarter → a 16th note is 125 ms.
    expect(secondsPerTick(120)).toBeCloseTo(0.125, 9);
    expect(secondsPerTick(60)).toBeCloseTo(0.25, 9);
    expect(secondsPerTick(240)).toBeCloseTo(0.0625, 9);
  });

  it('uses the 120 ms window and 25 ms timer audio §2 specifies', () => {
    expect(LOOKAHEAD_S).toBeCloseTo(0.12, 9);
    expect(SCHEDULER_INTERVAL_MS).toBe(25);
    expect(LAYER_RAMP_S).toBeCloseTo(0.25, 9);
  });
});

describe('lookahead scheduling', () => {
  it('schedules note-ons against the audio clock, not the timer', () => {
    const r = rig();
    r.seq.play(song());
    run(r, 1);

    const spt = secondsPerTick(120);
    const start = r.notes[0].when;
    // Every note lands on its own tick's grid position, to well inside 1 ms.
    for (const n of r.notes) {
      const k = Math.round((n.when - start) / spt);
      expect(Math.abs(n.when - (start + k * spt))).toBeLessThan(0.001);
    }
    // …and the first four are the two tick-0 notes plus tick 2 and tick 4.
    expect(r.notes.slice(0, 4).map((n) => n.freq.toFixed(2))).toEqual([
      (440).toFixed(2), // midi 69
      (110).toFixed(2), // midi 45
      (493.88).toFixed(2), // midi 71
      (98).toFixed(2), // midi 43
    ]);
  });

  it('never schedules further ahead than the lookahead window', () => {
    const r = rig();
    r.seq.play(song());
    r.fire();
    for (const n of r.notes) {
      expect(n.when).toBeLessThan(r.fake.currentTime + LOOKAHEAD_S);
    }
    // A 25 ms window over a 125 ms grid cannot have emptied the song.
    expect(r.notes.length).toBeLessThan(5);
  });

  it('holds each note for its durTicks and carries its velocity', () => {
    const r = rig();
    r.seq.play(song());
    run(r, 0.6);
    const spt = secondsPerTick(120);
    const lead = r.notes.filter((n) => n.patch === 'pulse50');
    expect(lead[0].holdS).toBeCloseTo(2 * spt, 9);
    expect(lead[0].vel).toBeCloseTo(1, 9);
    expect(lead[1].vel).toBeCloseTo(0.8, 9);
  });

  it('keeps the grid exact across a tempo change (±1 ms)', () => {
    const r = rig();
    // A note on every tick, so consecutive note-ons ARE the tick grid.
    r.seq.play({
      bpm: 120,
      ppq: PPQ,
      tracks: [
        {
          instrument: 'pulse50',
          layer: 'lead',
          steps: [0, 1, 2, 3, 4, 5, 6, 7].map((t) => [t, 60, 1, 1] as const),
        },
      ],
      loopAtTick: 8,
    });
    run(r, 0.5);

    const slow = secondsPerTick(120);
    for (let i = 1; i < r.notes.length; i++) {
      expect(r.notes[i].when - r.notes[i - 1].when).toBeCloseTo(slow, 3);
    }
    const before = r.notes.length;

    r.seq.setBpm(240);
    run(r, 0.5);

    // One boundary was already committed when the tempo moved — a tempo change
    // cannot retroactively move a note that has been handed to the audio clock
    // — so the new grid is measured from the first note after it.
    const fast = secondsPerTick(240);
    expect(r.notes.length).toBeGreaterThan(before + 1);
    for (let i = before + 1; i < r.notes.length; i++) {
      expect(r.notes[i].when - r.notes[i - 1].when).toBeCloseTo(fast, 3);
    }
    // Twice the tempo really is twice the note rate.
    expect(r.notes.length - before).toBeGreaterThan(before);
  });

  it('wraps at loopAtTick and replays the pattern', () => {
    const r = rig();
    r.seq.play(song());
    // 8 ticks × 125 ms = one second per loop; ask for three of them.
    run(r, 3.2);

    const lead = r.notes.filter((n) => n.patch === 'pulse50');
    // Three passes of a three-note lead line, in order, every time.
    expect(lead.length).toBeGreaterThanOrEqual(9);
    for (let i = 0; i + 3 <= 9; i += 3) {
      expect(lead[i].freq).toBeCloseTo(lead[0].freq, 6);
      expect(lead[i + 1].freq).toBeCloseTo(lead[1].freq, 6);
      expect(lead[i + 2].freq).toBeCloseTo(lead[2].freq, 6);
    }
    // The wrap is a time wrap too: loop 2 starts exactly one loop-length later.
    const loopS = 8 * secondsPerTick(120);
    expect(lead[3].when - lead[0].when).toBeCloseTo(loopS, 3);
  });

  it('starts the 25 ms timer on play and clears it on stop', () => {
    const r = rig();
    expect(r.seq.playing()).toBe(false);
    r.seq.play(song());
    expect(r.seq.playing()).toBe(true);
    expect(r.intervalMs).toBe(SCHEDULER_INTERVAL_MS);

    r.seq.stop();
    expect(r.seq.playing()).toBe(false);
    const emitted = r.notes.length;
    run(r, 1);
    expect(r.notes.length).toBe(emitted); // the cleared timer really is gone
  });

  it('defaults to the browser timer when none is injected', () => {
    // The production path: no `setTimer`, so the real `setInterval` is used.
    // Fake timers keep it out of real time.
    vi.useFakeTimers();
    try {
      const fake = new FakeAudioContext();
      const ctx = asAudioContext(fake);
      const notes: number[] = [];
      const seq = createSequencer({
        ctx,
        destination: ctx.createGain(),
        emit: (_patch, _freq, when) => {
          notes.push(when);
        },
      });
      seq.play(song());
      expect(notes.length).toBeGreaterThan(0);
      const before = notes.length;
      fake.advance(0.5);
      vi.advanceTimersByTime(500);
      expect(notes.length).toBeGreaterThan(before);
      seq.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('layer gains', () => {
  it('routes each track through its own layer gain into the destination', () => {
    const r = rig();
    r.seq.play(song());
    run(r, 0.3);

    const lead = r.seq.layerNode('lead');
    const bass = r.seq.layerNode('bass');
    expect(lead).not.toBeNull();
    expect(bass).not.toBeNull();
    expect(lead).not.toBe(bass);
    for (const n of r.notes) {
      expect(n.dest).toBe(n.patch === 'pulse50' ? lead : bass);
    }
    expect(fakeGain(lead as GainNode).outputs).toContain(fakeNode(r.out));
  });

  it('ramps a layer gain over 250 ms (audio §2)', () => {
    const r = rig();
    r.seq.play(song());
    r.fake.advance(0.4);

    r.seq.setLayerGain('lead', 0.25);

    const gain = fakeGain(r.seq.layerNode('lead') as GainNode).gain;
    const ramp = gain.last('linear');
    expect(ramp?.value).toBeCloseTo(0.25, 9);
    expect(ramp?.time).toBeCloseTo(0.4 + LAYER_RAMP_S, 9);
    // Ramping needs a starting point, and cancelling needs one too — otherwise
    // a second change mid-ramp jumps instead of bending.
    expect(gain.ops('cancel')).toHaveLength(1);
    expect(gain.last('set')?.time).toBeCloseTo(0.4, 9);
    expect(r.seq.layerGain('lead')).toBeCloseTo(0.25, 9);
  });

  it('creates a layer before the song does, so gains can be set up front', () => {
    const r = rig();
    r.seq.setLayerGain('danger', 0);
    expect(r.seq.layerGain('danger')).toBe(0);
    r.seq.play(song());
    run(r, 0.3);
    // The pre-created node is the one the song's notes would use.
    expect(r.seq.layerNode('danger')).not.toBeNull();
    expect(r.seq.layerGain('lead')).toBe(1); // untouched layers stay open
  });
});
