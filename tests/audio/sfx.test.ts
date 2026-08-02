// tests/audio/sfx.test.ts — audio §5's SFX table and the event wiring (T5.2),
// against the injected fake context.
//
// Audio §5 is a **contract with 26 rows**, and the first job of this suite is
// to hold every one of them: an ID that quietly stopped existing is a sound
// that quietly stopped playing, and nothing else in the project would notice.
//
// The rest is the machinery that a rendered waveform cannot show:
//
//  - the 30 ms retrigger guard, which is what stops four bullets hitting the
//    same wall in one tick from summing into one loud click;
//  - the per-sound polyphony caps and the oldest-first stealing under them;
//  - the routing decision that puts the two `top` sounds on the sting bus;
//  - the engine hum's pitch tracking, which is the single most recognisable
//    sound in Battle City and the one this task is most likely to get wrong.
//
// How each one SOUNDS is `scripts/capture-audio.ts`'s question.

import { describe, expect, it } from 'vitest';

import {
  createAudioGraph,
  createVoicePool,
  type AudioGraph,
  type VoicePool,
} from '../../src/audio/audio';
import {
  ENGINE,
  MAX_PAN,
  PRIORITY_RANK,
  RETRIGGER_GUARD_MS,
  SFX,
  SFX_IDS,
  createSfxPlayer,
  engineCents,
  engineGain,
  engineSpeed01,
  panForX,
  sfxForEvent,
  type SfxId,
  type SfxPlayer,
  type SfxPriority,
} from '../../src/audio/sfx';
import { FIELD_U, PLAYER_SPEED, TICK_S } from '../../src/core/constants';
import { createGame } from '../../src/core/game';
import type { GameState, LevelData, Tank } from '../../src/core/types';

import {
  FakeAudioContext,
  FakeOscillatorNode,
  asAudioContext,
  fakeGain,
  fakeParam,
} from './fakeContext';

import open from '../fixtures/level-open.json' with { type: 'json' };

const OPEN = open as LevelData;

/**
 * Audio §5's table, transcribed as `[id, priority, poly cap]`. This is the
 * doc, not the implementation — if the two disagree the doc wins.
 */
const AUDIO_DOC_SFX: readonly [SfxId, SfxPriority, number][] = [
  ['playerShot', 'high', 2],
  ['enemyShot', 'med', 3],
  ['bulletsCancel', 'med', 2],
  ['brickHit', 'high', 3],
  ['steelClink', 'high', 2],
  ['steelBreak', 'high', 2],
  ['tankExplode', 'high', 3],
  ['playerExplode', 'top', 1],
  ['baseExplode', 'top', 1],
  ['enemySpawn', 'med', 2],
  ['powerupSpawn', 'med', 1],
  ['powerupPickup', 'high', 1],
  ['starTierUp', 'high', 1],
  ['helmetLoop', 'low', 2],
  ['clockFreeze', 'high', 1],
  ['shovelClank', 'high', 1],
  ['extraLife', 'top', 1],
  ['stunBuzz', 'med', 1],
  ['engineIdle', 'low', 2],
  ['engineMove', 'low', 2],
  ['iceSlide', 'low', 2],
  ['treeRustle', 'low', 2],
  ['uiMove', 'med', 2],
  ['uiSelect', 'med', 2],
  ['uiBack', 'med', 2],
  ['tallyTick', 'med', 1],
];

interface Rig {
  fake: FakeAudioContext;
  graph: AudioGraph;
  pool: VoicePool;
  sfx: SfxPlayer;
  state: GameState;
}

function rig(players: 1 | 2 = 1): Rig {
  const fake = new FakeAudioContext();
  const graph = createAudioGraph(asAudioContext(fake));
  const pool = createVoicePool();
  return {
    fake,
    graph,
    pool,
    sfx: createSfxPlayer(graph, pool),
    state: createGame(OPEN, { players, seed: 1, stageNumber: 1 }),
  };
}

/** The player-1 tank, which `createGame` always puts in slot 0. */
function player(state: GameState): Tank {
  return state.tanks[0];
}

