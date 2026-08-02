// src/audio/songs/fanfare.ts — the stage-intro fanfare (audio §4, §7 FAITHFUL).
//
// Audio §7's bar for the faithful set: "a Battle City player must recognize
// each within 2 seconds". This one has only two seconds to work with, so every
// note in it is load-bearing.
//
// ## Length: two seconds, not the doc's four
//
// Audio §4 says "~4 s, plays over curtain/fly-in, ends on downbeat of Layer 0".
// Those two clauses cannot both hold: fidelity §11.1's curtain is
// `STAGE_INTRO_S = 2` seconds, which is a **core constant and a golden-replay
// input**, so a four-second fanfare either overruns into gameplay or the
// simulation has to change. The doc's own "ends on downbeat of Layer 0" is the
// clause with a mechanism behind it, so it wins: one bar at 120 BPM is exactly
// 2.000 s, and the suite's L0 ostinato starts on the tick this piece ends.
//
// The release tails ring past the downbeat by design — the last note is a
// `pulse50` with R60 over a `triBass` with R80 — so it *sounds* like it hands
// over rather than stopping. Namco's original runs about five seconds (three
// tracks are listed for the whole game: Stage Start 0:05, Game Over 0:03, Got
// High Score 0:09), which means it plays well into the first seconds of the
// stage. Reported for a §4 amendment: either shorten §4's figure to ~2 s, or
// move `STAGE_INTRO_S`, which is a core change and not this task's to make.
//
// ## What it is
//
// A rising major arpeggio that lands on the tonic and steps down to rest on
// it — bright, martial, over in a bar. The rise is the motif the title theme
// and the suite's L3 lead both quote; see `title.ts` and `suite.ts`.

import { TICKS_PER_BAR, piece, type MusicPiece, type Song } from '../sequencer';

/**
 * The four rising notes every other piece quotes: A4 → C#5 → E5 → A5, i.e. the
 * tonic triad taken up an octave. Exported because a motif that is copied by
 * hand into three files is a motif that drifts apart in three files.
 */
export const FANFARE_MOTIF: readonly number[] = Object.freeze([69, 73, 76, 81]);

const BAR = TICKS_PER_BAR;

export const fanfareSong: Song = {
  bpm: 120,
  ppq: 4,
  loopAtTick: BAR,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'lead',
      steps: [
        // The rise: two ticks each, so it is over in half a bar and the ear
        // gets the whole shape before it has finished arriving.
        [0, FANFARE_MOTIF[0], 2, 1],
        [2, FANFARE_MOTIF[1], 2, 1],
        [4, FANFARE_MOTIF[2], 2, 1],
        [6, FANFARE_MOTIF[3], 3, 1],
        // …and the landing: a turn around the tonic that resolves onto it.
        [10, 83, 1, 0.85],
        [11, 81, 1, 0.9],
        [12, 76, 1, 0.85],
        [13, 81, 3, 1],
      ],
    },
    {
      // A third below the rise, a sixth below the landing: the harmony is
      // there to thicken, never to be heard as a second tune.
      instrument: 'pulse25',
      layer: 'harmony',
      steps: [
        [0, 61, 2, 0.5],
        [2, 64, 2, 0.5],
        [4, 69, 2, 0.5],
        [6, 73, 3, 0.5],
        [13, 73, 3, 0.55],
      ],
    },
    {
      instrument: 'triBass',
      layer: 'bass',
      steps: [
        [0, 45, 6, 0.9],
        [6, 45, 4, 0.9],
        [10, 40, 3, 0.9],
        [13, 45, 3, 1],
      ],
    },
    {
      // Audio §1's "modern body": the NES had no kick, and two of them are
      // what stop this reading as a ringtone.
      instrument: 'kick',
      layer: 'drums',
      steps: [
        [0, 36, 1, 1],
        [6, 36, 1, 0.8],
        [13, 36, 1, 1],
      ],
    },
  ],
};

export const fanfare: MusicPiece = piece(fanfareSong, false);
