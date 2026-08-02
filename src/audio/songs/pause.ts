// src/audio/songs/pause.ts — the pause chirp (audio §4, §7 FAITHFUL).
//
// Two notes, high, fast, up. That is the whole thing, and it is the easiest of
// the faithful three to hit because it is the smallest target: an eighth of a
// second of two bright beeps a fourth apart is a pause chirp in any game that
// ever had one. Whether it is *Battle City's* pause chirp is **unverified** —
// see audio §7's honesty note and the T5.3 report.
//
// ## It is note data, and it plays on the SFX bus
//
// Audio §4 lists it in the music map, so the first cut played it through the
// sequencer onto the music bus, which made "music halts while paused" free: the
// chirp *replaced* the suite, so the sound and the silence after it were one
// action instead of two that could disagree.
//
// That was the wrong trade, and the orchestrator overruled it. **A pause chirp
// is UI feedback, not music.** A player who has pulled the music slider to zero
// still has to hear that their input registered — silence in answer to a button
// press reads as a dropped input, not as a muted soundtrack.
//
// So the notes stay here, in the music map's own format, and `audio.ts` plays
// them with `playPiece` straight into `graph.sfxBus`. Halting the music became
// its own line, which is what it should have been.

import { piece, type MusicPiece, type Song } from '../sequencer';

export const pauseSong: Song = {
  bpm: 240, // a tick is 62.5 ms — the chirp is two of them
  ppq: 4,
  loopAtTick: 8,
  tracks: [
    {
      instrument: 'pulse50',
      layer: 'ui',
      // Velocities cut on the measurement after the move to the SFX bus. The
      // same two notes came out 7.9 dB hotter there than on the trimmed music
      // bus (peak -7.73 dBFS against -15.65), which put a menu blip 6 dB over
      // a brick hit. A UI cue has to be unmissable, not startling.
      steps: [
        [0, 88, 1, 0.5], // E6
        [1, 93, 2, 0.55], // A6
      ],
    },
  ],
};

/**
 * Deliberately **not** in `audio.ts`'s `MUSIC` registry. Everything in that map
 * is played by `playMusic`, and `playMusic` routes to the music bus — so the
 * mistake this file exists to describe should not be spellable.
 */
export const pauseChirp: MusicPiece = piece(pauseSong, false);