/** Moves a tank as one tick at `fraction` of the player's full speed. */
function moveAt(tank: Tank, fraction: number): void {
  tank.prevX = tank.x;
  tank.prevY = tank.y;
  tank.x = tank.prevX + PLAYER_SPEED * TICK_S * fraction;
  tank.moving = fraction > 0;
}

describe('the SFX table (audio §5)', () => {
  it('registers every row the doc names, and only those', () => {
    expect([...SFX_IDS].sort()).toEqual(AUDIO_DOC_SFX.map((r) => r[0]).sort());
  });

  it("carries each row's priority and poly cap", () => {
    for (const [id, priority, poly] of AUDIO_DOC_SFX) {
      expect(SFX[id].priority, `${id} priority`).toBe(priority);
      expect(SFX[id].poly, `${id} poly cap`).toBe(poly);
    }
  });

  it('ranks priorities so a `top` sound outranks everything', () => {
    expect(PRIORITY_RANK.top).toBeGreaterThan(PRIORITY_RANK.high);
    expect(PRIORITY_RANK.high).toBeGreaterThan(PRIORITY_RANK.med);
    expect(PRIORITY_RANK.med).toBeGreaterThan(PRIORITY_RANK.low);
  });

  it('routes only the two explosions that duck everything to the sting bus', () => {
    const onSting = SFX_IDS.filter((id) => SFX[id].bus === 'sting');
    expect([...onSting].sort()).toEqual(['baseExplode', 'playerExplode']);
  });
});

describe('event → sound (audio §5, core events)', () => {
  it('maps every event that should be heard', () => {
    expect(
      sfxForEvent({ t: 'shotFired', tankId: 0, x: 0, y: 0, dir: 0, byPlayer: true }), // prettier-ignore
    ).toBe('playerShot');
    expect(
      sfxForEvent({ t: 'shotFired', tankId: 0, x: 0, y: 0, dir: 0, byPlayer: false }), // prettier-ignore
    ).toBe('enemyShot');
    expect(sfxForEvent({ t: 'bulletsCanceled', x: 0, y: 0 })).toBe(
      'bulletsCancel',
    );
    expect(
      sfxForEvent({ t: 'brickHit', tx: 1, ty: 1, removedMask: 3, x: 0, y: 0, dir: 0 }), // prettier-ignore
    ).toBe('brickHit');
    expect(
      sfxForEvent({ t: 'steelHit', tx: 1, ty: 1, removedMask: 0, destroyed: false, x: 0, y: 0, dir: 0 }), // prettier-ignore
    ).toBe('steelClink');
    expect(
      sfxForEvent({ t: 'steelHit', tx: 1, ty: 1, removedMask: 15, destroyed: true, x: 0, y: 0, dir: 0 }), // prettier-ignore
    ).toBe('steelBreak');
    expect(
      sfxForEvent({ t: 'tankDestroyed', tankId: 3, kind: 'enemy', points: 100, x: 0, y: 0 }), // prettier-ignore
    ).toBe('tankExplode');
    expect(
      sfxForEvent({ t: 'tankDestroyed', tankId: 0, kind: 'player', points: 0, x: 0, y: 0 }), // prettier-ignore
    ).toBe('playerExplode');
    expect(sfxForEvent({ t: 'baseDestroyed' })).toBe('baseExplode');
    expect(
      sfxForEvent({ t: 'enemySpawnStarted', spawnOrdinal: 1, x: 0, y: 0, enemyType: 'basic', carrier: false }), // prettier-ignore
    ).toBe('enemySpawn');
    expect(sfxForEvent({ t: 'powerupSpawned', type: 'star', x: 0, y: 0 })).toBe(
      'powerupSpawn',
    );
    expect(
      sfxForEvent({ t: 'powerupCollected', type: 'star', playerIndex: 0, x: 0, y: 0 }), // prettier-ignore
    ).toBe('powerupPickup');
    expect(sfxForEvent({ t: 'tierChanged', playerIndex: 0, tier: 2 })).toBe(
      'starTierUp',
    );
    expect(sfxForEvent({ t: 'clockStarted' })).toBe('clockFreeze');
    expect(sfxForEvent({ t: 'shovelPhase', phase: 'steel' })).toBe(
      'shovelClank',
    );
    expect(sfxForEvent({ t: 'extraLife', playerIndex: 0 })).toBe('extraLife');
    expect(sfxForEvent({ t: 'playerStunned', playerIndex: 0, durS: 3 })).toBe(
      'stunBuzz',
    );
    expect(sfxForEvent({ t: 'iceSkidStarted', tankId: 0 })).toBe('iceSlide');
    expect(sfxForEvent({ t: 'treeEntered', tankId: 0 })).toBe('treeRustle');
  });

  it('stays silent for events that are not sounds', () => {
    // A tier RESET is the respawn tidying up, not a power-up: playing the
    // star fanfare when the player dies would be a bug you hear every life.
    expect(
      sfxForEvent({ t: 'tierChanged', playerIndex: 0, tier: 0 }),
    ).toBeNull();
    expect(sfxForEvent({ t: 'tankHit', tankId: 1, hpLeft: 2 })).toBeNull();
    expect(sfxForEvent({ t: 'enemySpawned', tankId: 4 })).toBeNull();
    expect(
      sfxForEvent({ t: 'bulletDespawned', x: 0, y: 0, reason: 'border' }),
    ).toBeNull();
    expect(sfxForEvent({ t: 'clockEnded' })).toBeNull();
  });
});

