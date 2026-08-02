// src/audio/songs/hiscore.ts — the high-score entry loop (audio §4, NEW).
//
// §4: "sparkly bell loop, 8 bars". Eight bars at 160 BPM is 12 s a lap, which
// is long enough not to nag while someone is picking three letters and short
// enough to feel like a loop rather than a drone.
//
// Nothing but bells and a bass: no drums, no lead, no tension. This is the one
// screen in the game where nothing is trying to kill you, and the music's job
// is to say so. The harmony is Am–F–C–G — the same four chords the title theme
// turns over — so entering a score sounds like the title screen has come back
// round, which is where the player is about to be.

import {
  TICKS_PER_BAR,
  merge,
  ostinato,
  piece,
  type MusicPiece,
  type Song,
} from '../sequencer';

const BAR = TICKS_PER_BAR;
const LOOP = 8 * BAR;

export const hiscoreSong: Song = {
  bpm: 160,
  ppq: 4,
  loopAtTick: LOOP,
  tracks: [
    {
      instrument: 'bell',
      layer: 'sparkle',
      steps: merge(
        ostinato(0, 2 * BAR, 2, [81, 84, 88, 93, 88, 84, 81, 84], 2, 0.5),
        ostinato(2 * BAR, 4 * BAR, 2, [77, 81, 84, 89, 84, 81, 77, 81], 2, 0.5),
        ostinato(4 * BAR, 6 * BAR, 2, [84, 88, 91, 96, 91, 88, 84, 88], 2, 0.5),
        ostinato(6 * BAR, LOOP, 2, [79, 83, 86, 91, 86, 83, 79, 83], 2, 0.5),
      ),
    },
    {
      instrument: 'triBass',
      layer: 'bass',
      steps: [
        [0, 45, 28, 0.8],
        [2 * BAR, 41, 28, 0.8],
        [4 * BAR, 48, 28, 0.8],
        [6 * BAR, 43, 28, 0.8],
      ],
    },
    {
      instrument: 'pad',
      layer: 'pad',
      steps: [
        [0, 57, 30, 0.45],
        [0, 60, 30, 0.4],
        [2 * BAR, 53, 30, 0.45],
        [2 * BAR, 57, 30, 0.4],
        [4 * BAR, 60, 30, 0.45],
        [4 * BAR, 64, 30, 0.4],
        [6 * BAR, 55, 30, 0.45],
        [6 * BAR, 59, 30, 0.4],
      ],
    },
  ],
};

export const hiscore: MusicPiece = piece(hiscoreSong, true);
