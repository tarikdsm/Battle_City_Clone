// src/core/game.ts — the state factory (createGame), the per-tick step skeleton
// (stepGame → nine systems in fixed order, arch §3.2), and the canonical state
// hash (hashState) that golden-replay tests compare (arch §3.5 / fidelity P-23).
import {
  BASE_RING_TILES,
  BONUS_LIFE_AT,
  EAGLE_TILE,
  FIELD_SUBCELLS,
  FIELD_TILES,
  POWERUP_TYPES,
  START_LIVES,
} from './constants';
import { subcellIndex } from './grid';
import { createRng } from './rng';
import { createPlayerTank } from './systems/players';
import {
  aiSystem,
  bulletsSystem,
  firingSystem,
  movementSystem,
  playersSystem,
  powerupsSystem,
  spawnerSystem,
  stageflowSystem,
  winloseSystem,
} from './systems/index';
import {
  NULL_INTENT,
  Terrain,
  type EnemyType,
  type GameState,
  type LevelData,
  type PlayerIntent,
  type PlayerMeta,
  type StagePhase,
  type TerrainKind,
} from './types';

// --- Canonical orderings for the state hash (indices, stable) ---
const PHASE_ORDER: readonly StagePhase[] = [
  'intro',
  'playing',
  'cleared',
  'baseLost',
  'gameOver',
];
const SHOVEL_PHASE_ORDER: readonly ('off' | 'steel' | 'blink')[] = [
  'off',
  'steel',
  'blink',
];
const ENEMY_TYPE_ORDER: readonly EnemyType[] = [
  'basic',
  'fast',
  'power',
  'armor',
];
// Power-up index order is the shared POWERUP_TYPES from constants.ts: the hash and
// the RNG roll must agree on it, so there is only one copy to keep in step.

// What the systems get instead of the real intents outside 'playing' (intro, the
// clear beat, the base-lost slow-mo, game over): the controls are dead, but every
// system still runs. A frozen module-level tuple of the frozen NULL_INTENT, so
// gating a tick costs nothing and can never be mutated into meaning something.
const LOCKED_INTENTS: readonly [PlayerIntent, PlayerIntent] = Object.freeze([
  NULL_INTENT,
  NULL_INTENT,
] as [PlayerIntent, PlayerIntent]);

export function createGame(
  level: LevelData,
  opts: { players: 1 | 2; seed: number; stageNumber: number },
): GameState {
  return {
    tick: 0,
    rng: createRng(opts.seed),
    stageNumber: opts.stageNumber,
    phase: 'intro',
    phaseT: 0,
    paused: false,
    pauseHeld: [false, false],
    terrain: buildTerrain(level),
    eagleAlive: true,
    shovel: { phase: 'off', t: 0 },
    clockT: 0,
    // Slots 0 and 1 are the players, for the whole life of the run: slot index ===
    // tank id === playerIndex. The spawner only ever recycles a dead slot whose
    // `kind` is 'enemy', so these two can never be taken over by an enemy, and the
    // renderer/HUD can address a player by a number that never moves. In a
    // 1-player game the second slot exists but is dead and its meta inactive — it
    // is never respawned and never scores.
    tanks: [createPlayerTank(0, true), createPlayerTank(1, opts.players === 2)],
    bullets: [],
    powerup: null,
    players: [makePlayer(true), makePlayer(opts.players === 2)],
    respawnT: [0, 0],
    spawner: {
      queue: [...level.enemies], // copy — never mutate the input level
      nextOrdinal: 1,
      cyclePos: 0,
      timerT: 0,
      retryT: 0,
    },
    events: [],
  };
}