describe('stereo placement (audio §6)', () => {
  it('pans by world x, never past ±0.35', () => {
    expect(MAX_PAN).toBeCloseTo(0.35, 9);
    expect(panForX(0)).toBeCloseTo(-MAX_PAN, 9);
    expect(panForX(FIELD_U)).toBeCloseTo(MAX_PAN, 9);
    expect(panForX(FIELD_U / 2)).toBeCloseTo(0, 9);
    // Off-field coordinates cannot widen the image.
    expect(panForX(-500)).toBeCloseTo(-MAX_PAN, 9);
    expect(panForX(5000)).toBeCloseTo(MAX_PAN, 9);
  });
});

describe('the retrigger guard and the poly caps', () => {
  it('refuses an identical sound inside 30 ms', () => {
    const r = rig();
    expect(RETRIGGER_GUARD_MS).toBe(30);
    expect(r.sfx.trigger('brickHit', 0, 1)).toBe(true);
    // Four bullets landing on the same wall in one tick is one brick hit, not
    // four summed into a click 12 dB louder than any other sound in the game.
    expect(r.sfx.trigger('brickHit', 0, 1)).toBe(false);

    r.fake.advance(RETRIGGER_GUARD_MS / 1000 - 0.001);
    expect(r.sfx.trigger('brickHit', 0, 1)).toBe(false);
    r.fake.advance(0.002);
    expect(r.sfx.trigger('brickHit', 0, 1)).toBe(true);
  });

  it('guards each sound separately', () => {
    const r = rig();
    expect(r.sfx.trigger('playerShot', 0, 1)).toBe(true);
    expect(r.sfx.trigger('enemyShot', 0, 1)).toBe(true);
    expect(r.sfx.trigger('brickHit', 0, 1)).toBe(true);
  });

  it("never exceeds a sound's poly cap", () => {
    const r = rig();
    for (let i = 0; i < 8; i++) {
      r.fake.advance(0.05); // past the retrigger guard every time
      r.sfx.trigger('brickHit', 0, 1);
    }
    // Audio §5 caps brickHit at 3; the pool steals rather than stacking.
    expect(r.pool.taggedCount(SFX_IDS.indexOf('brickHit'))).toBeLessThanOrEqual(
      SFX.brickHit.poly,
    );
  });

  it('sends the stings past the SFX duck and everything else through it', () => {
    const r = rig();
    r.sfx.trigger('baseExplode', 0, 1);
    expect(r.fake.feeding(fakeGain(r.graph.stingBus)).length).toBeGreaterThan(
      0,
    );
    const beforeSfx = r.fake.feeding(fakeGain(r.graph.sfxBus)).length;
    r.fake.advance(0.5);
    r.sfx.trigger('brickHit', 0, 1);
    expect(r.fake.feeding(fakeGain(r.graph.sfxBus)).length).toBeGreaterThan(
      beforeSfx,
    );
  });

  it('plays every single row without throwing', () => {
    // The cheapest possible guard against a patch that references a field it
    // does not have: every §5 row, actually built, against a real graph.
    const r = rig();
    for (const id of SFX_IDS) {
      r.fake.advance(0.1);
      expect(() => r.sfx.trigger(id, 0.2, 0.7), id).not.toThrow();
    }
  });
});

