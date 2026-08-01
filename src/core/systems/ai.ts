// src/core/systems/ai.ts — enemy AI (pipeline system #3, fidelity spec §9).
// `[FEEL]`: the NES AI is not documented at instruction level, so this is a
// perceived-equivalent reconstruction whose weights live in constants.ts for the
// calibration pass. The STRUCTURE is not a tuning knob — every enemy runs the
// same fixed procedure each tick, and its rng draws happen in this exact order:
//
//   1. step the decision timer down (no draw)
//   2. lattice-crossing roll   — one draw, iff a tile line was crossed last tick
//   3. decide, when triggered  — one draw for the weighted pick, plus a second
//                                for the uniform fallback; a reverse draws none
//   4. timer reset             — one draw, after ANY decision
//   5. fire roll               — one draw, unconditionally
//
// Golden replays (P-23) record that stream, so reordering it — even in a way
// that looks equivalent, like skipping the lattice roll when the timer has
// already expired — silently invalidates every recorded run.
//
// The AI never re-implements movement: it asks `probeMove` where it could go and
// hands the decision to `moveTank` as a wanted direction, so turn-snap, blocking
// and ice stay in exactly one place. Allocation-free in steady state (the open
// direction list is the module-level scratch below).
import {
  AI_ALIGN_TOLERANCE,
  AI_FIRE_ALIGNED_PS,
  AI_FIRE_RANDOM_PS,
  AI_LATTICE_RECONSIDER,
  AI_TIMER_MIN,
  AI_TIMER_SPAN,
  AI_W_BASE_BASE,
  AI_W_BASE_MAX,
  AI_W_BASE_PER_STAGE,
  AI_W_KEEP,
  AI_W_PLAYER,
  EAGLE_TILE,
  STAGE_CAP,
  TANK_SIZE,
  TICK_S,
  TILE,
} from '../constants';
import { nextFloat, nextInt } from '../rng';
import { tryFire } from './bullets';
import { moveTank, probeMove, tankSpeed } from './movement';
import {
  DIR_VECS,
  type Dir,
  type GameState,
  type PlayerIntent,
  type Tank,
} from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// The eagle's AABB centre — a fixed point, so it is computed once.
const EAGLE_CX = EAGLE_TILE[0] * TILE + TILE / 2;
const EAGLE_CY = EAGLE_TILE[1] * TILE + TILE / 2;

const HALF_TANK = TANK_SIZE / 2;

// Module-level scratch: the directions a tank could actually take, refilled at
// every decision. Single-threaded and never held across a call, so one buffer
// serves the whole simulation without allocating per decision.
const openDirs: Dir[] = [0, 0, 0, 0];
let openCount = 0;

// --- System ----------------------------------------------------------------

export function aiSystem(state: GameState, intents: Intents): void {
  void intents; // enemies have no input — they are the input

  for (const tank of state.tanks) {
    if (tank.kind !== 'enemy') continue;

    // Read the tile-lattice crossing the PREVIOUS tick's movement produced, then
    // re-arm the memory for the next one. Both happen for every enemy, frozen or
    // not, so a thawing tank never sees a stale crossing from before the freeze.
    //
    // The read must stay ahead of the write, and the memory must stay this
    // system's own: it is the only record of where the tank came from, and it is
    // hashed (unlike prevX/prevY), so if a later task ever gates this system the
    // golden replays fail loudly instead of the rule going quietly dead.
    const crossed = crossedTileLine(tank);
    tank.aiTileX = Math.floor(tank.x / TILE);
    tank.aiTileY = Math.floor(tank.y / TILE);

    // Frozen (Clock, §9): no decision, no timer, no draw, no move, no shot.
    if (!tank.alive || tank.spawningT > 0 || tank.frozenT > 0) continue;

    driveEnemy(state, tank, crossed);
  }
}

function driveEnemy(state: GameState, tank: Tank, crossed: boolean): void {
  const step = tankSpeed(tank) * TICK_S;

  // 1 — decision timer. Floored at 0 rather than snapped through `stepDown`:
  // the timer is armed with a random 0.5..2.0 s, never a whole multiple of
  // TICK_S, so there is no exact tick count for the half-tick snap to protect.
  tank.aiTimerT = Math.max(0, tank.aiTimerT - TICK_S);

  // 2 — the lattice roll is drawn on every crossing, whatever else is already
  // true this tick: the draw is part of the stream, not part of the condition.
  const latticeReconsider =
    crossed && nextFloat(state.rng) < AI_LATTICE_RECONSIDER;

  // 3 — triggers: timer due, the reconsider roll, or nowhere left to go.
  let trigger = tank.aiTimerT === 0 || latticeReconsider;
  if (!trigger) trigger = probeMove(state, tank, tank.dir, step) === 0;

  // 4/5 — decide and re-arm. The decided direction is handed to moveTank as a
  // WANTED direction so its 90-degree turn snap applies; ai.ts never snaps.
  let wantDir = tank.dir;
  if (trigger) {
    wantDir = decide(state, tank);
    tank.aiTimerT = AI_TIMER_MIN + nextFloat(state.rng) * AI_TIMER_SPAN;
  }

  // 6 — move (moveTank owns snap/collide/ice).
  moveTank(state, tank, wantDir, TICK_S);

  // 7 — fire roll, always exactly one draw, at the rate its aim earns.
  const rate = isAligned(state, tank) ? AI_FIRE_ALIGNED_PS : AI_FIRE_RANDOM_PS;
  if (nextFloat(state.rng) < rate * TICK_S) tryFire(state, tank);
}

// --- Decision --------------------------------------------------------------

