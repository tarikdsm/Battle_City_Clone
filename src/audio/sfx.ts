// src/audio/sfx.ts — audio §5's SFX table, every row of it, as parametric
// patches over the `synth.ts` registry.
//
// **No samples.** A "noise boom" here is a looping white-noise buffer through a
// swept lowpass; a "bell arp" is four FM voices 45 ms apart; the engine hum is
// one 12.5% pulse whose detune is modulated by an 8 Hz square. Nothing is
// loaded, because there is nothing to load.
//
// ## Three kinds of sound live in this file
//
// **One-shots** take a pool slot, obey their §5 polyphony cap and the 30 ms
// retrigger guard, and are then forgotten — the Web Audio nodes free
// themselves once they have stopped and nothing references them.
//
// **Sustained voices** (the engine hums, the shield hum, the ice whoosh) are
// built **once** and then only ever have their gain and detune re-targeted from
// `update`. They never touch the one-shot budget, and they are what makes a
// board sound alive rather than like a series of events.
//
// **Timed loops** (the power-up sparkle, the clock's tick-tock) are one-shots
// fired from an accumulator in `update`, so their rate is frame-rate
// independent and they cost nothing while their condition is false.
//
// ## The engine hum is the soundtrack
//
// Audio §1 and §5 both say so, and it is the sound a Battle City player will
// recognise before any other. It is built from three decisions:
//
//  - **A 12.5% pulse**, not a square. The narrow duty keeps the even harmonics,
//    which is the difference between the NES's nasal buzz and a hollow drone.
//  - **The alternation is an LFO, not a scheduler.** A square oscillator at
//    8 Hz into a ±50-cent gain, summed onto `detune`, gives the exact two-note
//    buzz with zero JS running per frame and zero drift.
//  - **The pitch follows measured displacement, not `moving`.** A tank pushed
//    into a wall has `moving === true` and is not moving; keying the rev on the
//    intent would make the hum lie about what is happening on screen.

import { FIELD_U, PLAYER_SPEED, TICK_S } from '../core/constants';
import type { GameEvent } from '../core/events';
import type { GameState, Tank } from '../core/types';
import type { AudioGraph, VoicePool } from './audio';
import {
  createNote,
  dbToGain,
  midiToFreq,
  playNote,
  resetNote,
  type Note,
  type PatchId,
  type VoiceSlot,
} from './synth';

// ---------------------------------------------------------------------------
// The table (audio §5)
// ---------------------------------------------------------------------------

export type SfxId =
  | 'playerShot'
  | 'enemyShot'
  | 'bulletsCancel'
  | 'brickHit'
  | 'steelClink'
  | 'steelBreak'
  | 'tankExplode'
  | 'playerExplode'
  | 'baseExplode'
  | 'enemySpawn'
  | 'powerupSpawn'
  | 'powerupPickup'
  | 'starTierUp'
  | 'helmetLoop'
  | 'clockFreeze'
  | 'shovelClank'
  | 'extraLife'
  | 'stunBuzz'
  | 'engineIdle'
  | 'engineMove'
  | 'iceSlide'
  | 'treeRustle'
  | 'uiMove'
  | 'uiSelect'
  | 'uiBack'
  | 'tallyTick';

export type SfxPriority = 'low' | 'med' | 'high' | 'top';

export const PRIORITY_RANK: Readonly<Record<SfxPriority, number>> =
  Object.freeze({ low: 0, med: 1, high: 2, top: 3 });

export interface SfxDef {
  readonly priority: SfxPriority;
  readonly poly: number;
  /**
   * `sting` is the path past the SFX duck, for the two sounds whose whole job
   * is to duck everything else (audio §6). See `audio.ts`'s header.
   */
  readonly bus: 'sfx' | 'sting';
  /** Driven by `update` as a continuous voice rather than fired as a one-shot. */
  readonly sustained: boolean;
}

function sfx(
  priority: SfxPriority,
  poly: number,
  bus: 'sfx' | 'sting' = 'sfx',
  sustained = false,
): SfxDef {
  return Object.freeze({ priority, poly, bus, sustained });
}

/** Audio §5's table, transcribed. Priority and poly cap are the doc's own. */
export const SFX: Readonly<Record<SfxId, SfxDef>> = Object.freeze({
  playerShot: sfx('high', 2),
  enemyShot: sfx('med', 3),
  bulletsCancel: sfx('med', 2),
  brickHit: sfx('high', 3),
  steelClink: sfx('high', 2),
  steelBreak: sfx('high', 2),
  tankExplode: sfx('high', 3),
  playerExplode: sfx('top', 1, 'sting'),
  baseExplode: sfx('top', 1, 'sting'),
  enemySpawn: sfx('med', 2),
  powerupSpawn: sfx('med', 1),
  powerupPickup: sfx('high', 1),
  starTierUp: sfx('high', 1),
  helmetLoop: sfx('low', 2, 'sfx', true),
  clockFreeze: sfx('high', 1),
  shovelClank: sfx('high', 1),
  extraLife: sfx('top', 1),
  stunBuzz: sfx('med', 1),
  engineIdle: sfx('low', 2, 'sfx', true),
  engineMove: sfx('low', 2, 'sfx', true),
  iceSlide: sfx('low', 2, 'sfx', true),
  treeRustle: sfx('low', 2),
  uiMove: sfx('med', 2),
  uiSelect: sfx('med', 2),
  uiBack: sfx('med', 2),
  tallyTick: sfx('med', 1),
});

