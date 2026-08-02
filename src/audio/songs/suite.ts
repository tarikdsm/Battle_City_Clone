// src/audio/songs/suite.ts — the adaptive gameplay suite (audio §4).
//
// **The NES had no in-game music.** Only the engine hum. So this piece cannot
// be "the Battle City gameplay theme" — there isn't one — and §4 says what it
// has to be instead: one continuous piece whose bottom layer is "a musicalized
// descendant of the NES engine hum", with everything else layering on top as
// the battle gets worse.
//
// ## L0 is the hum, literally
//
// The ostinato sits on **A2, 110 Hz — the exact pitch the engine hum sits on**
// (`ENGINE.rootMidi` in `sfx.ts`), and it alternates **A2 ↔ A♯2, a semitone**,
// which is the exact interval the hum alternates. It is the hum slowed from
// 8 Hz to eighth notes and given a bass instrument. When a tank is moving the
// two are the same note; the layer and the sound effect fuse, which is the
// whole idea in §4's "a musicalized descendant".
//
// That semitone is also the key's ♭2, so L0 is Phrygian on A: the darkest of
// the minor modes, and the reason the bed sounds like a threat rather than a
// groove. Everything above it is built to agree with that.
//
// ## The layers, and what turns them on
//
// | layer | content | active when (audio §4) |
// |---|---|---|
// | L0 | triBass 8th-note two-note ostinato | always |
// | L1 | kick + hat, sparse | after 2 bars |
// | L2 | pulse25 16th arpeggios | ≥ 3 enemies on field |
// | L3 | pulse50 lead, quoting the fanfare motif | ≤ 5 enemies left to destroy |
// | L4 | minor-2nd pad swells + toms + a tenser lead | base breached, eagle gone, or last life |
//
// The thresholds live in `audio.ts` (`musicLayerTargets`), not here: this file
// is note data, and note data does not read `GameState`.
//
// L3 and L4 both carry a lead, and §4 says L4's "overrides L3's lead with a
// tenser variation" — that is one line in the intensity function (L4 on ⇒ L3
// target 0), not two pieces of music fighting over the same octave.

import {
  TICKS_PER_BAR,
  merge,
  ostinato,
  piece,
  repeat,
  type MusicPiece,
  type Song,
  type SongStep,
} from '../sequencer';

/** Audio §4's five layers. */
export type SuiteLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/** The five layer names, in the order §4 lists them. */
export const SUITE_LAYERS: readonly SuiteLayer[] = Object.freeze([
  'L0',
  'L1',
  'L2',
  'L3',
  'L4',
]);

const BAR = TICKS_PER_BAR;
/** Eight bars — 128 ticks, about 16.5 s at 116 BPM. */
const LOOP = 8 * BAR;

// --- L0: the hum ------------------------------------------------------------
// A2/A♯2 for six bars, then G2/G♯2 for two, so the bed moves once per loop and
// the ear does not stop hearing it.
const L0: SongStep[] = merge(
  ostinato(0, 6 * BAR, 2, [45, 46], 2, 0.8),
  ostinato(6 * BAR, LOOP, 2, [43, 44], 2, 0.8),
);

// --- L1: the groove ---------------------------------------------------------
const L1_KICK: SongStep[] = merge(
  repeat(
    [
      [0, 36, 1, 1],
      [8, 36, 1, 0.8],
    ],
    8,
    BAR,
  ),
  // A pickup into bars 5 and 1, so the eight bars have a seam you can feel.
  [
    [62, 36, 1, 0.75],
    [126, 36, 1, 0.75],
  ],
);

const L1_HAT: SongStep[] = merge(
  // Offbeat eighths, quiet. A step longer than one tick is how the format asks
  // for audio §3's open hat (D120); everything here is closed except the two
  // that mark the seam.
  ostinato(2, LOOP, 4, [42], 1, 0.35),
  [
    [58, 42, 2, 0.5],
    [122, 42, 2, 0.5],
  ],
);

