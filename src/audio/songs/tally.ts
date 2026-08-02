// src/audio/songs/tally.ts — the stage-clear jingle (audio §4, NEW).
//
// §4: "rising resolution jingle + tally tick sounds, 6 s + per-line ticks".
// Three bars at 120 BPM is 6.000 s exactly; the per-line ticks are `tallyTick`
// in `sfx.ts` and are fired by the tally screen, not by this piece.
//
// The shape is the opposite of `gameover.ts` on purpose. That one falls through
// i–VII–VI–V and stops on the dominant, unresolved. This one **climbs** F–G–C
// and lands on the relative major with a bell arpeggio over it: the same key
// signature, the same three chords in the other direction, resolving where the
// game over refuses to. A player who has just heard one should hear the other
// as its answer.

import { merge, piece, type MusicPiece, type Song } from '../sequencer';

export const tallySong: Song = {
  bpm: 120,
  ppq: 4,
  loopAtTick: 48,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'lead',
      steps: [
        // F: up to the fourth
        [0, 65, 2, 0.9],
        [2, 69, 2, 0.9],
        [4, 72, 4, 0.95],
        [8, 77, 8, 1],
        // G: the same shape a step higher
        [16, 67, 2, 0.9],
        [18, 71, 2, 0.9],
        [20, 74, 4, 0.95],
        [24, 79, 8, 1],
        // C: and over the top
        [32, 72, 2, 0.95],
        [34, 76, 2, 0.95],
        [36, 79, 2, 1],
        [38, 84, 10, 1],
      ],
    },
    {
      instrument: 'triBass',
      layer: 'bass',
      steps: [
        [0, 41, 16, 1],
        [16, 43, 16, 1],
        [32, 48, 16, 1],
      ],
    },
    {
      // The sparkle on the landing — the same `bell` the power-up pickup uses,
      // so the stage-clear and the reward share a timbre.
      instrument: 'bell',
      layer: 'sparkle',
      steps: merge([
        [38, 84, 4, 0.6],
        [40, 88, 4, 0.6],
        [42, 91, 4, 0.6],
        [44, 96, 4, 0.7],
      ]),
    },
    {
      instrument: 'kick',
      layer: 'drums',
      steps: [
        [0, 36, 1, 0.9],
        [16, 36, 1, 0.9],
        [32, 36, 1, 1],
        [38, 36, 1, 0.8],
      ],
    },
  ],
};

export const tally: MusicPiece = piece(tallySong, false);
