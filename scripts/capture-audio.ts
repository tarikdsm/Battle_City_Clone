// scripts/capture-audio.ts — the AUDIBLE-verification harness for audio §5.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:audio
//
// Committed output: `docs/calibration/audio.json`. The WAVs themselves
// (git-ignored, like the capture screenshots) go to `.superpowers/sdd/audio-T5/`
// unless CAPTURE_OUT says otherwise. **Listen to them.** Every automated
// assertion in `tests/audio/` checks that the engine was asked to make a
// sound; only these files answer whether it made the right one.
//
// ## Why a browser
//
// Node has no Web Audio at all, so there is no offline DSP to render against —
// and the project may not add a runtime dependency to get one. Chromium has a
// spec-complete `OfflineAudioContext`, and Playwright is already a dev
// dependency, so the harness drives **the shipped modules** (`createAudioGraph`,
// `createSfxPlayer`) through real DSP and pulls the samples back. That is the
// same trick `capture-fx.ts` uses to photograph a real renderer.
//
// Headless on purpose, unlike the visual harnesses: those are headed because
// Playwright's headless Chromium rasterises through SwiftShader, and a software
// rasteriser is not the machine anybody plays on. `OfflineAudioContext` has no
// such problem — it is the same double-precision graph either way, and it runs
// faster than real time.
//
// ## What the numbers are for
//
// Peak, RMS, duration and spectral centroid per sound, plus a measured duck
// depth. They are a regression net rather than a target: a patch that silently
// becomes a click, a DC thump or nothing at all moves them, and a ducking
// matrix that stops firing moves `duck.measuredDb` to zero. The verdict block
// makes the artifact carry its own pass/fail so this can never be "green" in a
// log nobody read.

import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT = process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'audio-T5');
const ARTIFACT = join('docs', 'calibration', 'audio.json');

/** 48 kHz: what every desktop browser runs at, so the render is the mix. */
const SAMPLE_RATE = 48000;

/**
 * esbuild's `keepNames` rewrites every named function as `__name(fn, "name")`
 * and defines `__name` once per MODULE; Playwright serialises the function body
 * alone, so the helper is missing in the page. Same shim the other harnesses
 * install (see `capture-fx.ts`).
 */
const KEEP_NAMES_SHIM = 'globalThis.__name ??= (fn) => fn;';

/** Below this a clip is silence, not a sound. */
const SILENCE_DBFS = -60;
/** Audio §6's ceiling is −1 dBTP; anything at 0 dBFS has clipped. */
const CLIP_DBFS = -0.1;
/** How far the measured duck may sit from audio §6's −12 dB. */
const DUCK_TOLERANCE_DB = 2;

interface Clip {
  name: string;
  seconds: number;
  /** What this clip is for, carried into the artifact so it reads alone. */
  note: string;
}

/**
 * The six the T5.1 brief names, plus the ones that answer a question the six
 * cannot: the two engine states side by side, the duck measured on its own,
 * and a scripted skirmish that is the only clip where the *mix* is audible.
 */