describe("the engine hum (audio §5, the game's actual soundtrack)", () => {
  it('alternates a semitone at 8 Hz on a 12.5% pulse', () => {
    // The three numbers audio §1 and §5 both insist on.
    expect(ENGINE.alternateHz).toBe(8);
    expect(ENGINE.alternateCents).toBe(100);
    expect(ENGINE.patch).toBe('pulse12');
  });

  it('raises the pitch with speed, up to +3 semitones', () => {
    expect(engineCents(0)).toBeCloseTo(0, 9);
    expect(engineCents(1)).toBeCloseTo(ENGINE.moveSemitones * 100, 9);
    expect(engineCents(0.5)).toBeGreaterThan(engineCents(0.25));
    expect(ENGINE.moveSemitones).toBe(3);
    // …and is louder while moving, per §5's "quiet" idle.
    expect(engineGain(1)).toBeGreaterThan(engineGain(0));
    expect(engineGain(0)).toBeGreaterThan(0);
  });

  it("reads the speed from the tank's own displacement, not from `moving`", () => {
    const r = rig();
    const tank = player(r.state);
    expect(engineSpeed01(tank)).toBeCloseTo(0, 6);
    moveAt(tank, 1);
    expect(engineSpeed01(tank)).toBeCloseTo(1, 6);
    moveAt(tank, 0.5);
    expect(engineSpeed01(tank)).toBeCloseTo(0.5, 6);
    // Driving into a wall: `moving` is true and the tank has not moved, so the
    // hum must stay at idle. A hum keyed on the intent would rev at a wall.
    tank.prevX = tank.x;
    tank.prevY = tank.y;
    tank.moving = true;
    expect(engineSpeed01(tank)).toBeCloseTo(0, 6);
  });

  it('starts one hum per living player and tracks its speed', () => {
    const r = rig();
    const tank = player(r.state);
    tank.spawningT = 0;
    r.sfx.update(r.state, 16);

    const hum = r.fake.created.find(
      (n): n is FakeOscillatorNode =>
        n instanceof FakeOscillatorNode && n.wave !== null,
    );
    expect(hum, 'expected a pulse12 hum oscillator').toBeDefined();
    // Idle: the base detune sits at zero and the LFO does all the moving.
    expect(hum?.detune.last('target')?.value ?? 0).toBeCloseTo(0, 3);

    // The 8 Hz square that makes it a TWO-note buzz rather than a drone.
    const lfo = r.fake.created.find(
      (n): n is FakeOscillatorNode =>
        n instanceof FakeOscillatorNode && n.type === 'square',
    );
    expect(lfo?.frequency.value).toBeCloseTo(ENGINE.alternateHz, 9);

    r.fake.advance(0.1);
    moveAt(tank, 1);
    r.sfx.update(r.state, 16);
    expect(hum?.detune.last('target')?.value ?? 0).toBeCloseTo(
      ENGINE.moveSemitones * 100,
      1,
    );
  });

  it('silences the hum when the player is dead and revives it on respawn', () => {
    const r = rig();
    const tank = player(r.state);
    tank.spawningT = 0;
    r.sfx.update(r.state, 16);
    const level = r.sfx.engineLevel(0);
    expect(level).toBeGreaterThan(0);

    tank.alive = false;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBe(0);

    tank.alive = true;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBeGreaterThan(0);
  });

  it('gives player two its own hum', () => {
    const r = rig(2);
    r.state.tanks[0].spawningT = 0;
    r.state.tanks[1].spawningT = 0;
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBeGreaterThan(0);
    expect(r.sfx.engineLevel(1)).toBeGreaterThan(0);
  });
});