// Pick this tank's next direction (fidelity §9). Exported for the weight tests:
// it is one weighted draw, plus a second one only when the weighted roll falls
// through to the uniform pick — which is what lets a test classify a sample
// exactly instead of unmixing it statistically.
export function decide(state: GameState, tank: Tank): Dir {
  const step = tankSpeed(tank) * TICK_S;

  // Open directions, evaluated in Dir order 0..3 and never rolled for.
  openCount = 0;
  for (let d = 0; d < 4; d++) {
    if (probeMove(state, tank, d as Dir, step) > 0) {
      openDirs[openCount] = d as Dir;
      openCount++;
    }
  }
  // Walled in on all four sides: turn around, and spend nothing doing it.
  if (openCount === 0) return opposite(tank.dir);

  const cx = tank.x + HALF_TANK;
  const cy = tank.y + HALF_TANK;

  const wKeep = isOpenInCurrentDecision(tank.dir) ? AI_W_KEEP : 0;

  const dirBase = towardDir(cx, cy, EAGLE_CX, EAGLE_CY);
  const wBase = isOpenInCurrentDecision(dirBase)
    ? Math.min(
        AI_W_BASE_MAX,
        AI_W_BASE_BASE +
          AI_W_BASE_PER_STAGE * Math.min(state.stageNumber, STAGE_CAP),
      )
    : 0;

  const target = nearestPlayer(state, cx, cy);
  let dirPlayer: Dir = 0;
  let wPlayer = 0;
  if (target !== undefined) {
    dirPlayer = towardDir(cx, cy, target.x + HALF_TANK, target.y + HALF_TANK);
    if (isOpenInCurrentDecision(dirPlayer)) wPlayer = AI_W_PLAYER;
  }

  const r = nextFloat(state.rng);
  if (r < wKeep) return tank.dir;
  if (r < wKeep + wBase) return dirBase;
  if (r < wKeep + wBase + wPlayer) return dirPlayer;
  return openDirs[nextInt(state.rng, openCount)];
}

// The direction (of four) along the axis with the LARGER |delta| toward the
// target; an exact tie prefers the vertical axis. Pure — no state, no rng.
export function towardDir(
  fromCx: number,
  fromCy: number,
  toCx: number,
  toCy: number,
): Dir {
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}

// --- Internals -------------------------------------------------------------

// Reads the `openDirs` scratch, which only `decide` fills — meaningless (and
// silently stale) anywhere else, hence the name.
function isOpenInCurrentDecision(dir: Dir): boolean {
  for (let i = 0; i < openCount; i++) {
    if (openDirs[i] === dir) return true;
  }
  return false;
}

// One definition of "a player worth reasoning about", shared by the target
// search and the alignment check: on the field, materialized, and actually
// bound to a player slot.
function isLivePlayer(t: Tank): boolean {
  return (
    t.kind === 'player' &&
    t.alive &&
    t.spawningT === 0 &&
    t.playerIndex !== undefined
  );
}

function opposite(dir: Dir): Dir {
  return ((dir + 2) % 4) as Dir;
}

// Did the tank's movement axis cross a tile line during the previous tick? Read
// before the memory is re-armed, so it describes the move that just finished.
// Only the movement axis counts: a 90-degree turn snaps the OTHER axis by up to
// 4 u, which can shift its tile without the tank having crossed anything.
function crossedTileLine(tank: Tank): boolean {
  const horizontal = DIR_VECS[tank.dir][0] !== 0;
  const from = horizontal ? tank.aiTileX : tank.aiTileY;
  const to = Math.floor((horizontal ? tank.x : tank.y) / TILE);
  return from !== to;
}

// The alive, materialized player nearest by Manhattan distance between centres;
// an exact tie goes to the lower playerIndex. Allocation-free.
function nearestPlayer(
  state: GameState,
  cx: number,
  cy: number,
): Tank | undefined {
  let best: Tank | undefined;
  let bestD = Infinity;
  let bestIndex = Infinity;
  for (const t of state.tanks) {
    if (!isLivePlayer(t) || t.playerIndex === undefined) continue;
    const d = Math.abs(t.x + HALF_TANK - cx) + Math.abs(t.y + HALF_TANK - cy);
    if (d < bestD || (d === bestD && t.playerIndex < bestIndex)) {
      best = t;
      bestD = d;
      bestIndex = t.playerIndex;
    }
  }
  return best;
}

// Lined up on something worth shooting: a player (or the standing eagle) ahead
// along the facing axis, within AI_ALIGN_TOLERANCE laterally (§9).
function isAligned(state: GameState, tank: Tank): boolean {
  const cx = tank.x + HALF_TANK;
  const cy = tank.y + HALF_TANK;
  const vx = DIR_VECS[tank.dir][0];
  const horizontal = vx !== 0;
  const sign = horizontal ? vx : DIR_VECS[tank.dir][1];

  for (const t of state.tanks) {
    if (!isLivePlayer(t)) continue;
    if (aimsAt(cx, cy, t.x + HALF_TANK, t.y + HALF_TANK, horizontal, sign)) {
      return true;
    }
  }
  return (
    state.eagleAlive && aimsAt(cx, cy, EAGLE_CX, EAGLE_CY, horizontal, sign)
  );
}

function aimsAt(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  horizontal: boolean,
  sign: number,
): boolean {
  const lateral = horizontal ? Math.abs(ty - cy) : Math.abs(tx - cx);
  if (lateral > AI_ALIGN_TOLERANCE) return false;
  const along = horizontal ? tx - cx : ty - cy;
  return along * sign > 0;
}
