// tests/audio/synth.test.ts — the instrument patch registry of audio §3 (T5.1),
// in the Vitest **node** environment against the injected fake context.
//
// What is asserted here is the part a rendered waveform cannot pin down cheaply:
// that every §3 patch exists, that its ADSR is the one the table prints, that
// the envelope helper turns those milliseconds into the parameter events the
// Web Audio API actually needs, and that a voice builds the graph the recipe
// describes (a `triBass` really is a triangle plus a sub an octave down at
// −12 dB, and a `kick` really does sweep 150 → 48 Hz over 90 ms).
//
// Whether it SOUNDS like a kick is `scripts/capture-audio.ts`'s question.

import { describe, expect, it } from 'vitest';

import {
  PATCHES,
  PATCH_IDS,
  applyAdsr,
  createNote,
  createSynthRuntime,
  createVoiceSlot,
  dbToGain,
  midiToFreq,
  playNote,
  pulseWave,
  stopVoice,
  type PatchId,
} from '../../src/audio/synth';

import {
  FakeAudioContext,
  FakeAudioBufferSourceNode,
  FakeGainNode,
  FakeOscillatorNode,
  FakeStereoPannerNode,
  asAudioContext,
  fakeGain,
  fakeParam,
  type FakeScheduledNode,
} from './fakeContext';

/** Audio §3's table, transcribed. Every row is a deliverable. */
const AUDIO_DOC_PATCHES: readonly PatchId[] = [
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
];

function rig(): {
  fake: FakeAudioContext;
  ctx: AudioContext;
  dest: GainNode;
} {
  const fake = new FakeAudioContext();
  const ctx = asAudioContext(fake);
  return { fake, ctx, dest: ctx.createGain() };
}

/** Every oscillator created after the runtime was built. */
function oscillators(fake: FakeAudioContext): FakeOscillatorNode[] {
  return fake.created.filter(
    (n): n is FakeOscillatorNode => n instanceof FakeOscillatorNode,
  );
}

function sources(fake: FakeAudioContext): FakeAudioBufferSourceNode[] {
  return fake.created.filter(
    (n): n is FakeAudioBufferSourceNode =>
      n instanceof FakeAudioBufferSourceNode,
  );
}

describe('patch registry (audio §3)', () => {
  it('registers exactly the patches the doc names', () => {
    expect([...PATCH_IDS].sort()).toEqual([...AUDIO_DOC_PATCHES].sort());
    for (const id of AUDIO_DOC_PATCHES) {
      expect(PATCHES[id], `patch ${id}`).toBeDefined();
    }
  });

  it('maps every documented ADSR verbatim', () => {
    // "pulse50 / pulse25 / pulse12 … A5 D40 S0.7 R60"
    for (const id of ['pulse50', 'pulse25', 'pulse12'] as const) {
      expect(PATCHES[id].env).toEqual({ a: 5, d: 40, s: 0.7, r: 60 });
    }
    // "triBass … A5 D30 S0.9 R80"
    expect(PATCHES.triBass.env).toEqual({ a: 5, d: 30, s: 0.9, r: 80 });
    // "kick … A0 D90"
    expect(PATCHES.kick.env.a).toBe(0);
    expect(PATCHES.kick.env.d).toBe(90);
    expect(PATCHES.kick.env.s).toBe(0);
    // "snare … 200 Hz sine body 60 ms"
    expect(PATCHES.snare.env.d).toBe(60);
    // "hat … D30 (closed) / D120 (open)"
    expect(PATCHES.hat.env.d).toBe(30);
    expect(PATCHES.hat.openDecayMs).toBe(120);
    // "pad … A400 D200 S0.6 R600"
    expect(PATCHES.pad.env).toEqual({ a: 400, d: 200, s: 0.6, r: 600 });
  });

  it('maps the documented duty cycles, filters and modulation indices', () => {
    expect(PATCHES.pulse50.duty).toBe(0.5);
    expect(PATCHES.pulse25.duty).toBe(0.25);
    expect(PATCHES.pulse12.duty).toBe(0.125);
    // "triBass: triangle osc + subSine one octave down at −12 dB"
    expect(PATCHES.triBass.subDb).toBe(-12);
    // "kick: sine pitch-swept 150→48 Hz over 90 ms"
    expect(PATCHES.kick.sweepFromHz).toBe(150);
    expect(PATCHES.kick.sweepToHz).toBe(48);
    expect(PATCHES.kick.sweepMs).toBe(90);
    // "snare: white noise bandpass 1.8 kHz + 200 Hz sine body"
    expect(PATCHES.snare.filterHz).toBe(1800);
    expect(PATCHES.snare.filterType).toBe('bandpass');
    expect(PATCHES.snare.bodyHz).toBe(200);
    // "hat: white noise highpass 6 kHz"
    expect(PATCHES.hat.filterHz).toBe(6000);
    expect(PATCHES.hat.filterType).toBe('highpass');
    // "pad: 2 detuned saws (±8 cents) → lowpass 1.2 kHz … haas 12 ms"
    expect(PATCHES.pad.spreadCents).toBe(8);
    expect(PATCHES.pad.filterHz).toBe(1200);
    expect(PATCHES.pad.haasMs).toBe(12);
    // "bell: 2-op FM, ratio 3.01, index decay 300 ms"
    expect(PATCHES.bell.fmRatio).toBe(3.01);
    expect(PATCHES.bell.fmDecayMs).toBe(300);
    // "pulse … vibrato 6 Hz ±10 cents optional" — off by default, so a plain
    // pulse blip costs two nodes rather than four.
    expect(PATCHES.pulse50.vibratoHz).toBe(6);
    expect(PATCHES.pulse50.vibratoCents).toBe(0);
  });
});