describe('the sustained sounds', () => {
  it('builds its looping voices once, however many frames run', () => {
    const r = rig();
    player(r.state).spawningT = 0;
    r.sfx.update(r.state, 16);
    const afterFirst = r.fake.created.length;
    for (let i = 0; i < 120; i++) {
      r.fake.advance(1 / 60);
      r.sfx.update(r.state, 16);
    }
    // Two seconds of frames: not one new node. A looping sound rebuilt per
    // frame is the classic way to melt a browser tab with audio.
    expect(r.fake.created.length).toBe(afterFirst);
    // …and it never touches the one-shot budget.
    expect(r.pool.activeCount()).toBe(0);
  });

  it('opens the shield hum only while the player is shielded', () => {
    const r = rig();
    const tank = player(r.state);
    tank.spawningT = 0;
    tank.shieldT = 0;
    r.sfx.update(r.state, 16);
    expect(r.sfx.shieldLevel(0)).toBe(0);

    tank.shieldT = 3;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.shieldLevel(0)).toBeGreaterThan(0);

    tank.shieldT = 0;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.shieldLevel(0)).toBe(0);
  });

  it('scales the ice whoosh with the slide speed', () => {
    const r = rig();
    const tank = player(r.state);
    tank.spawningT = 0;
    r.sfx.update(r.state, 16);
    expect(r.sfx.slideLevel()).toBe(0);

    tank.sliding = true;
    tank.slideV = PLAYER_SPEED;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    const fast = r.sfx.slideLevel();
    expect(fast).toBeGreaterThan(0);

    tank.slideV = PLAYER_SPEED * 0.25;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.slideLevel()).toBeLessThan(fast);
  });

  it('ticks the clock while the freeze is running, and stops after it', () => {
    const r = rig();
    player(r.state).spawningT = 0;
    r.state.clockT = 10;
    let ticks = 0;
    for (let i = 0; i < 120; i++) {
      r.fake.advance(1 / 60);
      const before = r.sfx.stats().oneShots;
      r.sfx.update(r.state, 1000 / 60);
      if (r.sfx.stats().oneShots > before) {
        ticks++;
      }
    }
    // Two seconds of freeze at one tick-tock every half second.
    expect(ticks).toBeGreaterThanOrEqual(3);

    r.state.clockT = 0;
    const before = r.sfx.stats().oneShots;
    for (let i = 0; i < 120; i++) {
      r.fake.advance(1 / 60);
      r.sfx.update(r.state, 1000 / 60);
    }
    expect(r.sfx.stats().oneShots).toBe(before);
  });

  it('goes silent while the game is paused', () => {
    const r = rig();
    const tank = player(r.state);
    tank.spawningT = 0;
    moveAt(tank, 1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBeGreaterThan(0);

    // On the NES the hum cuts the instant you press start, and that silence is
    // half of what makes a pause read as a pause.
    r.state.paused = true;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBe(0);

    r.state.paused = false;
    r.fake.advance(0.1);
    r.sfx.update(r.state, 16);
    expect(r.sfx.engineLevel(0)).toBeGreaterThan(0);
  });

  it('parks every looping voice on dispose', () => {
    const r = rig();
    player(r.state).spawningT = 0;
    r.sfx.update(r.state, 16);
    r.sfx.dispose();
    expect(r.sfx.engineLevel(0)).toBe(0);
    // The gains really were ramped down rather than merely forgotten.
    const humGain = r.fake.created.find(
      (n) =>
        n.kind === 'gain' &&
        fakeParam((n as unknown as { gain: AudioParam }).gain).events.some(
          (e) => e.op === 'target' && e.value === 0,
        ),
    );
    expect(humGain).toBeDefined();
  });
});
