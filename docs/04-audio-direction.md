# Battle City Remake — Audio Direction

**Doc:** 04 · **Status:** Approved design (2026-07-20) · **Audience:** audio-engine and music/SFX implementers

## 1. Pillars

1. **NES DNA, modern body.** Every sound starts from the 2A03 palette (pulse, triangle, noise) and is thickened with modern layers (sub bass, pads, transient kicks) and a produced mix (compression, delay, reverb, ducking).
2. **100% synthesized.** No audio files. Music is note data played by the synth engine; SFX are parametric patches. (Chiptune modernizado, per the owner's choice.)
3. **Audio answers gameplay.** Adaptive layers respond to the battle state; big moments duck everything else. The original's engine hum — Battle City's actual "soundtrack" — becomes the rhythmic bed of ours.
4. **Faithful where it counts.** The iconic jingles (stage-start fanfare, game over, pause) are recognizable re-arrangements of the originals; new music quotes their motifs.

## 2. Engine

- Graph: `voices → sfxBus/musicBus → compressor (2:1, −18 dB knee) → limiter (−1 dBTP) → masterGain`.
- Buses: independent gains (settings sliders), music bus has a duck gain node driven by the ducking matrix (§6).
- Sequencer: lookahead scheduler (120 ms window, 25 ms tick) — standard precise WebAudio pattern; tempo-accurate loops; per-track layer gains automatable at runtime (250 ms smoothing) for adaptive music.
- Song format: `{ bpm, ppq: 4, tracks: [{ instrument, layer, steps: [tick, midi, durTicks, vel][] }], loopAtTick }`.
- Voice budget 24; per-SFX polyphony caps (§5); context resumes on first user gesture; mute-on-blur (setting, default on).

## 3. Instruments (patch registry)

| Patch | Recipe (ADSR in ms) |
|---|---|
| `pulse50 / pulse25 / pulse12` | square via **`PeriodicWave`** (measured, T5.1: a wave-shaper aliases audibly at 12.5% duty); vibrato 6 Hz ±10 cents optional; A5 D40 S0.7 R60 |
| `triBass` | triangle osc + `subSine` one octave down at −12 dB; A5 D30 S0.9 R80 |
| `kick` | sine pitch-swept 150→48 Hz over 90 ms + click transient; A0 D90 |
| `snare` | white noise bandpass 1.8 kHz + 200 Hz sine body 60 ms |
| `hat` | white noise highpass 6 kHz, D30 (closed) / D120 (open) |
| `pad` | 2 detuned saws (±8 cents) → lowpass 1.2 kHz, A400 D200 S0.6 R600, width via haas 12 ms |
| `bell` | 2-op FM, ratio 3.01, index decay 300 ms — power-ups/UI sparkle |
| `noiseFx` | shaped noise bursts, per-SFX filters |

Send FX: tempo-synced delay (3/16, feedback 0.25, music only), small plate-style reverb (SFX 8% wet, music 12%).

## 4. Music map

| Piece | Basis | Notes |
|---|---|---|
| Title theme | **new**, quotes stage-fanfare motif | ~92 BPM, A minor, pulse lead over pad + triBass; loops 32 bars |
| Stage intro fanfare | **faithful re-arrangement** of the iconic opening riff | ~4 s, plays over curtain/fly-in, ends on downbeat of Layer 0 |
| Gameplay adaptive suite | **new** (the NES had no in-game music — only engine hum) | see below |
| Stage clear / tally | **new**, rising resolution jingle + tally tick sounds | 6 s + per-line ticks |
| Game over | **faithful re-arrangement** of the descending motif | somber, short tail |
| High-score entry | **new**, sparkly bell loop | 8 bars |
| Pause jingle | **faithful** two-note pause chirp; music halts while paused | |

**Adaptive gameplay suite** — one continuous piece with additive layers; the sim's events drive target gains:

| Layer | Content | Active when |
|---|---|---|
| L0 hum-ostinato | triBass 8th-note two-note ostinato — a musicalized descendant of the NES engine hum | always |
| L1 groove | kick + hat, sparse | always (enters after 2 bars) |
| L2 arps | pulse25 16th arpeggios | ≥3 enemies on field |
| L3 lead | pulse50 melody (original-motif variations) | ≤5 enemies left to destroy |
| L4 danger | minor-2nd pad swells + toms | base ring breached, eagle exposed, or last life |

Rules: layers fade in/out over 250 ms on state change (recomputed from `GameEvent`s); L4 overrides L3's lead with a tenser variation; Clock freeze filters the whole bus (lowpass sweep to 400 Hz) for its duration — time feels stopped.

## 5. SFX table (all parametric patches)

| ID | Recipe sketch | Priority | Poly cap |
|---|---|---|---|
| playerShot | pulse blip 880→440 Hz 40 ms + noise tick | high | 2 |
| enemyShot | same, −6 dB, 660→330 | med | 3 |
| bulletsCancel | short dual pop | med | 2 |
| brickHit | noise burst bandpass 800 Hz 90 ms + low crunch | high | 3 |
| steelClink | FM ping 2.4 kHz, fast decay + ricochet whistle (rand pitch ±3 st) | high | 2 |
| steelBreak | clink + metal shard shimmer | high | 2 |
| tankExplode | noise boom 250 ms + sub drop 90→40 Hz + debris crackle | high | 3 |
| playerExplode | bigger boom; ducks music −6 dB / 400 ms | top | 1 |
| baseExplode | long layered boom 1.2 s + alarm sting; ducks everything −12 dB / 1.2 s | top | 1 |
| enemySpawn | shimmer arp up (bell), 300 ms | med | 2 |
| powerupSpawn | bell arp + sparkle loop while on field (quiet, range-limited) | med | 1 |
| powerupPickup | major-triad bell arp + shimmer tail (the classic "chirilip" feel) | high | 1 |
| starTierUp | 400 ms mini-fanfare on top of pickup | high | 1 |
| helmetLoop | soft shield hum (filtered pulse), while shielded | low | 2 |
| clockFreeze | downward time-stop sweep + slow tick-tock during effect | high | 1 |
| shovelClank | 3 hammer clanks; reverse-sweep warning at blink phase | high | 1 |
| extraLife | rising jingle (faithful spirit) | top | 1 |
| stunBuzz | wobble buzz 300 ms + comedic spring | med | 1 |
| engineIdle / engineMove | the classic buzz: pulse12 alternating a semitone at 8 Hz; pitch +0…+3 st with speed; per-player, always audible while alive (quiet) | low | 2 |
| iceSlide | filtered noise whoosh, gain ∝ slide speed | low | 2 |
| treeRustle | short leaf-noise chiff | low | 2 |
| uiMove / uiSelect / uiBack | pulse blip / bell confirm / low blip | med | 2 |
| tallyTick | per-line counting blips, pitch rising with total | med | 1 |

Retrigger guard: identical SFX ≥ 30 ms apart; beyond poly cap, steal the oldest voice.

## 6. Mix

- Targets: music bed ~−16 LUFS-ish under gameplay, SFX peaks −6 dB below limiter ceiling; master ceiling −1 dB. **Web Audio has no true-peak limiter** (T5.1), so this ships as a brick-wall compressor with peaks *measured* in `docs/calibration/audio.json` rather than a dBTP guarantee.
- **The engine hum reads as roughness, not two distinguishable pitches** — a semitone alternating at 8 Hz gives a modulation index of 0.41, which the ear resolves as timbre. That is correct and matches the NES; "two-note" in §5 describes the construction, not the percept. Measured duck: **−11.99 dB** against the −12 target, recovering to −0.13 dB.
- Ducking matrix: baseExplode → all −12 dB, 1.2 s, 400 ms release; playerExplode → music −6 dB, 400 ms; clockFreeze → music lowpassed (no gain duck).
- Stereo: subtle SFX pan by world x (±0.35 max); music mostly center with pad width.
- Everything through the shared compressor so the mix "breathes" as one.

## 7. Faithfulness ledger

| Faithful re-arrangements (motif-recognizable) | New compositions (motif-quoting) |
|---|---|
| Stage intro fanfare, Game over, Pause chirp, engine hum concept, power-up pickup feel, extra-life spirit | Title, adaptive gameplay suite, tally, high-score |

Review criterion for the faithful set: a Battle City player must recognize each within 2 seconds. The orchestrator gates the music tasks on this.