/** Declaration order is the pool's tag order; do not reorder casually. */
export const SFX_IDS: readonly SfxId[] = Object.freeze(
  Object.keys(SFX) as SfxId[],
);

const SFX_INDEX: Readonly<Record<SfxId, number>> = Object.freeze(
  Object.fromEntries(SFX_IDS.map((id, i) => [id, i])) as Record<SfxId, number>,
);

/** Audio §5: "identical SFX ≥ 30 ms apart". */
export const RETRIGGER_GUARD_MS = 30;
/** Audio §6: "subtle SFX pan by world x (±0.35 max)". */
export const MAX_PAN = 0.35;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** World x (0..`FIELD_U`) → a stereo position inside audio §6's ±0.35. */
export function panForX(x: number): number {
  return clamp((x / FIELD_U) * 2 - 1, -1, 1) * MAX_PAN;
}

// ---------------------------------------------------------------------------
// Events → sounds
// ---------------------------------------------------------------------------

/**
 * Which §5 row an event plays, or `null` for the events that are not sounds.
 *
 * Kept pure and exported so the mapping is testable on its own: every row of
 * this switch is a claim about the game, and "the star fanfare fires when the
 * player dies" is the kind of claim only a table like this makes checkable.
 */
export function sfxForEvent(e: GameEvent): SfxId | null {
  switch (e.t) {
    case 'shotFired':
      return e.byPlayer ? 'playerShot' : 'enemyShot';
    case 'bulletsCanceled':
      return 'bulletsCancel';
    case 'brickHit':
      return 'brickHit';
    case 'steelHit':
      return e.destroyed ? 'steelBreak' : 'steelClink';
    case 'tankDestroyed':
      return e.kind === 'player' ? 'playerExplode' : 'tankExplode';
    case 'baseDestroyed':
      return 'baseExplode';
    case 'enemySpawnStarted':
      return 'enemySpawn';
    case 'powerupSpawned':
      return 'powerupSpawn';
    case 'powerupCollected':
      return 'powerupPickup';
    case 'tierChanged':
      // A tier RESET is the respawn tidying up, not a star: it fires on every
      // death, and the fanfare there would be a bug you hear once a life.
      return e.tier > 0 ? 'starTierUp' : null;
    case 'clockStarted':
      return 'clockFreeze';
    case 'shovelPhase':
      return 'shovelClank';
    case 'extraLife':
      return 'extraLife';
    case 'playerStunned':
      return 'stunBuzz';
    case 'iceSkidStarted':
      return 'iceSlide';
    case 'treeEntered':
      return 'treeRustle';
    default:
      // `clockEnded`, `tankHit`, `enemySpawned`, `bulletDespawned`,
      // `scoreAwarded`, `grenadeUsed`, `stageCleared`, `gameOver`,
      // `pauseToggled`, `playerSpawned`: either silent by design or owned by
      // the music layer (T5.3).
      return null;
  }
}

/** The pan an event implies. Events without a position play centre. */
function panOfEvent(e: GameEvent): number {
  return 'x' in e ? panForX(e.x) : 0;
}

function popcount4(mask: number): number {
  let n = 0;
  for (let bit = 0; bit < 4; bit++) {
    if ((mask & (1 << bit)) !== 0) {
      n++;
    }
  }
  return n;
}

/**
 * The event's one free parameter, 0..1. What it *means* is per-sound and
 * documented at each `render` case — a bigger crunch for a brick that lost
 * more of itself, a heavier boom for an armour tank, the shovel's phase, the
 * tally's pitch.
 */