const CLIPS: readonly Clip[] = [
  { name: 'engine-idle', seconds: 2.0, note: 'audio §5 engineIdle: pulse12 alternating a semitone at 8 Hz, stationary player' }, // prettier-ignore
  { name: 'engine-move', seconds: 2.0, note: 'audio §5 engineMove: the same hum at full speed, +3 semitones' }, // prettier-ignore
  { name: 'helmet-loop', seconds: 2.0, note: 'audio §5 helmetLoop: the shield hum over the engine hum, as it is heard in game' }, // prettier-ignore
  { name: 'player-shot', seconds: 0.6, note: 'audio §5 playerShot: pulse blip 880→440 Hz over 40 ms + noise tick' }, // prettier-ignore
  { name: 'enemy-shot', seconds: 0.6, note: 'audio §5 enemyShot: the same −6 dB, 660→330' }, // prettier-ignore
  { name: 'brick-hit', seconds: 0.8, note: 'audio §5 brickHit: noise burst bandpassed at 800 Hz + low crunch' }, // prettier-ignore
  { name: 'steel-break', seconds: 1.2, note: 'audio §5 steelBreak: clink + metal shard shimmer' }, // prettier-ignore
  { name: 'tank-explode', seconds: 1.4, note: 'audio §5 tankExplode: noise boom + 90→40 Hz sub drop + debris' }, // prettier-ignore
  { name: 'base-explode', seconds: 3.0, note: 'audio §5 baseExplode over a music tone, so the −12 dB duck is audible' }, // prettier-ignore
  { name: 'powerup-pickup', seconds: 1.4, note: 'audio §5 powerupPickup: major-triad bell arp + shimmer tail' }, // prettier-ignore
  { name: 'extra-life', seconds: 1.6, note: 'audio §5 extraLife: the rising jingle' }, // prettier-ignore
  { name: 'duck-probe', seconds: 3.0, note: 'a steady music tone with the baseExplode duck fired at 0.8 s and NO boom — the duck depth, measurable' }, // prettier-ignore
  { name: 'stun-buzz', seconds: 1.2, note: 'audio 5 stunBuzz: the wobble buzz and its comedic spring - the row the T5.1 report was least sure of' }, // prettier-ignore
  { name: 'skirmish', seconds: 6.0, note: 'a scripted 6 s of play over the engine hum: the only clip where the mix is audible' }, // prettier-ignore

  // --- T5.3: the music map (audio 4) and the faithfulness ledger (7) ------
  { name: 'music-fanfare', seconds: 3.0, note: 'audio 7 FAITHFUL: the stage-intro fanfare. One bar at 120 BPM = 2.000 s, ending on the downbeat of the suite; the tail rings past it' }, // prettier-ignore
  { name: 'music-gameover', seconds: 4.5, note: 'audio 7 FAITHFUL: the game-over motif. A doubled descent over i-VII-VI-V that stops on the dominant, unresolved' }, // prettier-ignore
  { name: 'pause-chirp', seconds: 1.0, note: 'audio 7 FAITHFUL: the two-note pause chirp, E6 to A6 - on the SFX bus, so a muted music slider still answers the button' }, // prettier-ignore
  { name: 'music-title', seconds: 12.0, note: 'audio 4 NEW: the title theme, first eight bars. Opens on the fanfare motif with the third flattened' }, // prettier-ignore
  { name: 'music-tally', seconds: 7.0, note: 'audio 4 NEW: the stage-clear jingle. F-G-C climbing, the game-over descent answered' }, // prettier-ignore
  { name: 'music-hiscore', seconds: 8.0, note: 'audio 4 NEW: the high-score bell loop, first four bars' }, // prettier-ignore

  // The suite at each intensity level 4 defines, over the same eight bars
  // every time, so the clips are directly comparable by ear.
  { name: 'suite-L0', seconds: 8.0, note: 'audio 4 L0 alone: the hum-ostinato on A2, the engine hum musicalised' }, // prettier-ignore
  { name: 'suite-L01', seconds: 8.0, note: 'audio 4 L0+L1: the groove enters after 2 bars' }, // prettier-ignore
  { name: 'suite-L012', seconds: 8.0, note: 'audio 4 L0-L2: 4 enemies on the field brings the arps in' }, // prettier-ignore
  { name: 'suite-L0123', seconds: 8.0, note: 'audio 4 L0-L3: 3 enemies left brings the lead in' }, // prettier-ignore
  { name: 'suite-L4', seconds: 8.0, note: 'audio 4 L4: the base is breached - the minor-2nd pad and the tenser lead replace L3' }, // prettier-ignore
  { name: 'suite-clock', seconds: 6.0, note: 'audio 4: a Clock freeze at 1.5 s sweeps the whole music bus to 400 Hz. No gain duck' }, // prettier-ignore
];

interface Metrics {
  durationS: number;
  peakDbfs: number;
  rmsDbfs: number;
  centroidHz: number;
  /** A patch that has become a DC thump shows up here and nowhere else. */
  dcOffset: number;
  silent: boolean;
  clipped: boolean;
  note: string;
}

interface Rendered {
  /** Interleaved 16-bit stereo PCM, base64 — the WAV payload. */
  pcm: string;
  sampleRate: number;
  frames: number;
  peak: number;
  rms: number;
  centroidHz: number;
  dc: number;
}

interface DuckMeasurement {
  beforeRmsDbfs: number;
  duringRmsDbfs: number;
  afterRmsDbfs: number;
  measuredDb: number;
  specDb: number;
  recoveredDb: number;
  passes: boolean;
}

interface Results {
  capturedAt: string;
  url: string;
  sampleRate: number;
  thresholds: {
    silenceDbfs: number;
    clipDbfs: number;
    duckToleranceDb: number;
  };
  sounds: Record<string, Metrics>;
  duck: DuckMeasurement | null;
  verdict: {
    clips: number;
    allAudible: boolean;
    noneClipped: boolean;
    duckWithinTolerance: boolean;
  };
}

