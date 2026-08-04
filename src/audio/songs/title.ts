// src/audio/songs/title.ts — the title theme (audio §4, NEW).
//
// §4: "new, quotes stage-fanfare motif; ~92 BPM, A minor, pulse lead over pad
// + triBass; loops 32 bars". All four, verbatim, including the instrumentation
// — there are no drums on this one, which is why it sits still while the menu
// waits rather than driving like the gameplay suite does.
//
// ## Form
//
// AABA over 32 bars, on an eight-bar turn of Am–F–C–G. The A section opens on
// `FANFARE_MOTIF` with its major third flattened: the stage jingle is the
// first thing the player hears on the title screen and the first thing they
// hear when a stage begins, which is what "quotes the motif" is supposed to
// buy. The B section stops moving and holds the upper register, so the return
// of A lands.
//
// **Not wired to anything yet** — there is no title screen until T6.1. It is
// composed, rendered and measured here so that T6.1 is a `playMusic('title')`
// and not a composition task.

import {
  TICKS_PER_BAR,
  merge,
  ostinato,
  phrase,
  piece,
  repeat,
  type MusicPiece,
  type Song,
  type SongStep,
} from '../sequencer';
import { FANFARE_MOTIF } from './fanfare';

const BAR = TICKS_PER_BAR;
/** Eight bars of harmony, turned four times. */
const CYCLE = 8 * BAR;
const LOOP = 4 * CYCLE;

/** Am – F – C – G, two bars each. Root and fifth, so the bass has a gait. */
const BASS_CYCLE: SongStep[] = merge(
  ostinato(0, 2 * BAR, 2, [45, 52], 2, 0.75),
  ostinato(2 * BAR, 4 * BAR, 2, [41, 48], 2, 0.75),
  ostinato(4 * BAR, 6 * BAR, 2, [48, 55], 2, 0.75),
  ostinato(6 * BAR, CYCLE, 2, [43, 50], 2, 0.75),
);

const PAD_CYCLE: SongStep[] = [
  [0, 57, 30, 0.5],
  [0, 60, 30, 0.45],
  [0, 64, 30, 0.4],
  [2 * BAR, 53, 30, 0.5],
  [2 * BAR, 57, 30, 0.45],
  [2 * BAR, 60, 30, 0.4],
  [4 * BAR, 60, 30, 0.5],
  [4 * BAR, 64, 30, 0.45],
  [4 * BAR, 67, 30, 0.4],
  [6 * BAR, 55, 30, 0.5],
  [6 * BAR, 59, 30, 0.45],
  [6 * BAR, 62, 30, 0.4],
];

/**
 * The A section. Bar 1 is {@link FANFARE_MOTIF} **literally** — the same four
 * notes the stage-intro fanfare opens on, which is why the title screen and
 * the start of a stage feel like the same game. (It used to be the motif with
 * its third flattened by hand, because the fanfare was in the major; the T5.4
 * rewrite put the fanfare in the mode everything else already lived in.)
 */
const THEME: SongStep[] = [
  [0, FANFARE_MOTIF[0], 2, 0.9],
  [2, FANFARE_MOTIF[1], 2, 0.9],
  [4, FANFARE_MOTIF[2], 2, 0.9],
  [6, FANFARE_MOTIF[3], 6, 1],
  [14, 79, 2, 0.85],
  [16, 76, 4, 0.85],
  [20, 72, 4, 0.85],
  [24, 74, 6, 0.8],

  [32, 77, 4, 0.9],
  [36, 76, 4, 0.85],
  [40, 72, 8, 0.85],
  [48, 69, 4, 0.85],
  [52, 72, 4, 0.85],
  [56, 65, 6, 0.8],

  [64, 72, 4, 0.9],
  [68, 76, 4, 0.9],
  [72, 79, 8, 0.95],
  [80, 76, 4, 0.85],
  [84, 72, 4, 0.85],
  [88, 67, 6, 0.8],

  [96, 74, 4, 0.9],
  [100, 71, 4, 0.85],
  [104, 67, 8, 0.85],
  [112, 71, 4, 0.85],
  [116, 74, 4, 0.9],
  [120, 79, 6, 0.9],
];

/** The B section: high, slow, and going nowhere, so that A's return arrives. */
const BRIDGE: SongStep[] = [
  [0, 84, 8, 0.8],
  [8, 81, 8, 0.75],
  [16, 79, 12, 0.75],
  [28, 81, 4, 0.7],

  [32, 89, 8, 0.8],
  [40, 84, 8, 0.75],
  [48, 81, 12, 0.75],
  [60, 84, 4, 0.7],

  [64, 88, 8, 0.85],
  [72, 84, 8, 0.8],
  [80, 79, 12, 0.75],
  [92, 76, 4, 0.7],

  [96, 86, 8, 0.85],
  [104, 83, 8, 0.8],
  [112, 79, 8, 0.8],
  [120, 74, 8, 0.75],
];

export const titleSong: Song = {
  bpm: 92,
  ppq: 4,
  loopAtTick: LOOP,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'lead',
      steps: merge(
        phrase(0, THEME),
        phrase(CYCLE, THEME),
        phrase(2 * CYCLE, BRIDGE),
        phrase(3 * CYCLE, THEME),
      ),
    },
    {
      instrument: 'triBass',
      layer: 'bass',
      steps: repeat(BASS_CYCLE, 4, CYCLE),
    },
    {
      instrument: 'pad',
      layer: 'pad',
      steps: repeat(PAD_CYCLE, 4, CYCLE),
    },
  ],
};

export const title: MusicPiece = piece(titleSong, true);