describe('units', () => {
  it('converts MIDI to frequency at A440', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToFreq(57)).toBeCloseTo(220, 6);
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
  });

  it('converts decibels to a linear gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 5);
    expect(dbToGain(-12)).toBeCloseTo(0.251189, 5);
  });
});

describe('pulse waves', () => {
  it('band-limits a 50% pulse to the odd harmonics of a square', () => {
    const fake = new FakeAudioContext();
    pulseWave(asAudioContext(fake), 0.5);
    const wave = fake.periodicWaves[0];
    // A 50% duty pulse is a square: every even harmonic vanishes, and the odd
    // ones fall as 1/n. This is the check that the coefficients are a pulse and
    // not, say, a saw with a duty knob that does nothing.
    expect(wave.real[2]).toBeCloseTo(0, 6);
    expect(wave.real[4]).toBeCloseTo(0, 6);
    expect(Math.abs(wave.real[3] / wave.real[1])).toBeCloseTo(1 / 3, 5);
    expect(Math.abs(wave.real[5] / wave.real[1])).toBeCloseTo(1 / 5, 5);
  });

  it('keeps the even harmonics of a 12.5% pulse — the NES buzz', () => {
    const fake = new FakeAudioContext();
    pulseWave(asAudioContext(fake), 0.125);
    const wave = fake.periodicWaves[0];
    // The narrow duty is *why* the engine hum is nasal: unlike the square, its
    // even harmonics are present and strong.
    expect(Math.abs(wave.real[2])).toBeGreaterThan(0.1);
    expect(wave.real[8]).toBeCloseTo(0, 6); // …and only n·8 vanishes at 1/8 duty
  });

  it('builds all three duties once, at runtime construction', () => {
    const fake = new FakeAudioContext();
    createSynthRuntime(asAudioContext(fake));
    expect(fake.periodicWaves).toHaveLength(3);
  });
});