// ---------------------------------------------------------------------------
// Page-side: the offline renderer
// ---------------------------------------------------------------------------

/**
 * Installs `globalThis.AH.render(name, seconds)` in the page. Everything the
 * clips do lives here, because `page.evaluate` serialises a function body and
 * nothing it closed over — including, deliberately, the FFT.
 */
async function installAudioHarness(): Promise<void> {
  // Held in variables so tsc treats them as dynamic: a literal specifier would
  // be resolved against the Node program and fail.
  const urls = {
    audio: '/src/audio/audio.ts',
    sfx: '/src/audio/sfx.ts',
    synth: '/src/audio/synth.ts',
    sequencer: '/src/audio/sequencer.ts',
    core: '/src/core/game.ts',
  };
  const audioMod = await import(urls.audio);
  const sfxMod = await import(urls.sfx);
  const synthMod = await import(urls.synth);
  const seqMod = await import(urls.sequencer);
  const coreMod = await import(urls.core);

  const RATE = 48000;

  /**
   * An empty 13x13 board with one player and nothing to shoot at — but WITH
   * the automatic base ring, which is load-bearing and was not there in the
   * first cut of this harness.
   *
   * `noAutoBase` leaves the five tiles around the eagle empty, and audio 4's
   * L4 danger layer fires on exactly that: an empty ring is a breached ring.
   * Every "suite at intensity N" clip therefore rendered with the danger pad
   * already up, and three of the five measured identically because they WERE
   * identical. A harness board is a board being played.
   */
  const level = {
    version: 1,
    id: 'audio-capture',
    name: 'audio capture',
    terrain: Array.from({ length: 13 }, () => '.............'),
    enemies: Array.from({ length: 20 }, () => 'basic'),
  };

  /** In-place radix-2 FFT; `re`/`im` are overwritten with the spectrum. */
  const fft = (re: Float64Array, im: Float64Array): void => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; (j & bit) !== 0; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  };

  /**
   * Magnitude-weighted mean frequency, averaged over Hann-windowed frames.
   * The single number that says "this is a boom" or "this is a hiss".
   */
  const centroid = (mono: Float32Array, rate: number): number => {
    const N = 2048;
    const hop = 1024;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const sum = new Float64Array(N / 2);
    let frames = 0;
    for (let start = 0; start + N <= mono.length; start += hop) {
      let energy = 0;
      for (let i = 0; i < N; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
        re[i] = mono[start + i] * w;
        im[i] = 0;
        energy += re[i] * re[i];
      }
      // Skip near-silent frames: a two-second clip of a 300 ms sound is mostly
      // silence, and averaging its noise floor in drags the centroid nowhere
      // useful.
      if (energy < 1e-9) {
        continue;
      }
      fft(re, im);
      for (let k = 0; k < N / 2; k++) {
        sum[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
      frames++;
    }
    if (frames === 0) {
      return 0;
    }
    let num = 0;
    let den = 0;
    for (let k = 0; k < N / 2; k++) {
      num += ((k * rate) / N) * sum[k];
      den += sum[k];
    }
    return den > 0 ? num / den : 0;
  };

  const AH = {
    async render(
      name: string,
      seconds: number,
    ): Promise<Record<string, unknown>> {
      const frames = Math.ceil(seconds * RATE);
      const ctx = new OfflineAudioContext(2, frames, RATE);
      const graph = audioMod.createAudioGraph(ctx, { music: 0.7, sfx: 0.8 });
      const pool = audioMod.createVoicePool();
      const player = sfxMod.createSfxPlayer(graph, pool);

      const state = coreMod.createGame(level, {
        players: 1,
        seed: 1,
        stageNumber: 1,
      });
      const tank = state.tanks[0];
      tank.alive = true;
      tank.spawningT = 0;
      // A player starts a stage under a 3 s spawn shield, and the shield hum is
      // a sound of its own. Cleared here so the engine clips measure the engine
      // — the first run of this harness did not, and the shield's fundamental
      // sat 15 dB over the hum's in the spectrum, which is how that balance bug
      // was found. The `helmet-loop` clip is where the shield is heard.
      tank.shieldT = 0;
      tank.x = 104;
      tank.y = 180;
      tank.prevX = tank.x;
      tank.prevY = tank.y;

      /** A steady, quiet music tone — something for the duck to act on. */
      const musicTone = (holdMs: number): void => {
        const note = synthMod.createNote();
        note.freq = 110;
        note.vel = 0.5;
        note.gain = 0.25;
        note.holdMs = holdMs;
        synthMod.playNote(
          graph.synth,
          'triBass',
          note,
          0,
          graph.musicBus,
          null,
        );
      };

      /**
       * Lays a whole piece down in one go.
       *
       * An `OfflineAudioContext` renders from a `currentTime` that never
       * advances, so the sequencer's lookahead has no later to pump in —
       * `pumpTo` is the door out of that, and the timer is stubbed away
       * because there is no real time here for it to tick in.
       */
      const music = (
        piece: Record<string, unknown>,
        clipS: number,
        layers?: Record<string, number>,
      ): void => {
        const song = piece.song as Record<string, unknown>;
        const seq = seqMod.createSequencer({
          ctx,
          destination: graph.musicTrim,
          synth: graph.synth,
          setTimer: () => 0,
          clearTimer: () => undefined,
        });
        if (layers) {
          for (const [layer, value] of Object.entries(layers)) {
            // Ramp time 0: the clip starts at the level it is meant to show
            // rather than fading in from wherever the node was built.
            seq.setLayerGain(layer, value, 0);
          }
        }
        graph.setDelayTempo(song.bpm);
        seq.play(song);
        // A one-shot is pumped only to its own length, or the offline walk
        // would loop it for the whole clip — which is what the live driver's
        // `durationS` stop exists to prevent, and what the first render of
        // this harness did (two fanfares in a three-second file).
        seq.pumpTo(piece.loops ? clipS : (piece.durationS as number));
      };

      /** The suite's layer gains, derived from a state driven to a threshold. */
      const suiteAt = (
        onField: number,
        queued: number,
        bars: number,
        breached: boolean,
      ): Record<string, number> => {
        let live = 0;
        for (const t of state.tanks) {
          if (t.kind !== 'enemy') continue;
          t.alive = live < onField;
          if (t.alive) live++;
        }
        while (live < onField) {
          state.tanks.push({
            ...state.tanks[0],
            id: 200 + live,
            kind: 'enemy',
            playerIndex: undefined,
            enemyType: 'basic',
            alive: true,
          });
          live++;
        }
        state.spawner.queue.length = 0;
        for (let i = 0; i < queued; i++) state.spawner.queue.push('basic');
        // The documented "eagle exposed" arm of the danger condition; it is the
        // one that needs no terrain arithmetic inside a page harness.
        state.eagleAlive = !breached;
        return audioMod.musicLayerTargets(state, bars).layers;
      };

      switch (name) {
        case 'music-fanfare':
          music(audioMod.MUSIC.fanfare, seconds);
          break;
        case 'music-gameover':
          music(audioMod.MUSIC.gameover, seconds);
          break;
        case 'pause-chirp':
          // NOT through the sequencer and NOT onto the music bus: this is the
          // routing the whole ruling is about, so the clip renders the real one.
          audioMod.playPiece(
            graph.synth,
            audioMod.PAUSE_CHIRP,
            graph.sfxBus,
            0.02,
          );
          break;
        case 'music-title':
          music(audioMod.MUSIC.title, seconds);
          break;
        case 'music-tally':
          music(audioMod.MUSIC.tally, seconds);
          break;
        case 'music-hiscore':
          music(audioMod.MUSIC.hiscore, seconds);
          break;
        case 'suite-L0':
          music(audioMod.MUSIC.suite, seconds, suiteAt(0, 20, 0, false));
          break;
        case 'suite-L01':
          music(audioMod.MUSIC.suite, seconds, suiteAt(0, 20, 4, false));
          break;
        case 'suite-L012':
          music(audioMod.MUSIC.suite, seconds, suiteAt(4, 12, 4, false));
          break;
        case 'suite-L0123':
          music(audioMod.MUSIC.suite, seconds, suiteAt(3, 0, 4, false));
          break;
        case 'suite-L4':
          music(audioMod.MUSIC.suite, seconds, suiteAt(3, 0, 4, true));
          break;
        case 'suite-clock': {
          music(audioMod.MUSIC.suite, seconds, suiteAt(3, 0, 4, false));
          // Audio 4: the freeze lowpasses the whole bus, and nothing else.
          graph.setClockFreeze(true, 1.5);
          break;
        }
        case 'engine-idle': {
          player.update(state, 16);
          break;
        }
        case 'engine-move': {
          // One tick's worth of full-speed displacement is what the hum reads.
          tank.prevX = tank.x - 45 / 60;
          player.update(state, 16);
          player.update(state, 16);
          break;
        }
        case 'helmet-loop': {
          // The shield hum as it is actually heard: over the engine, never
          // instead of it.
          tank.shieldT = 3;
          player.update(state, 16);
          break;
        }
        case 'player-shot':
          player.trigger('playerShot', 0, 1, 0.02);
          break;
        case 'enemy-shot':
          player.trigger('enemyShot', 0, 1, 0.02);
          break;
        case 'brick-hit':
          player.trigger('brickHit', 0, 1, 0.02);
          break;
        case 'stun-buzz':
          player.trigger('stunBuzz', 0, 1, 0.02);
          break;
        case 'steel-break':
          player.trigger('steelBreak', 0, 1, 0.02);
          break;
        case 'tank-explode':
          player.trigger('tankExplode', 0, 1, 0.02);
          break;
        case 'powerup-pickup':
          player.trigger('powerupPickup', 0, 1, 0.02);
          break;
        case 'extra-life':
          player.trigger('extraLife', 0, 1, 0.02);
          break;
        case 'base-explode': {
          musicTone(2600);
          player.update(state, 16);
          player.trigger('baseExplode', 0, 1, 0.5);
          graph.duck('baseExplode', 0.5);
          break;
        }
        case 'duck-probe': {
          // The duck on its own: no boom, so the depth is measurable rather
          // than buried under the sound that fired it.
          musicTone(2900);
          graph.duck('baseExplode', 0.8);
          break;
        }
        case 'skirmish': {
          player.update(state, 16);
          const script: [string, number, number][] = [
            ['playerShot', 0.2, -0.2],
            ['brickHit', 0.45, -0.25],
            ['enemyShot', 0.8, 0.3],
            ['steelClink', 1.05, 0.28],
            ['playerShot', 1.3, -0.1],
            ['tankExplode', 1.55, 0.15],
            ['enemySpawn', 2.1, -0.3],
            ['playerShot', 2.5, 0],
            ['brickHit', 2.72, 0.2],
            ['brickHit', 2.9, 0.22],
            ['powerupSpawn', 3.2, 0.1],
            ['powerupPickup', 3.9, 0.1],
            ['starTierUp', 4.15, 0.1],
            ['enemyShot', 4.9, -0.3],
            ['playerExplode', 5.1, -0.05],
          ];
          for (const [id, at, pan] of script) {
            player.trigger(id, pan, 1, at);
            if (id === 'playerExplode') {
              graph.duck('playerExplode', at);
            }
          }
          break;
        }
        default:
          break;
      }

      const buffer = await ctx.startRendering();
      const left = buffer.getChannelData(0);
      const right =
        buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

      // --- measure on the float data, before any quantisation --------------
      const mono = new Float32Array(buffer.length);
      let peak = 0;
      let sumSq = 0;
      let dc = 0;
      for (let i = 0; i < buffer.length; i++) {
        const m = (left[i] + right[i]) / 2;
        mono[i] = m;
        const a = Math.abs(left[i]) > Math.abs(right[i]) ? Math.abs(left[i]) : Math.abs(right[i]); // prettier-ignore
        peak = a > peak ? a : peak;
        sumSq += m * m;
        dc += m;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, buffer.length));

      // --- 16-bit interleaved PCM, base64 ---------------------------------
      const pcm = new Int16Array(buffer.length * 2);
      for (let i = 0; i < buffer.length; i++) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        pcm[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
        pcm[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }

      return {
        pcm: btoa(binary),
        sampleRate: buffer.sampleRate,
        frames: buffer.length,
        peak,
        rms,
        centroidHz: centroid(mono, buffer.sampleRate),
        dc: dc / Math.max(1, buffer.length),
      };
    },
  };

  (globalThis as unknown as { AH: typeof AH }).AH = AH;
}

// ---------------------------------------------------------------------------
// Node-side
// ---------------------------------------------------------------------------

function dbfs(linear: number): number {
  return linear <= 0 ? -Infinity : +(20 * Math.log10(linear)).toFixed(2);
}

/** A canonical 16-bit stereo PCM WAV around an already-interleaved payload. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); // byte rate: 2 ch × 2 bytes
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS in dBFS over a window of the decoded 16-bit stereo PCM. */
function windowRmsDbfs(
  pcm: Buffer,
  sampleRate: number,
  fromS: number,
  toS: number,
): number {
  const from = Math.max(0, Math.floor(fromS * sampleRate));
  const to = Math.min(Math.floor(pcm.length / 4), Math.floor(toS * sampleRate));
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const l = pcm.readInt16LE(i * 4) / 32768;
    const r = pcm.readInt16LE(i * 4 + 2) / 32768;
    const m = (l + r) / 2;
    sum += m * m;
    n++;
  }
  return n === 0 ? -Infinity : dbfs(Math.sqrt(sum / n));
}