export function stepGame(
  state: GameState,
  intents: readonly [PlayerIntent, PlayerIntent],
): void {
  state.events.length = 0;

  // Pause (P-26, fidelity §11.6) is resolved before anything else, from the REAL
  // intents — the pad has to work when nothing else does, or a paused game could
  // never be unpaused. It is a press EDGE, not a level: a held button toggles once.
  // Either player may toggle, and if both press on the same tick it is still one
  // toggle, not two that cancel.
  let toggled = false;
  for (let i = 0; i < state.pauseHeld.length; i++) {
    if (intents[i].pause && !state.pauseHeld[i]) toggled = true;
    state.pauseHeld[i] = intents[i].pause;
  }
  if (toggled) {
    state.paused = !state.paused;
    state.events.push({ t: 'pauseToggled', paused: state.paused });
  }

  // A paused tick freezes the simulation ENTIRELY, timers included: no system
  // runs, `tick` does not advance, and the prev-snapshot below is never taken —
  // so prev/x stay exactly as the last real tick left them and the render
  // invariant holds vacuously. (The app loop must pin its interpolation alpha
  // while paused; a cycling alpha would jitter tanks between prev and x.) The
  // toggle event above is the one thing a frozen tick may still emit.
  if (state.paused) return;

  state.tick++;

  // Outside 'playing' the controls are dead (intro curtain, stage-clear beat,
  // base-lost slow-mo, game over) — the systems get NULL_INTENT instead of the
  // pad. Decided ONCE here, from the phase the tick began in, so a whole tick
  // runs under a single gating decision: the tick on which stageflowSystem opens
  // the curtain is still locked, and control resumes on the next one. Gating the
  // intents rather than the systems is what keeps enemies spawning and moving
  // during the intro (fidelity §11.1: the first spawn is at t = 0).
  const active = state.phase === 'playing' ? intents : LOCKED_INTENTS;

  // Render-interpolation contract (arch §3.4): every tank's prevX/prevY is the
  // position it held when this tick began, so the renderer can lerp prev → current
  // by the frame's alpha. One unconditional pass here, before any system runs, is
  // what makes that true no matter WHICH system moves a tank — the AI moves
  // enemies in #3, movementSystem moves players in #4, and anything added later
  // (respawn placement, a teleport effect) is covered for free. It is deliberately
  // NOT a simulation input: prev is excluded from hashState, and the AI keeps its
  // own hashed lattice memory (Tank.aiTileX/Y) rather than reading back from here.
  //
  // The invariant, for whoever extends this function: any tick that advances
  // state.tick must leave every tank's prev equal to its position at the start of
  // that tick — including a tick that runs no systems. T1.7's pause advances
  // nothing and runs nothing, so its early-out above returns before both `tick++`
  // and this loop, and prev/x stay exactly as the last real tick left them.
  // Pinning the interpolation alpha while paused is the app loop's job, not the
  // core's. The one deliberate exception is a TELEPORT — a player respawn, an
  // enemy slot reuse — which re-anchors its own prev to the destination so the
  // renderer does not lerp a tank across the whole field for one frame.
  for (const t of state.tanks) {
    t.prevX = t.x;
    t.prevY = t.y;
  }

  stageflowSystem(state, active);
  spawnerSystem(state, active);
  aiSystem(state, active);
  movementSystem(state, active);
  firingSystem(state, active);
  bulletsSystem(state, active);
  powerupsSystem(state, active);
  playersSystem(state, active);
  winloseSystem(state, active);
}

// FNV-1a 32-bit over a canonical byte stream. Every number is written as its
// exact 8 float64 bytes so fractional positions hash losslessly. prevX/prevY
// and events are deliberately excluded (fidelity P-23).
export function hashState(state: GameState): number {
  const view = new DataView(new ArrayBuffer(8));
  let hash = 0x811c9dc5; // 2166136261 offset basis
  const PRIME = 0x01000193; // 16777619

  const feed = (n: number): void => {
    view.setFloat64(0, n);
    for (let i = 0; i < 8; i++) {
      hash ^= view.getUint8(i);
      hash = Math.imul(hash, PRIME) >>> 0;
    }
  };

  feed(state.tick);
  feed(state.rng.s);
  feed(state.stageNumber);
  feed(PHASE_ORDER.indexOf(state.phase));
  feed(state.phaseT);
  feed(state.paused ? 1 : 0);
  feed(state.pauseHeld[0] ? 1 : 0);
  feed(state.pauseHeld[1] ? 1 : 0);

  for (let i = 0; i < state.terrain.length; i++) {
    feed(state.terrain[i]);
  }

  feed(state.eagleAlive ? 1 : 0);
  feed(state.clockT);
  feed(SHOVEL_PHASE_ORDER.indexOf(state.shovel.phase));
  feed(state.shovel.t);

  for (const t of state.tanks) {
    feed(t.id);
    feed(t.alive ? 1 : 0);
    feed(t.kind === 'player' ? 0 : 1);
    feed(t.playerIndex ?? -1);
    feed(
      t.enemyType === undefined ? -1 : ENEMY_TYPE_ORDER.indexOf(t.enemyType),
    );
    feed(t.spawnOrdinal ?? -1);
    feed(t.carrier ? 1 : 0);
    feed(t.x);
    feed(t.y);
    feed(t.dir);
    feed(t.moving ? 1 : 0);
    feed(t.sliding ? 1 : 0);
    feed(t.slideV);
    feed(t.hp);
    feed(t.tier);
    feed(t.shieldT);
    feed(t.stunT);
    feed(t.frozenT);
    feed(t.spawningT);
    feed(t.bulletsAirborne);
    feed(t.fireHeld ? 1 : 0);
    feed(t.aiTimerT);
    feed(t.aiTileX);
    feed(t.aiTileY);
  }

  for (const b of state.bullets) {
    feed(b.id);
    feed(b.alive ? 1 : 0);
    feed(b.x);
    feed(b.y);
    feed(b.dir);
    feed(b.speed);
    feed(b.fromTankId);
    feed(b.byPlayer ? 1 : 0);
    feed(b.playerIndex ?? -1);
    feed(b.canHurtSteel ? 1 : 0);
  }

  if (state.powerup === null) {
    feed(-1);
  } else {
    feed(POWERUP_TYPES.indexOf(state.powerup.type));
    feed(state.powerup.x);
    feed(state.powerup.y);
  }

  for (const p of state.players) {
    feed(p.lives);
    feed(p.score);
    feed(p.nextBonusAt);
    feed(p.active ? 1 : 0);
    feed(p.destroyedByType.basic);
    feed(p.destroyedByType.fast);
    feed(p.destroyedByType.power);
    feed(p.destroyedByType.armor);
  }

  feed(state.respawnT[0]);
  feed(state.respawnT[1]);

  feed(state.spawner.queue.length);
  feed(state.spawner.nextOrdinal);
  feed(state.spawner.cyclePos);
  feed(state.spawner.timerT);
  feed(state.spawner.retryT);
  for (const e of state.spawner.queue) {
    feed(ENEMY_TYPE_ORDER.indexOf(e));
  }

  return hash >>> 0;
}

