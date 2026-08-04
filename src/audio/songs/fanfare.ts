// src/audio/songs/fanfare.ts — the stage-intro fanfare (audio §4).
//
// **An original composition.** Not a transcription, and deliberately not a
// reconstruction of Namco's cue from memory, from a recording or from any
// other source. This repo deploys publicly under the owner's name, a melody is
// about the clearest form of protected expression there is, and "make it sound
// like the original" is not an instruction to approximate the original's notes.
// So this is ours. It is aimed at the *character* of the moment — the curtain
// opening on a fresh board — rather than at any particular tune.
//
// That moves it off audio §7's faithful list; noted there for an amendment.
// The two remaining faithful-set entries are the game over and the pause chirp,
// both still marked UNVERIFIED per §7's honesty note.
//
// ## Why it was rewritten
//
// The first version was written against a constraint rather than as music: a
// bright A-major arpeggio squeezed into one bar because that is what fit inside
// fidelity §11.1's 2 s curtain. It had two problems. It was thin — four rising
// notes and a turn, with no second phrase to lift into — and its A major fought
// the piece it hands to, because the suite's L0 bed is **Phrygian on A** and a
// C♯ contradicts the C♮ everything after it lives in.
//
// This cue plays 35+ times a playthrough, at the moment the player is most
// attentive. It is worth two phrases.
//
// ## What this one is, musically
//
// **Two bars, notated at 240 BPM and felt in half-time — a 120 bpm march with
// the eighth-note subdivision available.** That is the whole reason for the
// tempo marking: `ppq: 4` gives sixteenths, and at 120 BPM a sixteenth is
// 125 ms, which is too slow to articulate a dotted martial figure. At 240 the
// tick is 62.5 ms, a dotted-eighth-plus-sixteenth is 187.5 + 62.5 ms, and the
// piece still lands on **2.000 s** — the downbeat of L0, exactly where §4 wants
// it and exactly where the curtain lifts. No core constant had to move.
//
// **Bar 1 — the call.** One motif note per beat, each in a dotted 3+1 figure:
// A4 · C5 · E5 · A5, ascending across the whole bar, landing on the octave and
// holding it. Those four pitches ARE {@link FANFARE_MOTIF}, which is the same
// figure the title theme opens on and the suite's L3 lead sings — so the stage
// start, the menu and the battle music are all built from one idea.
//
// **Bar 2 — the lift and the landing.** The same shape an octave higher, but it
// keeps climbing past the octave to a peak on **E6**, and on the way up the
// ♭2 arrives: B♭5, the note the whole cue has been avoiding. Then a four-note
// Phrygian descent — E6 · C6 · B♭5 · A5, i.e. 5 · ♭3 · ♭2 · 1 — drops onto the
// tonic. Under it the bass walks i–V–VI–**♭II**–i: an Andalusian cadence, which
// is the oldest martial-sounding progression there is and the reason a minor
// fanfare reads as heroic rather than as sad.
//
// ## The hand-off, which is half the point
//
// L0 is an eighth-note ostinato alternating **A2 ↔ A♯2**. So the last two bass
// notes of this piece are **A♯2 then A2** — L0's two notes, in order, played
// once at half speed immediately before L0 starts alternating them forever.
// The final A2 is held into its `triBass` R80 release, so the bass note ringing
// when L0's first note begins is *the same pitch*, and the ♭2 that L0 leans on
// has already been introduced by the lead and cadenced on by the bass.
//
// The suite's entry should therefore feel like an answer rather than a start.
// `scripts/capture-audio.ts` renders `fanfare-handoff.wav` — this cue followed
// immediately by L0 alone — because that transition cannot be judged from two
// separate files.

import { piece, type MusicPiece, type Song } from '../sequencer';

/**
 * The four rising notes every piece in the game quotes: **A4 · C5 · E5 · A5**,
 * the tonic minor triad taken up to the octave.
 *
 * It used to be the major version (A4 C♯5 E5 A5) and the title theme and the
 * suite's lead each flattened its third by hand to fit the key. Now that the
 * fanfare itself is in the mode everything else lives in, the quote is
 * **literal** in all three places, and the tests assert exact equality rather
 * than equality-after-an-adjustment.
 */
export const FANFARE_MOTIF: readonly number[] = Object.freeze([69, 72, 76, 81]);

