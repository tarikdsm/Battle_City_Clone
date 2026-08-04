// tests/audio/suite.test.ts — the music map and the adaptive suite (T5.3),
// audio §4 and §7.
//
// Two different kinds of claim get tested here, and only one of them is about
// sound.
//
// **The intensity logic is a claim about the game.** "The arps mean three tanks
// are hunting you" and "the danger pad means your base is open" are statements
// a player will learn to trust, and every threshold in §4's table is pinned
// here against a real `GameState` driven to the boundary. A layer that fires
// one enemy early is a layer that lies.
//
// **The songs are a claim about the format.** That each piece parses, loops
// where it says it loops, is the length §4 gives it, and only ever names
// instruments the §3 registry actually has — the last one matters because a
// typo in a track's `instrument` is a track that silently plays nothing.
//
// Whether the faithful three are *recognisable* is not testable here and is not
// attempted. That is `scripts/capture-audio.ts`'s rendered WAVs and §7's
// two-second review criterion, and it is judged by ear.

import { describe, expect, it } from 'vitest';

import {
  CLOCK_FILTER,
  MUSIC,
  PAUSE_CHIRP,
  SUITE_L1_BARS,
  SUITE_L2_ENEMIES_ON_FIELD,
  SUITE_L3_ENEMIES_LEFT,
  baseBreached,
  createAudio,
  enemiesOnField,
  enemiesRemaining,
  musicLayerTargets,
  onLastLife,
  type MusicId,
} from '../../src/audio/audio';
import {
  TICKS_PER_BAR,
  secondsPerTick,
  songDurationS,
  type Song,
} from '../../src/audio/sequencer';
import { FANFARE_MOTIF } from '../../src/audio/songs/fanfare';
import { SUITE_LAYERS, suiteSong } from '../../src/audio/songs/suite';
import { PATCH_IDS } from '../../src/audio/synth';
import { BASE_RING_TILES } from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import { subcellIndex } from '../../src/core/grid';
import { Terrain, type GameState, type LevelData } from '../../src/core/types';

import {
  FakeAudioContext,
  asAudioContext,
  fakeFilter,
  fakeGain,
} from './fakeContext';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

const MUSIC_IDS: readonly MusicId[] = [
  'title',
  'fanfare',
  'suite',
  'tally',
  'gameover',
  'hiscore',
];

function game(players: 1 | 2 = 1): GameState {
  return createGame(OPEN, { players, seed: 1, stageNumber: 1 });
}

/** Puts exactly `n` enemies on the board, and `queued` still to come. */
function field(state: GameState, n: number, queued: number): void {
  let live = 0;
  for (const tank of state.tanks) {
    if (tank.kind !== 'enemy') {
      continue;
    }
    tank.alive = live < n;
    if (tank.alive) {
      live++;
    }
  }
  while (live < n) {
    state.tanks.push({
      ...state.tanks[0],
      id: 100 + live,
      kind: 'enemy',
      playerIndex: undefined,
      enemyType: 'basic',
      alive: true,
    });
    live++;
  }
  state.spawner.queue.length = 0;
  for (let i = 0; i < queued; i++) {
    state.spawner.queue.push('basic');
  }
}

/** Knocks one subcell out of the base ring — one shot through one corner. */
function breach(state: GameState): void {
  const [tx, ty] = BASE_RING_TILES[0];
  state.terrain[subcellIndex(tx * 2, ty * 2)] = Terrain.Empty;
}

