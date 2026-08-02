// src/audio/songs/gameover.ts — the game-over motif (audio §4, §7 FAITHFUL).
//
// Namco's original runs 0:03. This is three seconds exactly: twenty ticks at
// 100 BPM, which is the whole piece, tail included.
//
// ## What it is
//
// The one shape everybody remembers about a Battle City game over is that it
// **falls**. So this is a descent, and the descent is doubled: the lead walks
// down the A-minor scale from the fifth to the tonic while the bass walks the
// oldest lament progression there is under it — i, VII, VI, V — and then the
// two of them drop onto a low E and stop moving. Nothing resolves to the
// tonic; the piece ends on the dominant, which is why it sounds like the run
// was interrupted rather than finished.
//
// The pad enters only on the last chord, with a 400 ms attack, so the final
// note swells instead of decaying — the "somber, short tail" of §4, and the
// one place in the game where the sound is allowed to be slow.

import { piece, type MusicPiece, type Song } from '../sequencer';

export const gameoverSong: Song = {
  bpm: 100,
  ppq: 4,
  loopAtTick: 20,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'lead',
      steps: [
        [0, 76, 2, 1], // E5
        [2, 74, 2, 0.95], // D5
        [4, 72, 2, 0.9], // C5
        [6, 71, 2, 0.9], // B4
        [8, 69, 4, 0.95], // A4 — the tonic, but the bass has already left it
        [12, 64, 8, 0.8], // E4, held: the dominant, unresolved
      ],
    },
    {
      instrument: 'triBass',
      layer: 'bass',
      steps: [
        [0, 45, 4, 1], // A2   i
        [4, 43, 4, 1], // G2   VII
        [8, 41, 4, 1], // F2   VI
        [12, 40, 8, 1], // E2   V, and it stays there
      ],
    },
    {
      // Only on the last chord: A400 means it is still swelling when the pulse
      // lead has already begun to fade, so the piece ends by getting *wider*.
      instrument: 'pad',
      layer: 'pad',
      steps: [
        [12, 52, 8, 0.7], // E3
        [12, 56, 8, 0.6], // G#3 — the leading tone, so it never settles
        [12, 59, 8, 0.5], // B3
      ],
    },
  ],
};

export const gameover: MusicPiece = piece(gameoverSong, false);
