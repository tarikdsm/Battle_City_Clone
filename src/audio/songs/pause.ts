// src/audio/songs/pause.ts — the pause chirp (audio §4, §7 FAITHFUL).
//
// Two notes, high, fast, up. That is the whole thing, and it is the easiest of
// the faithful three to hit because it is the smallest target: an eighth of a
// second of two bright beeps a fourth apart is a pause chirp in any game that
// ever had one.
//
// ## Why it is a "song" and not an SFX
//
// Audio §4 lists it in the music map ("Pause jingle: faithful two-note pause
// chirp; music halts while paused"), and putting it on the music bus makes the
// halt free: `playMusic('pause')` replaces whatever the sequencer was playing,
// so the chirp and the silence that follows it are one action instead of two
// that can disagree.
//
// The cost of that is real and worth stating: a player who has pulled the
// **music** slider to zero gets no pause chirp. If that turns out to be wrong,
// the fix is to move these two notes into `sfx.ts` as a `uiSelect`-style row —
// it is note data either way.

import { piece, type MusicPiece, type Song } from '../sequencer';

export const pauseSong: Song = {
  bpm: 240, // a tick is 62.5 ms — the chirp is two of them
  ppq: 4,
  loopAtTick: 8,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'ui',
      steps: [
        [0, 88, 1, 0.85], // E6
        [1, 93, 2, 0.9], // A6
      ],
    },
  ],
};

export const pause: MusicPiece = piece(pauseSong, false);