describe('applyAdsr', () => {
  it('turns audio §3 milliseconds into parameter events', () => {
    const fake = new FakeAudioContext();
    const param = asAudioContext(fake).createGain().gain;
    const end = applyAdsr(param, 1, 0.5, PATCHES.pulse50.env, 0.2, 0);
    const events = fakeParam(param).events;

    expect(events[0]).toMatchObject({ op: 'set', value: 0, time: 1 });
    // A5: attack peak 5 ms in.
    expect(events[1].op).toBe('linear');
    expect(events[1].value).toBeCloseTo(0.5, 6);
    expect(events[1].time).toBeCloseTo(1.005, 6);
    // D40 to S0.7: 0.35 at 45 ms.
    expect(events[2].op).toBe('linear');
    expect(events[2].value).toBeCloseTo(0.35, 6);
    expect(events[2].time).toBeCloseTo(1.045, 6);
    // Held to the end of the note, then R60 down to silence.
    expect(events[3]).toMatchObject({ op: 'set', time: 1.2 });
    expect(events[3].value).toBeCloseTo(0.35, 6);
    expect(events[4].op).toBe('linear');
    expect(events[4].value).toBe(0);
    expect(events[4].time).toBeCloseTo(1.26, 6);
    expect(end).toBeCloseTo(1.26, 6);
  });

  it('releases straight out of the decay when the hold is shorter', () => {
    const fake = new FakeAudioContext();
    const param = asAudioContext(fake).createGain().gain;
    // A percussive patch: the hold is zero, so there is no sustain segment to
    // schedule and the tail starts the moment the decay lands.
    const end = applyAdsr(param, 0, 1, PATCHES.kick.env, 0, 0);
    const events = fakeParam(param).events;
    expect(events.some((e) => e.op === 'set' && e.time > 0)).toBe(false);
    expect(end).toBeCloseTo(0.09 + PATCHES.kick.env.r / 1000, 6);
  });

  it('takes a release override, so one patch can serve two lengths', () => {
    const fake = new FakeAudioContext();
    const param = asAudioContext(fake).createGain().gain;
    const end = applyAdsr(param, 0, 1, PATCHES.pulse50.env, 0, 200);
    expect(end).toBeCloseTo(0.005 + 0.04 + 0.2, 6);
  });
});

describe('playNote', () => {
  it('plays a pulse through one oscillator carrying the duty wave', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const note = createNote();
    note.freq = 440;
    note.holdMs = 40;
    const end = playNote(rt, 'pulse50', note, 2, dest, null);

    const oscs = oscillators(fake);
    expect(oscs).toHaveLength(1);
    expect(oscs[0].wave).toBe(fake.periodicWaves[0]);
    expect(oscs[0].frequency.last('set')?.value).toBeCloseTo(440, 6);
    expect(oscs[0].startedAt).toBeCloseTo(2, 6);
    // Stopped after the envelope has finished, never before.
    expect(oscs[0].stoppedAt ?? 0).toBeGreaterThanOrEqual(end);
    expect(fake.reaches(oscs[0], fakeGain(dest))).toBe(true);
  });

  it('stacks a sub an octave below the triangle at −12 dB (triBass)', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const note = createNote();
    note.freq = 110;
    playNote(rt, 'triBass', note, 0, dest, null);

    const oscs = oscillators(fake);
    expect(oscs).toHaveLength(2);
    const tri = oscs.find((o) => o.type === 'triangle');
    const sub = oscs.find((o) => o.type === 'sine');
    expect(tri?.frequency.last('set')?.value).toBeCloseTo(110, 6);
    expect(sub?.frequency.last('set')?.value).toBeCloseTo(55, 6);
    // The sub goes through its own trim, and the trim is −12 dB.
    const trim = sub?.outputs[0];
    expect(trim).toBeInstanceOf(FakeGainNode);
    expect((trim as FakeGainNode).gain.value).toBeCloseTo(dbToGain(-12), 5);
  });

  it('sweeps the kick 150 → 48 Hz over 90 ms', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    playNote(rt, 'kick', createNote(), 5, dest, null);

    const body = oscillators(fake).find((o) => o.type === 'sine');
    expect(body?.frequency.last('set')?.value).toBeCloseTo(150, 6);
    const ramp = body?.frequency.last('exp');
    expect(ramp?.value).toBeCloseTo(48, 6);
    expect(ramp?.time).toBeCloseTo(5.09, 6);
  });

  it('reuses one shared noise buffer for every noise voice', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const buffersAfterInit = fake.buffers.length;
    playNote(rt, 'noiseFx', createNote(), 0, dest, null);
    playNote(rt, 'hat', createNote(), 0.1, dest, null);
    playNote(rt, 'snare', createNote(), 0.2, dest, null);

    // Three noise voices, zero new buffers: the pool is the runtime's.
    expect(fake.buffers.length).toBe(buffersAfterInit);
    const srcs = sources(fake);
    expect(srcs.length).toBeGreaterThanOrEqual(3);
    for (const s of srcs) {
      expect(s.buffer).toBe(rt.noise);
    }
  });

  it('gives the bell a modulator at ratio 3.01 whose index decays 300 ms', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const note = createNote();
    note.freq = 880;
    playNote(rt, 'bell', note, 0, dest, null);

    const oscs = oscillators(fake);
    expect(oscs).toHaveLength(2);
    const mod = oscs.find(
      (o) => (o.frequency.last('set')?.value ?? 0) > 880 + 1,
    );
    expect(mod?.frequency.last('set')?.value).toBeCloseTo(880 * 3.01, 4);
    // The modulator feeds an index gain, and that gain lands on the carrier's
    // frequency param — that, and not a filter, is what makes it FM.
    const index = mod?.outputs[0] as FakeGainNode | undefined;
    expect(index).toBeInstanceOf(FakeGainNode);
    expect(index?.gain.last('exp')?.time).toBeCloseTo(0.3, 6);
    const carrier = oscs.find((o) => o !== mod);
    expect(index?.outputs).toContain(carrier?.frequency);
  });

  it('pans by inserting one panner, and only when the note is off centre', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const centre = createNote();
    playNote(rt, 'pulse25', centre, 0, dest, null);
    expect(fake.created.some((n) => n instanceof FakeStereoPannerNode)).toBe(
      false,
    );

    const off = createNote();
    off.pan = -0.35;
    playNote(rt, 'pulse25', off, 0, dest, null);
    const panners = fake.created.filter(
      (n): n is FakeStereoPannerNode => n instanceof FakeStereoPannerNode,
    );
    expect(panners).toHaveLength(1);
    expect(panners[0].pan.value).toBeCloseTo(-0.35, 6);
    expect(panners[0].outputs).toContain(fakeGain(dest));
  });

  it('scales the envelope peak by velocity', () => {
    const { fake, ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const note = createNote();
    note.vel = 0.5;
    playNote(rt, 'pulse50', note, 0, dest, null);
    const envelope = fake.created.find(
      (n): n is FakeGainNode =>
        n instanceof FakeGainNode &&
        n.gain.events.some((e) => e.op === 'set' && e.value === 0),
    );
    const peak = envelope?.gain.ops('linear')[0];
    expect(peak?.value).toBeCloseTo(PATCHES.pulse50.gain * 0.5, 6);
  });
});