describe('the music map (audio §4)', () => {
  it('registers every piece the map names', () => {
    expect(Object.keys(MUSIC).sort()).toEqual([...MUSIC_IDS].sort());
  });

  it('only ever names instruments the §3 registry has', () => {
    // A typo in a track's `instrument` is a track that silently plays nothing,
    // and nothing else in the project would notice.
    for (const piece of [...MUSIC_IDS.map((id) => MUSIC[id]), PAUSE_CHIRP]) {
      for (const track of piece.song.tracks) {
        expect(PATCH_IDS, track.layer).toContain(track.instrument);
      }
    }
  });

  it('keeps the pause chirp OUT of the music map', () => {
    // Everything in `MUSIC` is played by `playMusic`, and `playMusic` routes to
    // the music bus. The chirp has to survive a muted music slider, so the way
    // it is kept off that bus is by not being spellable as music at all.
    expect(Object.keys(MUSIC)).not.toContain('pause');
    expect(PAUSE_CHIRP.loops).toBe(false);
    expect(PAUSE_CHIRP.durationS).toBeLessThan(0.3);
  });

  it('uses audio §2s ppq and keeps every step inside its own loop', () => {
    for (const id of MUSIC_IDS) {
      const song: Song = MUSIC[id].song;
      expect(song.ppq, id).toBe(4);
      expect(song.loopAtTick, id).toBeGreaterThan(0);
      for (const track of song.tracks) {
        for (const step of track.steps) {
          // A note that starts at or past the loop point never sounds.
          expect(step[0], `${id}/${track.layer}`).toBeLessThan(song.loopAtTick);
          expect(step[0]).toBeGreaterThanOrEqual(0);
          expect(step[2]).toBeGreaterThan(0);
          expect(step[3]).toBeGreaterThan(0);
          expect(step[3]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('marks the loops as loops and the one-shots as one-shots', () => {
    expect(MUSIC.suite.loops).toBe(true);
    expect(MUSIC.title.loops).toBe(true);
    expect(MUSIC.hiscore.loops).toBe(true);
    for (const id of ['fanfare', 'tally', 'gameover'] as const) {
      expect(MUSIC[id].loops, id).toBe(false);
    }
  });

  it('gives the faithful three the lengths audio §4 and the original imply', () => {
    // §4: the fanfare "ends on downbeat of Layer 0", and fidelity §11.1's
    // curtain is exactly 2 s — so the fanfare is exactly one bar at 120 BPM.
    expect(MUSIC.fanfare.durationS).toBeCloseTo(2.0, 6);
    // Namco's original game-over runs 0:03.
    expect(MUSIC.gameover.durationS).toBeCloseTo(3.0, 6);
    // A chirp is a chirp: two notes and out.
    expect(PAUSE_CHIRP.durationS).toBeLessThan(0.3);
    // §4: "Stage clear / tally … 6 s".
    expect(MUSIC.tally.durationS).toBeCloseTo(6.0, 6);
  });

  it('composes the title theme at §4s tempo, key and 32-bar length', () => {
    expect(MUSIC.title.song.bpm).toBe(92);
    expect(MUSIC.title.song.loopAtTick).toBe(32 * TICKS_PER_BAR);
    // "pulse lead over pad + triBass" — those three and nothing else.
    expect(MUSIC.title.song.tracks.map((t) => t.instrument).sort()).toEqual([
      'pad',
      'pulse50',
      'triBass',
    ]);
  });

  it('quotes the fanfare motif literally, in all three places', () => {
    // §4: the title theme "quotes stage-fanfare motif", and the suite's L3
    // lead does the same. Since the fanfare rewrite put the cue in the mode
    // the rest of the score already lived in, the quote is exact rather than
    // exact-after-flattening-a-third.
    const motif = [...FANFARE_MOTIF];

    // The fanfare states it one note per beat, in a dotted 3+1 figure, so the
    // quote lives on the strong beats and the off-sixteenths decorate it.
    const fan = MUSIC.fanfare.song.tracks.find((t) => t.layer === 'lead');
    const beats = [0, 4, 8, 12].map(
      (tick) => fan?.steps.find((s) => s[0] === tick)?.[1],
    );
    expect(beats).toEqual(motif);

    const lead = MUSIC.title.song.tracks.find((t) => t.layer === 'lead');
    expect(lead?.steps.slice(0, 4).map((s) => s[1])).toEqual(motif);

    const l3 = suiteSong.tracks.find((t) => t.layer === 'L3');
    expect(l3?.steps.slice(0, 4).map((s) => s[1])).toEqual(motif);
  });

  it('hands the fanfare off to L0 on the same two bass notes', () => {
    // The seam this whole cue is built around: the fanfare's last two bass
    // notes are L0's two notes, in order, and the final one is still ringing
    // when L0 starts alternating them.
    const bass = MUSIC.fanfare.song.tracks.find((t) => t.layer === 'bass');
    const tail = bass?.steps.slice(-2).map((s) => s[1]);
    const l0 = suiteSong.tracks.find((t) => t.layer === 'L0');
    expect(tail).toEqual([l0?.steps[1][1], l0?.steps[0][1]]);
    expect(tail).toEqual([46, 45]); // A♯2 then A2

    // …and it lands exactly on L0's downbeat, so there is no gap to cover.
    expect(MUSIC.fanfare.durationS).toBeCloseTo(2.0, 6);
  });
});

describe('the suite (audio §4)', () => {
  it('carries all five layers, and L0 runs unbroken', () => {
    const layers = new Set(suiteSong.tracks.map((t) => t.layer));
    expect([...layers].sort()).toEqual([...SUITE_LAYERS].sort());

    const l0 = suiteSong.tracks.find((t) => t.layer === 'L0');
    const spt = secondsPerTick(suiteSong.bpm);
    // §4: "triBass 8th-note two-note ostinato … always". Eighth notes at
    // ppq 4 are two ticks apart, and there is one on every single one of them.
    expect(l0?.steps.length).toBe(suiteSong.loopAtTick / 2);
    for (let i = 0; i < (l0?.steps.length ?? 0); i++) {
      expect(l0?.steps[i][0]).toBe(i * 2);
    }
    expect(spt * 2).toBeGreaterThan(0);
  });

  it('makes L0 the engine hum: the same pitch, the same semitone', () => {
    // The claim §4 makes with "a musicalized descendant of the NES engine
    // hum", checked rather than asserted in a comment: L0's ostinato sits on
    // the hum's own root and alternates the hum's own interval.
    const l0 = suiteSong.tracks.find((t) => t.layer === 'L0');
    const first = l0?.steps[0][1] ?? 0;
    const second = l0?.steps[1][1] ?? 0;
    expect(first).toBe(45); // A2 — ENGINE.rootMidi
    expect(second - first).toBe(1); // a semitone — ENGINE.alternateCents
  });

  it('holds a minor second in the danger pad', () => {
    // §4: "minor-2nd pad swells". Two pad notes a semitone apart, together.
    const pad = suiteSong.tracks.find(
      (t) => t.layer === 'L4' && t.instrument === 'pad',
    );
    const first = pad?.steps.filter((s) => s[0] === 0).map((s) => s[1]) ?? [];
    expect(first).toHaveLength(2);
    expect(Math.abs(first[1] - first[0])).toBe(1);
  });
});

describe('layer targets from state (audio §4)', () => {
  it('keeps L0 on from the first tick and brings L1 in after two bars', () => {
    const state = game();
    expect(musicLayerTargets(state, 0).layers.L0).toBe(1);
    expect(musicLayerTargets(state, 0).layers.L1).toBe(0);
    expect(musicLayerTargets(state, SUITE_L1_BARS - 0.01).layers.L1).toBe(0);
    expect(musicLayerTargets(state, SUITE_L1_BARS).layers.L1).toBe(1);
  });

  it('opens L2 at three enemies on the field, not two', () => {
    const state = game();
    field(state, SUITE_L2_ENEMIES_ON_FIELD - 1, 10);
    expect(enemiesOnField(state)).toBe(2);
    expect(musicLayerTargets(state, 8).layers.L2).toBe(0);

    field(state, SUITE_L2_ENEMIES_ON_FIELD, 10);
    expect(enemiesOnField(state)).toBe(3);
    expect(musicLayerTargets(state, 8).layers.L2).toBe(1);
  });

  it('opens L3 at five enemies left to destroy, queue included', () => {
    const state = game();
    // Six left: four on the field and two queued. Not yet.
    field(state, 4, 2);
    expect(enemiesRemaining(state)).toBe(SUITE_L3_ENEMIES_LEFT + 1);
    expect(musicLayerTargets(state, 8).layers.L3).toBe(0);

    field(state, 4, 1);
    expect(enemiesRemaining(state)).toBe(SUITE_L3_ENEMIES_LEFT);
    expect(musicLayerTargets(state, 8).layers.L3).toBe(1);
  });

  it('opens L4 when one subcell of the base ring is gone', () => {
    const state = game();
    expect(baseBreached(state)).toBe(false);
    expect(musicLayerTargets(state, 8).layers.L4).toBe(0);

    breach(state);
    expect(baseBreached(state)).toBe(true);
    expect(musicLayerTargets(state, 8).layers.L4).toBe(1);
  });

  it('opens L4 when the eagle is gone or the player is on their last life', () => {
    const dead = game();
    dead.eagleAlive = false;
    expect(musicLayerTargets(dead, 8).layers.L4).toBe(1);

    const last = game();
    last.players[0].lives = 0;
    expect(onLastLife(last)).toBe(true);
    expect(musicLayerTargets(last, 8).layers.L4).toBe(1);
    // An inactive second player's zero lives is not a danger cue.
    const solo = game();
    expect(solo.players[1].active).toBe(false);
    expect(onLastLife(solo)).toBe(false);
  });

  it('lets L4 override L3s lead rather than sound alongside it', () => {
    // §4: "L4 overrides L3's lead with a tenser variation". Both conditions
    // true at once has to give exactly one lead, not two.
    const state = game();
    field(state, 2, 1);
    expect(enemiesRemaining(state)).toBeLessThanOrEqual(SUITE_L3_ENEMIES_LEFT);
    expect(musicLayerTargets(state, 8).layers.L3).toBe(1);

    breach(state);
    const targets = musicLayerTargets(state, 8);
    expect(targets.layers.L4).toBe(1);
    expect(targets.layers.L3).toBe(0);
  });

  it('raises the clock filter for the freeze and drops it after', () => {
    const state = game();
    expect(musicLayerTargets(state, 8).clockFilter).toBe(false);
    state.clockT = 10;
    expect(musicLayerTargets(state, 8).clockFilter).toBe(true);
    state.clockT = 0;
    expect(musicLayerTargets(state, 8).clockFilter).toBe(false);
  });
});

describe('the music driver', () => {
  function rig(): {
    fake: FakeAudioContext;
    audio: ReturnType<typeof createAudio>;
  } {
    // prettier-ignore
    const fake = new FakeAudioContext();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: null,
    });
    audio.resume();
    return { fake, audio };
  }

  /** Runs `seconds` of frames at 60 Hz, advancing both clocks together. */
  function run(
    fake: FakeAudioContext,
    audio: ReturnType<typeof createAudio>,
    state: GameState,
    seconds: number,
  ): void {
    const step = 1 / 60;
    for (let t = 0; t < seconds; t += step) {
      fake.advance(step);
      audio.update(state, step * 1000);
    }
  }

  it('follows the stage phase: fanfare, suite, tally, game over', () => {
    const { fake, audio } = rig();
    const state = game();

    state.phase = 'intro';
    audio.update(state, 16);
    expect(audio.stats().music).toBe('fanfare');

    // The fanfare is a one-shot and stops itself when it has run its length —
    // no timer, because the audio clock is the only clock that matters.
    run(fake, audio, state, MUSIC.fanfare.durationS + 0.2);
    expect(audio.stats().music).toBeNull();

    state.phase = 'playing';
    audio.update(state, 16);
    expect(audio.stats().music).toBe('suite');

    state.phase = 'cleared';
    audio.update(state, 16);
    expect(audio.stats().music).toBe('tally');

    state.phase = 'gameOver';
    audio.update(state, 16);
    expect(audio.stats().music).toBe('gameover');
    audio.dispose();
  });

  it('chirps on pause, halts the music, and brings the suite back', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    audio.update(state, 16);
    expect(audio.stats().music).toBe('suite');

    const before = fake.nodes('oscillator').length;

    state.paused = true;
    audio.update(state, 16);
    // Two things, not one: the chirp answers the button, and the music halts.
    expect(fake.nodes('oscillator').length).toBe(before + 2);
    expect(audio.stats().music).toBeNull();

    run(fake, audio, state, 0.5);
    expect(audio.stats().music).toBeNull();

    state.paused = false;
    audio.update(state, 16);
    // …and it answers the button on the way out too, because a press that
    // makes no sound reads as a press that was dropped.
    expect(fake.nodes('oscillator').length).toBeGreaterThan(before + 2);
    expect(audio.stats().music).toBe('suite');
    audio.dispose();
  });

  it('chirps on the SFX bus, so a muted music slider still answers the button', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    // The player has pulled the music slider to zero and kept the SFX.
    audio.setVolumes({ music: 0, sfx: 0.8 });
    audio.update(state, 16);
    const graph = audio.graph;
    if (graph === null) {
      throw new Error('expected a graph');
    }
    const before = fake.nodes('oscillator').length;

    state.paused = true;
    audio.update(state, 16);

    const fresh = fake.nodes('oscillator').slice(before);
    expect(fresh).toHaveLength(2); // E6 and A6
    for (const osc of fresh) {
      // On the SFX bus, which is at 0.8 …
      expect(fake.reaches(osc, fakeGain(graph.sfxBus))).toBe(true);
      // … and nowhere near the music bus, which is at 0.
      expect(fake.reaches(osc, fakeGain(graph.musicBus))).toBe(false);
    }
    expect(fakeGain(graph.sfxBus).gain.value).toBeCloseTo(0.8, 9);
    expect(fakeGain(graph.musicBus).gain.value).toBe(0);
    audio.dispose();
  });

  it('does not restart L1s two-bar wait every time the player pauses', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    audio.update(state, 16);
    const barS = TICKS_PER_BAR * secondsPerTick(suiteSong.bpm);
    run(fake, audio, state, barS * (SUITE_L1_BARS + 0.2));
    expect(audio.stats().layers.L1).toBe(1);

    state.paused = true;
    run(fake, audio, state, 1);
    state.paused = false;
    audio.update(state, 16);
    run(fake, audio, state, 0.2);
    // The groove is still in: the suite's elapsed time survives the pause.
    expect(audio.stats().layers.L1).toBe(1);
    audio.dispose();
  });

  it('drives the layer gains from the state as the battle turns', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    field(state, 0, 20);
    audio.update(state, 16);
    expect(audio.stats().layers).toEqual({ L0: 1, L1: 0, L2: 0, L3: 0, L4: 0 });

    field(state, 4, 12);
    run(fake, audio, state, 5);
    expect(audio.stats().layers.L1).toBe(1);
    expect(audio.stats().layers.L2).toBe(1);
    expect(audio.stats().layers.L3).toBe(0);

    field(state, 3, 0);
    run(fake, audio, state, 0.5);
    expect(audio.stats().layers.L3).toBe(1);

    breach(state);
    run(fake, audio, state, 0.5);
    expect(audio.stats().layers.L4).toBe(1);
    expect(audio.stats().layers.L3).toBe(0);
    audio.dispose();
  });

  it('ramps a layer over 250 ms rather than switching it', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    field(state, 4, 12);
    audio.update(state, 16);
    const node = audio.sequencer?.layerNode('L2');
    if (node === null || node === undefined) {
      throw new Error('expected an L2 layer node');
    }
    // The layer opened on that first update, at the clock's `currentTime`, and
    // the ramp lands audio §2's 250 ms later. A layer that switched instead of
    // ramping would land it at the same instant.
    const ramp = fakeGain(node).gain.last('linear');
    expect(ramp?.value).toBe(1);
    expect(ramp?.time).toBeCloseTo(fake.currentTime + 0.25, 9);

    // …and it is scheduled once, not once per frame: sixty ramps a second is a
    // ramp that never arrives.
    const scheduled = fakeGain(node).gain.ops('linear').length;
    run(fake, audio, state, 1);
    expect(fakeGain(node).gain.ops('linear').length).toBe(scheduled);
    audio.dispose();
  });

  it('sweeps the music bus to 400 Hz while the clock is frozen', () => {
    const { fake, audio } = rig();
    const state = game();
    state.phase = 'playing';
    audio.update(state, 16);
    const graph = audio.graph;
    if (graph === null) {
      throw new Error('expected a graph');
    }

    state.clockT = 10;
    audio.update(state, 16);
    const down = fakeFilter(graph.musicFilter).frequency.last('exp');
    expect(down?.value).toBeCloseTo(CLOCK_FILTER.hz, 6);
    expect(down?.time).toBeCloseTo(
      fake.currentTime + CLOCK_FILTER.sweepMs / 1000,
      9,
    );
    // §6: "clockFreeze → music lowpassed (no gain duck)".
    expect(fakeGain(graph.musicDuck).gain.events).toHaveLength(0);

    // …and it opens again on its own when the freeze runs out, because the
    // filter follows `clockT` rather than an event that may never arrive.
    state.clockT = 0;
    run(fake, audio, state, 0.1);
    expect(fakeFilter(graph.musicFilter).frequency.last('exp')?.value).toBe(
      CLOCK_FILTER.openHz,
    );
    audio.dispose();
  });

  it('keeps the music silent on a muted bus while SFX still play', () => {
    const { audio } = rig();
    const state = game();
    state.phase = 'playing';
    audio.setVolumes({ music: 0, sfx: 0.8 });
    audio.update(state, 16);
    const graph = audio.graph;
    if (graph === null) {
      throw new Error('expected a graph');
    }
    expect(fakeGain(graph.musicBus).gain.value).toBe(0);
    expect(fakeGain(graph.sfxBus).gain.value).toBeCloseTo(0.8, 9);

    // The sequencer is still running — muting is a mix decision, not a stop —
    // and the SFX path is untouched by it.
    expect(audio.stats().music).toBe('suite');
    const before = audio.stats().oneShots;
    audio.onEvent({ t: 'brickHit', tx: 1, ty: 1, removedMask: 3, x: 16, y: 16, dir: 0 }); // prettier-ignore
    expect(audio.stats().oneShots).toBeGreaterThan(before);
    audio.dispose();
  });

  it('schedules no music at all while the context is suspended', () => {
    const fake = new FakeAudioContext();
    const audio = createAudio({
      createContext: () => asAudioContext(fake),
      blurTarget: null,
    });
    const state = game();
    state.phase = 'playing';
    audio.update(state, 16);
    audio.playMusic('suite');
    expect(audio.stats().music).toBeNull();

    audio.resume();
    audio.update(state, 16);
    expect(audio.stats().music).toBe('suite');
    audio.dispose();
  });
});

describe('songDurationS', () => {
  it('measures to the end of the last note, not to the loop point', () => {
    const song: Song = {
      bpm: 120,
      ppq: 4,
      loopAtTick: 64,
      tracks: [
        { instrument: 'pulse50', layer: 'a', steps: [[0, 60, 4, 1]] },
        { instrument: 'triBass', layer: 'b', steps: [[8, 48, 2, 1]] },
      ],
    };
    expect(songDurationS(song)).toBeCloseTo(10 * secondsPerTick(120), 9);
  });
});