/** Two bars of sixteen sixteenths, 62.5 ms each: 2.000 s to the tick. */
const BAR = 16;

export const fanfareSong: Song = {
  bpm: 240,
  ppq: 4,
  loopAtTick: 2 * BAR,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'lead',
      steps: [
        // --- bar 1: the call. The motif, one note per beat, dotted 3+1. -----
        [0, FANFARE_MOTIF[0], 3, 1],
        [3, FANFARE_MOTIF[0], 1, 0.65],
        [4, FANFARE_MOTIF[1], 3, 1],
        [7, FANFARE_MOTIF[1], 1, 0.65],
        [8, FANFARE_MOTIF[2], 3, 1],
        // G5, an upper neighbour that leans into the octave rather than
        // stepping to it — the difference between a scale and a call.
        [11, 79, 1, 0.7],
        [12, FANFARE_MOTIF[3], 4, 1],

        // --- bar 2: the lift, and the Phrygian landing ---------------------
        [16, 81, 3, 1],
        [19, 82, 1, 0.75], // B♭5 — the ♭2 arrives
        [20, 84, 3, 1], // C6
        [23, 86, 1, 0.8], // D6
        [24, 88, 2, 1], // E6 — the peak
        [26, 84, 1, 0.9], // C6  ┐ 5 · ♭3 · ♭2 · 1
        [27, 82, 1, 0.9], // B♭5 │
        [28, 81, 4, 1], // A5   ┘ home, on the downbeat L0 takes over
      ],
    },
    {
      // The second pulse, an octave under the lead for most of the cue and a
      // fifth under the landing. Octave-doubling two different duties is the
      // 2A03 way to make one line sound like a section; the hollow fifth at
      // the end is what stops the landing sounding like a pop chord.
      instrument: 'pulse25',
      layer: 'harmony',
      steps: [
        [0, 57, 3, 0.5],
        [3, 57, 1, 0.35],
        [4, 60, 3, 0.5],
        [7, 60, 1, 0.35],
        [8, 64, 3, 0.5],
        [11, 67, 1, 0.4],
        [12, 69, 4, 0.55],

        [16, 69, 3, 0.5],
        [19, 70, 1, 0.4],
        [20, 72, 3, 0.55],
        [23, 74, 1, 0.45],
        [24, 76, 2, 0.6],
        [26, 72, 1, 0.5],
        [27, 70, 1, 0.5],
        [28, 76, 4, 0.6], // E5 under A5 — the fifth, not the third
      ],
    },
    {
      // i – V – VI – ♭II – i. The last two are L0's own notes, in order.
      instrument: 'triBass',
      layer: 'bass',
      steps: [
        [0, 45, 7, 0.95], // A2   i
        [7, 45, 1, 0.7],
        [8, 40, 7, 0.95], // E2   V
        [15, 40, 1, 0.7],
        [16, 41, 7, 0.95], // F2   VI
        [23, 41, 1, 0.7],
        [24, 46, 4, 1], // A♯2  ♭II — the Phrygian cadence, and L0's upper note
        [28, 45, 4, 1], // A2   i  — and L0's first note, still ringing into it
      ],
    },
    {
      // Audio §1's "modern body": the 2A03 had no kick, and these are what stop
      // the cue reading as a ringtone.
      instrument: 'kick',
      layer: 'drums',
      steps: [
        [0, 36, 1, 1],
        [4, 36, 1, 0.75],
        [8, 36, 1, 0.9],
        [12, 36, 1, 0.85],
        [16, 36, 1, 1],
        [20, 36, 1, 0.75],
        [24, 36, 1, 0.95],
        [28, 36, 1, 1],
      ],
    },
    {
      // A three-sixteenth pickup roll into bar 2 and a second into the landing.
      // This is the "sit up" — a drum figure that accelerates is a drum figure
      // that says something is about to happen.
      instrument: 'snare',
      layer: 'drums',
      steps: [
        [13, 38, 1, 0.45],
        [14, 38, 1, 0.6],
        [15, 38, 1, 0.8],
        [20, 38, 1, 0.55],
        [25, 38, 1, 0.5],
        [26, 38, 1, 0.65],
        [27, 38, 1, 0.85],
        [28, 38, 1, 1],
      ],
    },
  ],
};

export const fanfare: MusicPiece = piece(fanfareSong, false);