// --- Terrain construction -------------------------------------------------

function buildTerrain(level: LevelData): Uint8Array {
  const terrain = new Uint8Array(FIELD_SUBCELLS * FIELD_SUBCELLS); // 26*26 = 676

  // Each tile char fills its 2x2 block of subcells.
  for (let ty = 0; ty < FIELD_TILES; ty++) {
    const row = level.terrain[ty];
    for (let tx = 0; tx < FIELD_TILES; tx++) {
      setTile(terrain, tx, ty, terrainKindFromChar(row[tx]));
    }
  }

  // Partials refine a B/S tile: set bits keep the tile kind, unset -> Empty
  // (1=TL, 2=TR, 4=BL, 8=BR).
  if (level.partials) {
    for (const { tx, ty, mask } of level.partials) {
      const kind = terrainKindFromChar(level.terrain[ty][tx]);
      const sx = tx * 2;
      const sy = ty * 2;
      terrain[subcellIndex(sx, sy)] = (mask & 1) !== 0 ? kind : Terrain.Empty;
      terrain[subcellIndex(sx + 1, sy)] =
        (mask & 2) !== 0 ? kind : Terrain.Empty;
      terrain[subcellIndex(sx, sy + 1)] =
        (mask & 4) !== 0 ? kind : Terrain.Empty;
      terrain[subcellIndex(sx + 1, sy + 1)] =
        (mask & 8) !== 0 ? kind : Terrain.Empty;
    }
  }

  // Auto-stamp the base: full-brick ring over whatever the rows held, and clear
  // the eagle tile (the eagle is an entity, not terrain).
  if (!level.noAutoBase) {
    for (const [tx, ty] of BASE_RING_TILES) {
      setTile(terrain, tx, ty, Terrain.Brick);
    }
    setTile(terrain, EAGLE_TILE[0], EAGLE_TILE[1], Terrain.Empty);
  }

  return terrain;
}

function setTile(
  terrain: Uint8Array,
  tx: number,
  ty: number,
  kind: TerrainKind,
): void {
  const sx = tx * 2;
  const sy = ty * 2;
  terrain[subcellIndex(sx, sy)] = kind;
  terrain[subcellIndex(sx + 1, sy)] = kind;
  terrain[subcellIndex(sx, sy + 1)] = kind;
  terrain[subcellIndex(sx + 1, sy + 1)] = kind;
}

function terrainKindFromChar(ch: string): TerrainKind {
  switch (ch) {
    case 'B':
      return Terrain.Brick;
    case 'S':
      return Terrain.Steel;
    case 'W':
      return Terrain.Water;
    case 'T':
      return Terrain.Trees;
    case 'I':
      return Terrain.Ice;
    default:
      return Terrain.Empty;
  }
}

// --- Players --------------------------------------------------------------

function makePlayer(active: boolean): PlayerMeta {
  return {
    lives: active ? START_LIVES : 0,
    score: 0,
    nextBonusAt: active ? BONUS_LIFE_AT : 0,
    destroyedByType: { basic: 0, fast: 0, power: 0, armor: 0 },
    active,
  };
}