describe('voice slots', () => {
  it('fills a preallocated slot rather than allocating a record per note', () => {
    const { ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const slot = createVoiceSlot();
    const sourcesArray = slot.sources;

    playNote(rt, 'pulse50', createNote(), 1, dest, slot);
    expect(slot.active).toBe(true);
    expect(slot.patch).toBe('pulse50');
    expect(slot.startTime).toBeCloseTo(1, 6);
    expect(slot.endTime).toBeGreaterThan(1);
    expect(slot.count).toBe(1);

    playNote(rt, 'triBass', createNote(), 2, dest, slot);
    expect(slot.patch).toBe('triBass');
    expect(slot.count).toBe(2);
    // Same array object both times: the slot is reused, never rebuilt.
    expect(slot.sources).toBe(sourcesArray);
  });

  it('steals a voice by ramping its envelope out and stopping its sources', () => {
    const { ctx, dest } = rig();
    const rt = createSynthRuntime(ctx);
    const slot = createVoiceSlot();
    playNote(rt, 'pad', createNote(), 0, dest, slot);
    const env = slot.env as unknown as FakeGainNode | null;
    const before = env?.gain.events.length ?? 0;

    stopVoice(slot, 3, 10);

    expect(slot.active).toBe(false);
    expect(slot.endTime).toBeCloseTo(3.01, 6);
    expect(env?.gain.events.length ?? 0).toBeGreaterThan(before);
    expect(env?.gain.last('linear')?.value).toBe(0);
    expect(env?.gain.last('linear')?.time).toBeCloseTo(3.01, 6);
    expect(slot.count).toBeGreaterThan(0);
    for (let i = 0; i < slot.count; i++) {
      const src = slot.sources[i] as unknown as FakeScheduledNode | null;
      expect(src?.stoppedAt).toBeCloseTo(3.01, 6);
    }
  });

  it('is a no-op on a slot that was never played', () => {
    const slot = createVoiceSlot();
    expect(() => {
      stopVoice(slot, 1, 10);
    }).not.toThrow();
    expect(slot.active).toBe(false);
  });
});