// --- L2: the arps -----------------------------------------------------------
// One eight-note cell per chord, repeated across the bars that chord owns.
// Am for four bars, F for two, G for two — the same harmony L3 sings over.
const L2: SongStep[] = merge(
  ostinato(0, 4 * BAR, 1, [69, 72, 76, 81, 84, 81, 76, 72], 1, 0.45),
  ostinato(4 * BAR, 6 * BAR, 1, [65, 69, 72, 77, 81, 77, 72, 69], 1, 0.45),
  ostinato(6 * BAR, LOOP, 1, [67, 71, 74, 79, 83, 79, 74, 71], 1, 0.45),
);

// --- L3: the lead -----------------------------------------------------------
// Bar 1 is `FANFARE_MOTIF` with the major third flattened — the stage jingle,
// minorised, which is how the suite quotes it without repeating it.
const L3: SongStep[] = [
  [0, 69, 2, 0.9],
  [2, 72, 2, 0.9],
  [4, 76, 2, 0.9],
  [6, 81, 4, 1],
  [12, 79, 2, 0.85],
  [14, 76, 2, 0.85],
  [16, 72, 4, 0.85],
  [20, 76, 4, 0.85],
  [24, 74, 6, 0.8],

  [32, 69, 2, 0.9],
  [34, 72, 2, 0.9],
  [36, 76, 2, 0.9],
  [38, 84, 4, 1],
  [44, 83, 2, 0.9],
  [46, 81, 2, 0.9],
  [48, 76, 4, 0.85],
  [52, 72, 4, 0.85],
  [56, 69, 8, 0.8],

  [64, 77, 2, 0.9],
  [66, 81, 2, 0.9],
  [68, 84, 4, 1],
  [72, 81, 4, 0.9],
  [76, 77, 4, 0.85],
  [80, 72, 8, 0.8],
  [88, 74, 8, 0.8],

  [96, 79, 2, 0.9],
  [98, 83, 2, 0.9],
  [100, 86, 4, 1],
  [104, 83, 4, 0.9],
  [108, 79, 4, 0.85],
  [112, 76, 4, 0.85],
  [116, 74, 4, 0.8],
  [120, 71, 8, 0.8],
];

// --- L4: danger -------------------------------------------------------------
// §4: "minor-2nd pad swells + toms". The pad holds A3 and A♯3 **together** —
// the same semitone L0 alternates, but sounded at once instead of in turn, so
// the bed's interval turns into a grinding cluster the moment the base is in
// danger.
const L4_PAD: SongStep[] = repeat(
  [
    [0, 57, 28, 0.65],
    [0, 58, 28, 0.55],
  ],
  4,
  2 * BAR,
);

const L4_TOMS: SongStep[] = repeat(
  [
    [28, 40, 1, 0.9],
    [30, 38, 1, 0.85],
  ],
  4,
  2 * BAR,
);

/**
 * The tenser lead. Not a transposition of L3 — it is a different, tighter idea
 * that circles the ♭2 instead of the fifth, so switching to it reads as the
 * music refusing to go anywhere rather than as the same tune moved.
 */
const L4_LEAD: SongStep[] = repeat(
  [
    [0, 69, 2, 0.95],
    [2, 70, 2, 0.95],
    [4, 69, 2, 0.9],
    [6, 65, 4, 0.9],
    [12, 70, 2, 0.9],
    [14, 69, 2, 0.9],
    [16, 76, 4, 1],
    [20, 77, 4, 0.95],
    [24, 76, 4, 0.9],
    [28, 70, 4, 0.9],
  ],
  4,
  2 * BAR,
);

export const suiteSong: Song = {
  bpm: 116,
  ppq: 4,
  loopAtTick: LOOP,
  tracks: [
    { instrument: 'triBass', layer: 'L0', steps: L0 },
    { instrument: 'kick', layer: 'L1', steps: L1_KICK },
    { instrument: 'hat', layer: 'L1', steps: L1_HAT },
    { instrument: 'pulse25', layer: 'L2', steps: L2 },
    { instrument: 'pulse50', layer: 'L3', steps: L3 },
    { instrument: 'pad', layer: 'L4', steps: L4_PAD },
    { instrument: 'triBass', layer: 'L4', steps: L4_TOMS },
    { instrument: 'pulse50', layer: 'L4', steps: L4_LEAD },
  ],
};

export const suite: MusicPiece = piece(suiteSong, true);