function intensityOfEvent(e: GameEvent): number {
  switch (e.t) {
    case 'brickHit':
      return 0.4 + 0.6 * (popcount4(e.removedMask) / 4);
    case 'tankDestroyed':
      return clamp(e.points / 400, 0.25, 1);
    case 'shovelPhase':
      return e.phase === 'steel' ? 1 : e.phase === 'blink' ? 0.5 : 0;
    case 'playerStunned':
      return clamp(e.durS / 3, 0.3, 1);
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// The engine hum (audio §5's most important row)
// ---------------------------------------------------------------------------

export const ENGINE = Object.freeze({
  patch: 'pulse12' as PatchId,
  /**
   * A2, 110 Hz. The doc does not fix a register, and this one is a measurement
   * rather than a taste: the first cut sat at F2 (87 Hz), and
   * `docs/calibration/audio.json`'s spectrum showed the fundamental 15 dB under
   * the harmonics — a laptop speaker, which rolls off hard below ~150 Hz, would
   * have delivered a thin buzz with no engine in it. A2 idle rising to C3 at
   * full speed puts the fundamental where a small speaker can reproduce it and
   * still reads as an engine rather than a note.
   */
  rootMidi: 45,
  /**
   * Audio §5: "alternating semitone at 8 Hz".
   *
   * Implemented verbatim, and worth knowing what it is: at engine pitch a
   * semitone is a few Hz of deviation, so an 8 Hz alternation has a modulation
   * index well under 1 and the ear hears **roughness**, not two notes. That is
   * the right sound — the NES engine is a rough warble, not a melody — but
   * §5's phrase "two-note buzz" describes the mechanism rather than the
   * percept. See the T5.1 report; widening the interval to 3–4 semitones is
   * what would actually produce two audible notes, and would sound like a
   * siren rather than a tank.
   */
  alternateHz: 8,
  alternateCents: 100,
  /** Audio §5: "pitch +0…+3 st with speed". */
  moveSemitones: 3,
  /**
   * Audio §5 calls the hum "quiet" and it plays for the whole stage — but it
   * is also the game's bed, so "quiet" is a floor as well as a ceiling. These
   * put it at roughly −22 dBFS peak in `docs/calibration/audio.json`, i.e.
   * about 7 dB under a player shot and 16 dB under a tank explosion: always
   * there, never in the way.
   */
  idleGain: 0.08,
  moveGain: 0.15,
  lowpassHz: 2600,
  /** Gain/pitch smoothing time constant, so a stop-start is not a step. */
  smoothingS: 0.05,
});

/**
 * How fast this tank is *actually* going, 0..1 of a player's full speed —
 * measured from the tick's own displacement rather than read off `moving`.
 */
export function engineSpeed01(tank: Tank): number {
  const dx = tank.x - tank.prevX;
  const dy = tank.y - tank.prevY;
  const perTick = PLAYER_SPEED * TICK_S;
  return clamp(Math.sqrt(dx * dx + dy * dy) / perTick, 0, 1);
}

/** The detune, in cents, the hum sits at for a given speed. */
export function engineCents(speed01: number): number {
  return clamp(speed01, 0, 1) * ENGINE.moveSemitones * 100;
}

/** The level the hum sits at for a given speed. */
export function engineGain(speed01: number): number {
  return (
    ENGINE.idleGain + (ENGINE.moveGain - ENGINE.idleGain) * clamp(speed01, 0, 1)
  );
}

// ---------------------------------------------------------------------------
// Sustained voices
// ---------------------------------------------------------------------------

/** Nothing can be this many cents or this loud, so the first update always writes. */
const NEVER = -1e9;

/**
 * Audio §5's "soft shield hum", and it has to stay **under** the engine hum
 * that is always playing beneath it.
 *
 * Measured, not guessed: at the first cut's 0.06 the shield's fundamental came
 * out 15 dB **louder** than the engine's in the rendered spectrum — a pulse50
 * through a 900 Hz lowpass puts nearly all of its energy in one partial, while
 * a pulse12 spreads it over a dozen. Every spawn shield was drowning the sound
 * it was supposed to sit on top of.
 */
const SHIELD_GAIN = 0.018;

interface HumVoice {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  gain: GainNode;
  panner: StereoPannerNode;
  cents: number;
  level: number;
  pan: number;
}

interface LoopVoice {
  gain: GainNode;
  level: number;
  /**
   * The sources to stop on teardown. In the game the context is closed a line
   * later and this is redundant; a `SfxPlayer` disposed on its own — a settings
   * preview, a future screen — would otherwise leave a silent oscillator
   * running for the life of the page.
   */
  sources: AudioScheduledSourceNode[];
}

/** Seconds between power-up sparkles while one is on the field. */
const SPARKLE_PERIOD_S = 0.9;
/** Seconds between the clock freeze's tick and its tock. */
const CLOCK_TICK_PERIOD_S = 0.5;
/** Tiles beyond which the power-up sparkle has faded out (§5: "range-limited"). */
const SPARKLE_RANGE_U = 96;

// ---------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------

export interface SfxStats {
  /** One-shots fired since construction — the tests' window on the loops. */
  oneShots: number;
  voices: number;
  sustained: number;
}

export interface SfxPlayer {
  /**
   * Fires one §5 row. Returns `false` when the retrigger guard or the voice
   * budget refused it.
   *
   * @param pan       −1..1, normally from {@link panForX}
   * @param intensity 0..1; per-sound meaning, documented at each case
   * @param when      context time to fire at. Defaults to now, which is what
   *                  the game always wants; `scripts/capture-audio.ts` passes
   *                  future times because an `OfflineAudioContext` renders a
   *                  whole clip from a `currentTime` that never advances.
   */
  trigger(id: SfxId, pan: number, intensity: number, when?: number): boolean;
  onEvent(e: GameEvent): void;
  update(state: GameState, dtMs: number): void;
  /** Current level of a player's engine hum. 0 = silent. */
  engineLevel(playerIndex: 0 | 1): number;
  shieldLevel(playerIndex: 0 | 1): number;
  slideLevel(): number;
  stats(): SfxStats;
  dispose(): void;
}

export function createSfxPlayer(graph: AudioGraph, pool: VoicePool): SfxPlayer {
  const ctx = graph.ctx;
  const rt = graph.synth;
  /** One note record for the whole player. Re-filled, never re-allocated. */
  const note: Note = createNote();
  /** Last start time per sound, for the 30 ms guard. */
  const lastAt = new Float64Array(SFX_IDS.length).fill(-1);

  const hums: (HumVoice | null)[] = [null, null];
  const shields: (LoopVoice | null)[] = [null, null];
  let ice: LoopVoice | null = null;
  let sparkleT = 0;
  let clockT = 0;
  let clockToggle = false;
  let oneShots = 0;
  let variation = 0x12345678;

  /** Deterministic −1..1, so the offline render is reproducible. */
  function nextVariation(): number {
    variation = (variation + 0x6d2b79f5) | 0;
    let t = Math.imul(variation ^ (variation >>> 15), 1 | variation);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  }

  function layer(
    patch: PatchId,
    when: number,
    dest: AudioNode,
    slot: VoiceSlot | null,
  ): void {
    playNote(rt, patch, note, when, dest, slot);
  }

  // -------------------------------------------------------------------------
  // The 26 rows
  // -------------------------------------------------------------------------

  function render(
    id: SfxId,
    when: number,
    pan: number,
    intensity: number,
    dest: AudioNode,
    slot: VoiceSlot | null,
  ): void {
    oneShots++;
    switch (id) {
      // "pulse blip 880→440 Hz 40 ms + noise tick"
      case 'playerShot':
      case 'enemyShot': {
        const player = id === 'playerShot';
        resetNote(note);
        note.pan = pan;
        note.freq = player ? 880 : 660;
        note.sweepToHz = player ? 440 : 330;
        note.sweepMs = 40;
        note.holdMs = 8;
        note.releaseMs = 40;
        // "same, −6 dB" for the enemy — the board is full of them.
        note.gain = player ? 1 : dbToGain(-6);
        layer('pulse25', when, dest, slot);
        resetNote(note);
        note.pan = pan;
        note.filterType = 'highpass';
        note.filterHz = player ? 3200 : 2600;
        note.decayMs = 14;
        note.releaseMs = 10;
        note.gain = player ? 0.35 : 0.2;
        layer('noiseFx', when, dest, null);
        break;
      }

      // "short dual pop"
      case 'bulletsCancel': {
        for (let i = 0; i < 2; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = i === 0 ? 520 : 392;
          note.holdMs = 6;
          note.releaseMs = 30;
          note.gain = 0.7;
          layer('pulse50', when + i * 0.02, dest, i === 0 ? slot : null);
        }
        break;
      }

      // "noise burst bandpass 800 Hz 90 ms + low crunch"
      case 'brickHit': {
        resetNote(note);
        note.pan = pan;
        note.filterType = 'bandpass';
        note.filterHz = 800 * (1 + 0.12 * nextVariation());
        note.filterQ = 1.1;
        note.decayMs = 90;
        note.releaseMs = 40;
        note.gain = 0.55 + 0.45 * intensity;
        layer('noiseFx', when, dest, slot);
        // The crunch: a short low body under the burst, which is what makes it
        // a brick coming apart rather than a hiss.
        resetNote(note);
        note.pan = pan;
        note.freq = 150;
        note.sweepToHz = 70;
        note.sweepMs = 70;
        note.holdMs = 10;
        note.releaseMs = 60;
        note.gain = 0.4 * intensity;
        layer('triBass', when, dest, null);
        break;
      }

      // "FM ping 2.4 kHz, fast decay + ricochet whistle (rand pitch ±3 st)"
      case 'steelClink': {
        resetNote(note);
        note.pan = pan;
        note.freq = 2400;
        note.decayMs = 70;
        note.releaseMs = 60;
        note.gain = 0.55;
        layer('bell', when, dest, slot);
        resetNote(note);
        note.pan = pan;
        note.freq = 1800;
        note.detuneCents = nextVariation() * 300;
        note.sweepToHz = 3200;
        note.sweepMs = 90;
        note.holdMs = 20;
        note.releaseMs = 90;
        note.gain = 0.16;
        layer('pulse12', when + 0.01, dest, null);
        break;
      }

      // "clink + metal shard shimmer"
      case 'steelBreak': {
        resetNote(note);
        note.pan = pan;
        note.freq = 2200;
        note.decayMs = 90;
        note.releaseMs = 120;
        note.gain = 0.7;
        layer('bell', when, dest, slot);
        for (let i = 0; i < 3; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = 3000 + i * 900 + nextVariation() * 200;
          note.decayMs = 60 + i * 30;
          note.releaseMs = 90;
          note.gain = 0.22;
          layer('bell', when + 0.03 + i * 0.035, dest, null);
        }
        resetNote(note);
        note.pan = pan;
        note.filterType = 'highpass';
        note.filterHz = 4000;
        note.decayMs = 180;
        note.releaseMs = 120;
        note.gain = 0.25;
        layer('noiseFx', when, dest, null);
        break;
      }

      // "noise boom 250 ms + sub drop 90→40 Hz + debris crackle"
      case 'tankExplode':
      case 'playerExplode': {
        const big = id === 'playerExplode';
        resetNote(note);
        note.pan = pan;
        note.filterType = 'lowpass';
        note.filterHz = big ? 900 : 1200;
        note.filterQ = 0.8;
        note.decayMs = big ? 380 : 250;
        note.releaseMs = big ? 260 : 180;
        note.gain = (big ? 1.15 : 0.85) * (0.6 + 0.4 * intensity);
        layer('noiseFx', when, dest, slot);
        resetNote(note);
        note.pan = pan;
        note.freq = big ? 110 : 90;
        note.sweepToHz = 40;
        note.sweepMs = big ? 260 : 190;
        note.holdMs = big ? 200 : 140;
        note.releaseMs = 220;
        note.gain = big ? 1 : 0.8;
        layer('triBass', when, dest, null);
        // Debris: three shrinking crackles, so the tail is wreckage landing
        // rather than a noise gate closing.
        for (let i = 0; i < 3; i++) {
          resetNote(note);
          note.pan = pan + nextVariation() * 0.1;
          note.filterType = 'bandpass';
          note.filterHz = 1600 + i * 700;
          note.filterQ = 2;
          note.decayMs = 40;
          note.releaseMs = 30;
          note.gain = 0.3 - i * 0.07;
          layer('noiseFx', when + 0.09 + i * 0.06, dest, null);
        }
        if (big) {
          // The player's death gets a falling cry over the boom — it has to be
          // distinguishable from an enemy's across a busy board.
          resetNote(note);
          note.pan = pan;
          note.freq = 520;
          note.sweepToHz = 90;
          note.sweepMs = 420;
          note.holdMs = 300;
          note.releaseMs = 200;
          note.gain = 0.5;
          layer('pulse25', when, dest, null);
        }
        break;
      }

      // "long layered boom 1.2 s + alarm sting"
      case 'baseExplode': {
        resetNote(note);
        note.pan = 0;
        note.filterType = 'lowpass';
        note.filterHz = 700;
        note.filterQ = 0.9;
        note.decayMs = 700;
        note.holdMs = 500;
        note.releaseMs = 500;
        note.gain = 1.3;
        layer('noiseFx', when, dest, slot);
        resetNote(note);
        note.freq = 130;
        note.sweepToHz = 32;
        note.sweepMs = 900;
        note.holdMs = 700;
        note.releaseMs = 400;
        note.gain = 1.2;
        layer('triBass', when, dest, null);
        // The alarm: four two-note klaxon swells over the tail. This is the
        // sound that says the run is over, so it is deliberately musical and
        // deliberately unpleasant — a minor second, high in the pulse register.
        for (let i = 0; i < 4; i++) {
          resetNote(note);
          note.pan = i % 2 === 0 ? -0.2 : 0.2;
          note.freq = midiToFreq(i % 2 === 0 ? 79 : 78);
          note.holdMs = 130;
          note.releaseMs = 120;
          note.gain = 0.34;
          layer('pulse50', when + 0.2 + i * 0.22, dest, null);
        }
        break;
      }

      // "shimmer arp up (bell), 300 ms"
      case 'enemySpawn': {
        for (let i = 0; i < 3; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = midiToFreq(72 + i * 5);
          note.decayMs = 160;
          note.releaseMs = 120;
          note.gain = 0.3;
          layer('bell', when + i * 0.075, dest, i === 0 ? slot : null);
        }
        break;
      }

      // "bell arp + sparkle loop while on field"
      case 'powerupSpawn': {
        for (let i = 0; i < 2; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = midiToFreq(76 + i * 7);
          note.decayMs = 200;
          note.releaseMs = 160;
          note.gain = 0.35;
          layer('bell', when + i * 0.09, dest, i === 0 ? slot : null);
        }
        break;
      }

      // "major-triad bell arp + shimmer tail (the classic 'chirilip' feel)"
      case 'powerupPickup': {
        const triad = [0, 4, 7, 12];
        for (let i = 0; i < triad.length; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = midiToFreq(72 + triad[i]);
          note.decayMs = 190;
          note.releaseMs = 200;
          note.gain = 0.5;
          layer('bell', when + i * 0.045, dest, i === 0 ? slot : null);
        }
        resetNote(note);
        note.pan = pan;
        note.filterType = 'highpass';
        note.filterHz = 5000;
        note.decayMs = 260;
        note.releaseMs = 200;
        note.gain = 0.16;
        layer('noiseFx', when + 0.12, dest, null);
        break;
      }

      // "400 ms mini-fanfare on top of pickup"
      case 'starTierUp': {
        const run = [72, 76, 79, 84, 88];
        for (let i = 0; i < run.length; i++) {
          resetNote(note);
          note.pan = pan;
          note.freq = midiToFreq(run[i]);
          note.holdMs = 60;
          note.releaseMs = 90;
          note.gain = 0.6;
          layer('pulse50', when + i * 0.08, dest, i === 0 ? slot : null);
        }
        break;
      }

      // "rising jingle (faithful spirit)"
      case 'extraLife': {
        const jingle = [67, 72, 76, 79, 84];
        for (let i = 0; i < jingle.length; i++) {
          resetNote(note);
          note.pan = 0;
          note.freq = midiToFreq(jingle[i]);
          note.holdMs = i === jingle.length - 1 ? 260 : 70;
          note.releaseMs = 200;
          note.gain = 0.7;
          layer('pulse25', when + i * 0.095, dest, i === 0 ? slot : null);
        }
        break;
      }

      // "downward time-stop sweep + slow tick-tock during effect"
      case 'clockFreeze': {
        resetNote(note);
        note.pan = 0;
        note.freq = 1400;
        note.sweepToHz = 160;
        note.sweepMs = 700;
        note.holdMs = 600;
        note.releaseMs = 260;
        note.filterType = 'lowpass';
        note.filterHz = 2200;
        note.gain = 0.6;
        layer('pulse25', when, dest, slot);
        resetNote(note);
        note.filterType = 'lowpass';
        note.filterHz = 1400;
        note.decayMs = 520;
        note.releaseMs = 300;
        note.gain = 0.3;
        layer('noiseFx', when, dest, null);
        break;
      }

      // "3 hammer clanks; reverse-sweep warning at blink phase"
      case 'shovelClank': {
        // `intensity` is the shovel phase: 1 = the wall going up, 0.5 = the
        // blink warning, 0 = the revert.
        if (intensity > 0.75) {
          for (let i = 0; i < 3; i++) {
            resetNote(note);
            note.pan = 0;
            note.freq = 1600 - i * 120;
            note.decayMs = 90;
            note.releaseMs = 90;
            note.gain = 0.6;
            layer('bell', when + i * 0.09, dest, i === 0 ? slot : null);
            resetNote(note);
            note.pan = 0;
            note.filterType = 'bandpass';
            note.filterHz = 3000;
            note.filterQ = 1.5;
            note.decayMs = 40;
            note.releaseMs = 30;
            note.gain = 0.3;
            layer('noiseFx', when + i * 0.09, dest, null);
          }
        } else if (intensity > 0.25) {
          // The reverse sweep: the wall is about to go, and the sound rising
          // into nothing is the warning.
          resetNote(note);
          note.pan = 0;
          note.filterType = 'bandpass';
          note.filterHz = 900;
          note.filterQ = 3;
          note.decayMs = 420;
          note.holdMs = 380;
          note.releaseMs = 200;
          note.gain = 0.45;
          layer('noiseFx', when, dest, slot);
          resetNote(note);
          note.pan = 0;
          note.freq = 220;
          note.sweepToHz = 1800;
          note.sweepMs = 520;
          note.holdMs = 460;
          note.releaseMs = 120;
          note.gain = 0.3;
          layer('pulse12', when, dest, null);
        } else {
          resetNote(note);
          note.pan = 0;
          note.freq = 320;
          note.decayMs = 140;
          note.releaseMs = 160;
          note.gain = 0.45;
          layer('bell', when, dest, slot);
        }
        break;
      }

      // "wobble buzz 300 ms + comedic spring"
      case 'stunBuzz': {
        resetNote(note);
        note.pan = pan;
        note.freq = 180;
        note.vibratoCents = 90;
        note.holdMs = 260 * intensity + 60;
        note.releaseMs = 120;
        note.filterType = 'lowpass';
        note.filterHz = 1600;
        note.gain = 0.5;
        layer('pulse25', when, dest, slot);
        // The spring: a fast rise with heavy vibrato, which is the whole joke.
        resetNote(note);
        note.pan = pan;
        note.freq = 300;
        note.sweepToHz = 1500;
        note.sweepMs = 220;
        note.vibratoCents = 140;
        note.holdMs = 200;
        note.releaseMs = 140;
        note.gain = 0.22;
        layer('pulse50', when + 0.12, dest, null);
        break;
      }

      // "short leaf-noise chiff"
      case 'treeRustle': {
        resetNote(note);
        note.pan = pan;
        note.filterType = 'bandpass';
        note.filterHz = 2600 + nextVariation() * 500;
        note.filterQ = 0.8;
        note.decayMs = 110;
        note.releaseMs = 80;
        note.gain = 0.22;
        layer('noiseFx', when, dest, slot);
        break;
      }

      // "pulse blip / bell confirm / low blip"
      case 'uiMove': {
        resetNote(note);
        note.freq = 660;
        note.holdMs = 20;
        note.releaseMs = 50;
        note.gain = 0.6;
        layer('pulse50', when, dest, slot);
        break;
      }
      case 'uiSelect': {
        for (let i = 0; i < 2; i++) {
          resetNote(note);
          note.freq = midiToFreq(76 + i * 7);
          note.decayMs = 200;
          note.releaseMs = 180;
          note.gain = 0.55;
          layer('bell', when + i * 0.055, dest, i === 0 ? slot : null);
        }
        break;
      }
      case 'uiBack': {
        resetNote(note);
        note.freq = 220;
        note.holdMs = 25;
        note.releaseMs = 70;
        note.gain = 0.55;
        layer('pulse50', when, dest, slot);
        break;
      }

      // "per-line counting blips, pitch rising with total"
      case 'tallyTick': {
        resetNote(note);
        note.freq = midiToFreq(72 + Math.round(intensity * 12));
        note.holdMs = 12;
        note.releaseMs = 40;
        note.gain = 0.45;
        layer('pulse25', when, dest, slot);
        break;
      }

      // The sustained rows, auditioned. `update` is what actually plays them;
      // this path exists so every §5 id is playable on demand — the settings
      // screen's volume preview, and the offline capture harness.
      case 'engineIdle':
      case 'engineMove': {
        resetNote(note);
        note.pan = pan;
        note.freq = midiToFreq(ENGINE.rootMidi);
        note.detuneCents = id === 'engineMove' ? engineCents(1) : 0;
        note.holdMs = 400;
        note.releaseMs = 120;
        note.filterType = 'lowpass';
        note.filterHz = ENGINE.lowpassHz;
        note.gain = engineGain(id === 'engineMove' ? 1 : 0) * 4;
        layer('pulse12', when, dest, slot);
        break;
      }
      case 'helmetLoop': {
        resetNote(note);
        note.pan = pan;
        note.freq = midiToFreq(64);
        note.vibratoCents = 25;
        note.holdMs = 500;
        note.releaseMs = 200;
        note.filterType = 'lowpass';
        note.filterHz = 900;
        note.gain = 0.5;
        layer('pulse50', when, dest, slot);
        break;
      }
      case 'iceSlide': {
        resetNote(note);
        note.pan = pan;
        note.filterType = 'bandpass';
        note.filterHz = 1400;
        note.filterQ = 1.1;
        note.decayMs = 320;
        note.holdMs = 260;
        note.releaseMs = 200;
        note.gain = 0.35 * intensity;
        layer('noiseFx', when, dest, slot);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sustained-voice construction
  // -------------------------------------------------------------------------

  function ensureHum(index: 0 | 1): HumVoice {
    const found = hums[index];
    if (found !== null) {
      return found;
    }
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(rt.waves.pulse12);
    osc.frequency.value = midiToFreq(ENGINE.rootMidi);
    osc.detune.value = 0;

    // THE two-note buzz. A square LFO at 8 Hz into ±50 cents makes `detune`
    // flip between −50 and +50 — a semitone apart — with no JS per frame.
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = ENGINE.alternateHz;
    // Player two's buzz is deliberately out of phase with player one's: two
    // identical 8 Hz squares beating together sound like one louder tank.
    lfo.detune.value = index === 1 ? 40 : 0;
    const depth = ctx.createGain();
    depth.gain.value = ENGINE.alternateCents / 2;
    lfo.connect(depth);
    depth.connect(osc.detune);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = ENGINE.lowpassHz;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(graph.sfxBus);
    osc.start();
    lfo.start();

    const voice: HumVoice = {
      osc,
      lfo,
      gain,
      panner,
      cents: NEVER,
      level: NEVER,
      pan: NEVER,
    };
    hums[index] = voice;
    return voice;
  }

  function ensureShield(index: 0 | 1): LoopVoice {
    const found = shields[index];
    if (found !== null) {
      return found;
    }
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(rt.waves.pulse50);
    osc.frequency.value = midiToFreq(64);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.value = 30;
    lfo.connect(depth);
    depth.connect(osc.detune);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(graph.sfxBus);
    osc.start();
    lfo.start();
    const voice: LoopVoice = { gain, level: NEVER, sources: [osc, lfo] };
    shields[index] = voice;
    return voice;
  }

  function ensureIce(): LoopVoice {
    if (ice !== null) {
      return ice;
    }
    const src = ctx.createBufferSource();
    src.buffer = rt.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(graph.sfxBus);
    src.start();
    ice = { gain, level: NEVER, sources: [src] };
    return ice;
  }

  /** Re-targets a smoothed parameter, and only when it has actually moved. */
  function retarget(
    param: AudioParam,
    current: number,
    next: number,
    now: number,
    epsilon: number,
  ): number {
    if (Math.abs(next - current) <= epsilon) {
      return current;
    }
    param.setTargetAtTime(next, now, ENGINE.smoothingS);
    return next;
  }

  function trigger(
    id: SfxId,
    pan: number,
    intensity: number,
    when: number = ctx.currentTime,
  ): boolean {
    const index = SFX_INDEX[id];
    const def = SFX[id];
    if (when - lastAt[index] < RETRIGGER_GUARD_MS / 1000) {
      return false;
    }
    const slot = pool.acquire(
      index,
      PRIORITY_RANK[def.priority],
      def.poly,
      when,
    );
    if (slot === null) {
      return false;
    }
    lastAt[index] = when;
    render(
      id,
      when,
      clamp(pan, -1, 1),
      clamp(intensity, 0, 1),
      def.bus === 'sting' ? graph.stingBus : graph.sfxBus,
      slot,
    );
    return true;
  }

  return {
    trigger,

    onEvent(e: GameEvent): void {
      const id = sfxForEvent(e);
      if (id === null) {
        return;
      }
      trigger(id, panOfEvent(e), intensityOfEvent(e));
    },

    update(state: GameState, dtMs: number): void {
      const now = ctx.currentTime;
      const dtS = dtMs / 1000;

      // A paused board is a silent board. On the NES the engine hum cuts the
      // instant you press start, and it is half of what makes the pause read
      // as a pause — so every sustained voice goes to zero and every timed
      // loop stops, while one-shots already in flight are left to finish.
      if (state.paused) {
        for (let p = 0; p < 2; p++) {
          const hum = hums[p];
          if (hum !== null) {
            hum.level = retarget(hum.gain.gain, hum.level, 0, now, 0.0005);
          }
          const shield = shields[p];
          if (shield !== null) {
            shield.level = retarget(shield.gain.gain, shield.level, 0, now, 0.0005); // prettier-ignore
          }
        }
        if (ice !== null) {
          ice.level = retarget(ice.gain.gain, ice.level, 0, now, 0.0005);
        }
        return;
      }

      // One pass over the tanks for everything the sustained voices need.
      let slide = 0;
      let nearestPowerupU = Number.POSITIVE_INFINITY;
      const speeds: [number, number] = [-1, -1];
      const shielded: [boolean, boolean] = [false, false];
      const pans: [number, number] = [0, 0];
      for (let i = 0; i < state.tanks.length; i++) {
        const tank = state.tanks[i];
        if (!tank.alive) {
          continue;
        }
        if (tank.sliding) {
          const v = Math.abs(tank.slideV);
          slide = v > slide ? v : slide;
        }
        if (tank.kind !== 'player' || tank.playerIndex === undefined) {
          continue;
        }
        if (state.powerup !== null) {
          const dx = tank.x - state.powerup.x;
          const dy = tank.y - state.powerup.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          nearestPowerupU = d < nearestPowerupU ? d : nearestPowerupU;
        }
        // A tank still flickering into existence has no engine yet.
        if (tank.spawningT > 0) {
          continue;
        }
        const p = tank.playerIndex;
        speeds[p] = engineSpeed01(tank);
        shielded[p] = tank.shieldT > 0;
        pans[p] = panForX(tank.x);
      }

      for (let p = 0; p < 2; p++) {
        const index = p as 0 | 1;
        const speed = speeds[index];
        // Nothing is built for a player who has never been on the field, so a
        // 1P run never allocates player two's oscillators.
        if (speed < 0 && hums[index] === null) {
          continue;
        }
        const hum = ensureHum(index);
        const level = speed < 0 ? 0 : engineGain(speed);
        hum.level = retarget(hum.gain.gain, hum.level, level, now, 0.0005);
        if (speed >= 0) {
          hum.cents = retarget(
            hum.osc.detune,
            hum.cents,
            engineCents(speed),
            now,
            0.5,
          );
          hum.pan = retarget(hum.panner.pan, hum.pan, pans[index], now, 0.01);
        }

        if (shielded[index] || shields[index] !== null) {
          const shield = ensureShield(index);
          shield.level = retarget(
            shield.gain.gain,
            shield.level,
            shielded[index] ? SHIELD_GAIN : 0,
            now,
            0.0005,
          );
        }
      }

      if (slide > 0 || ice !== null) {
        const voice = ensureIce();
        // Audio §5: "gain ∝ slide speed".
        const level = Math.min(1, slide / PLAYER_SPEED) * 0.2;
        voice.level = retarget(
          voice.gain.gain,
          voice.level,
          level,
          now,
          0.0005,
        );
      }

      // The power-up sparkle: quiet, and range-limited to the player who could
      // actually reach it (audio §5).
      if (state.powerup !== null) {
        sparkleT -= dtS;
        if (sparkleT <= 0) {
          sparkleT = SPARKLE_PERIOD_S;
          const reach = clamp(1 - nearestPowerupU / SPARKLE_RANGE_U, 0, 1);
          if (reach > 0.02) {
            oneShots++;
            resetNote(note);
            note.pan = panForX(state.powerup.x);
            note.freq = midiToFreq(clockToggle ? 91 : 96);
            note.decayMs = 200;
            note.releaseMs = 180;
            note.gain = 0.1 * reach;
            layer('bell', now, graph.sfxBus, null);
          }
        }
      } else {
        sparkleT = 0;
      }

      // The clock freeze's tick-tock. Two pitches, alternating, slow — the
      // sound of a second hand that has stopped meaning anything.
      if (state.clockT > 0) {
        clockT -= dtS;
        if (clockT <= 0) {
          clockT = CLOCK_TICK_PERIOD_S;
          clockToggle = !clockToggle;
          oneShots++;
          resetNote(note);
          note.pan = clockToggle ? -0.15 : 0.15;
          note.freq = clockToggle ? 1500 : 1180;
          note.decayMs = 55;
          note.releaseMs = 60;
          note.gain = 0.3;
          layer('bell', now, graph.sfxBus, null);
        }
      } else {
        clockT = 0;
      }
    },

    engineLevel(playerIndex: 0 | 1): number {
      const hum = hums[playerIndex];
      return hum === null || hum.level === NEVER ? 0 : hum.level;
    },

    shieldLevel(playerIndex: 0 | 1): number {
      const shield = shields[playerIndex];
      return shield === null || shield.level === NEVER ? 0 : shield.level;
    },

    slideLevel(): number {
      return ice === null || ice.level === NEVER ? 0 : ice.level;
    },

    stats(): SfxStats {
      let sustained = 0;
      for (let i = 0; i < 2; i++) {
        if (hums[i] !== null) {
          sustained++;
        }
        if (shields[i] !== null) {
          sustained++;
        }
      }
      if (ice !== null) {
        sustained++;
      }
      return { oneShots, voices: pool.activeCount(), sustained };
    },

    dispose(): void {
      const now = ctx.currentTime;
      // Fade first, stop a beat later: a source cut mid-cycle is a click, and
      // the last thing a screen change should make is a click.
      const park = (voice: LoopVoice | null, at: number): void => {
        if (voice === null) {
          return;
        }
        voice.gain.gain.setTargetAtTime(0, at, 0.02);
        voice.level = 0;
        for (const source of voice.sources) {
          source.stop(at + 0.1);
        }
      };
      for (let i = 0; i < 2; i++) {
        const hum = hums[i];
        if (hum !== null) {
          hum.gain.gain.setTargetAtTime(0, now, 0.02);
          hum.osc.stop(now + 0.1);
          hum.lfo.stop(now + 0.1);
          hum.level = 0;
        }
        park(shields[i], now);
      }
      park(ice, now);
      pool.releaseAll(now);
    },
  };
}