async function renderClip(page: Page, clip: Clip): Promise<Rendered> {
  return (await page.evaluate(
    async (c: { name: string; seconds: number }) =>
      (
        globalThis as unknown as {
          AH: {
            render(
              name: string,
              seconds: number,
            ): Promise<Record<string, unknown>>;
          };
        }
      ).AH.render(c.name, c.seconds),
    { name: clip.name, seconds: clip.seconds },
  )) as unknown as Rendered;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: URL,
    sampleRate: SAMPLE_RATE,
    thresholds: {
      silenceDbfs: SILENCE_DBFS,
      clipDbfs: CLIP_DBFS,
      duckToleranceDb: DUCK_TOLERANCE_DB,
    },
    sounds: {},
    duck: null,
    verdict: {
      clips: 0,
      allAudible: false,
      noneClipped: false,
      duckWithinTolerance: false,
    },
  };

  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => {
      errors.push(e.message);
    });
    await page.addInitScript({ content: KEEP_NAMES_SHIM });
    await page.goto(URL, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(installAudioHarness);

    for (const clip of CLIPS) {
      const out = await renderClip(page, clip);
      const pcm = Buffer.from(out.pcm, 'base64');
      writeFileSync(join(OUT, `${clip.name}.wav`), wav(pcm, out.sampleRate));

      results.sounds[clip.name] = {
        durationS: +(out.frames / out.sampleRate).toFixed(3),
        peakDbfs: dbfs(out.peak),
        rmsDbfs: dbfs(out.rms),
        centroidHz: Math.round(out.centroidHz),
        dcOffset: +out.dc.toFixed(5),
        silent: dbfs(out.peak) < SILENCE_DBFS,
        clipped: dbfs(out.peak) > CLIP_DBFS,
        note: clip.note,
      };

      if (clip.name === 'duck-probe') {
        // The duck fires at 0.8 s: 20 ms of attack, 1.2 s held, 400 ms back up.
        const before = windowRmsDbfs(pcm, out.sampleRate, 0.3, 0.75);
        const during = windowRmsDbfs(pcm, out.sampleRate, 0.9, 1.9);
        const after = windowRmsDbfs(pcm, out.sampleRate, 2.5, 2.95);
        const measured = +(during - before).toFixed(2);
        results.duck = {
          beforeRmsDbfs: before,
          duringRmsDbfs: during,
          afterRmsDbfs: after,
          measuredDb: measured,
          specDb: -12,
          recoveredDb: +(after - before).toFixed(2),
          passes: Math.abs(measured - -12) <= DUCK_TOLERANCE_DB,
        };
      }
      console.log(
        `${clip.name.padEnd(16)} peak ${String(results.sounds[clip.name].peakDbfs).padStart(7)} dBFS` +
          `  rms ${String(results.sounds[clip.name].rmsDbfs).padStart(7)} dBFS` +
          `  centroid ${String(results.sounds[clip.name].centroidHz).padStart(5)} Hz`,
      );
    }

    if (errors.length > 0) {
      console.error('page errors:', errors);
      process.exitCode = 1;
    }
    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  const all = Object.values(results.sounds);
  results.verdict = {
    clips: all.length,
    allAudible: all.every((s) => !s.silent),
    noneClipped: all.every((s) => !s.clipped),
    duckWithinTolerance: results.duck?.passes === true,
  };

  writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nWAVs → ${OUT}`);
  console.log(`measurements → ${ARTIFACT}`);
  console.log('duck:', results.duck);
  console.log('verdict:', results.verdict);
  if (
    !results.verdict.allAudible ||
    !results.verdict.noneClipped ||
    !results.verdict.duckWithinTolerance
  ) {
    console.error('\nAudio capture FAILED — see docs/calibration/audio.json');
    process.exitCode = 1;
  }
}

void main();
