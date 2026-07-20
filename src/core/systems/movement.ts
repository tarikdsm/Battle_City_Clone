// src/core/systems/movement.ts — tank movement (fidelity spec §4): turn-snap,
// swept blocking against border/terrain/eagle/tanks, and ice slide. This is the
// first system that mutates simulation state each tick, so it is written to be
// allocation-free in steady state — the only per-tick "scratch" is plain numbers.
//
// `moveTank` is the reusable per-tank routine (steps 2–5 below); the AI task
// drives enemies through it later. `movementSystem` snapshots prevX/prevY for
// every tank, then applies `moveTank` to the player tanks from their intents.
import {
  ENEMY_SPEED,
  FIELD_SUBCELLS,
  FIELD_U,
  ICE_DECEL,
  PLAYER_SPEED,
  SUBCELL,
  TICK_S,
  TILE,
  TANK_SIZE,
  EAGLE_TILE,
} from '../constants';
import { snap8, subcellIndex } from '../grid';
import {
  DIR_VECS,
  Terrain,
  type Dir,
  type GameState,
  type PlayerIntent,
  type Tank,
} from '../types';

// --- Tank factory ---------------------------------------------------------

// Build a Tank from the minimum required fields, filling every other field with
// its canonical default. prevX/prevY default to the spawn position so a tank
// that never moves interpolates to itself.
export function makeTank(
  init: Partial<Tank> & Pick<Tank, 'id' | 'kind' | 'x' | 'y'>,
): Tank {
  return {
    alive: true,
    dir: 0,
    moving: false,
    sliding: false,
    slideV: 0,
    hp: 1,
    tier: 0,
    shieldT: 0,
    stunT: 0,
    frozenT: 0,
    spawningT: 0,
    bulletsAirborne: 0,
    prevX: init.x,
    prevY: init.y,
    ...init,
  };
}

// --- Per-tank movement ----------------------------------------------------

export function moveTank(
  state: GameState,
  tank: Tank,
  wantDir: Dir | null,
  dt: number,
): void {
  // Disabled tanks hold still (and are not "moving" for interpolation/anim).
  if (
    !tank.alive ||
    tank.spawningT > 0 ||
    tank.stunT > 0 ||
    tank.frozenT > 0
  ) {
    tank.moving = false;
    return;
  }

  const speed = speedOf(tank);

  // Step 2 — facing & turn snap. A 90 deg (axis-changing) turn snaps the tank's
  // coordinate on the FORMER movement axis to the nearest subcell boundary; a
  // 180 deg reversal keeps the same axis and does not snap.
  if (wantDir !== null && wantDir !== tank.dir) {
    const formerHorizontal = DIR_VECS[tank.dir][0] !== 0;
    const newHorizontal = DIR_VECS[wantDir][0] !== 0;
    if (formerHorizontal !== newHorizontal) {
      if (formerHorizontal) tank.x = snap8(tank.x);
      else tank.y = snap8(tank.y);
    }
    tank.dir = wantDir;
  }

  if (wantDir !== null) {
    // Step 3 — driven move. Directional input always overrides an active slide.
    tank.sliding = false;
    tank.slideV = 0;
    const moved = sweptMove(state, tank, tank.dir, speed * dt);
    tank.x += DIR_VECS[tank.dir][0] * moved;
    tank.y += DIR_VECS[tank.dir][1] * moved;
    tank.moving = moved > 0;
  } else {
    // Step 4 — no input: slide on ice, else stop. A slide already in progress
    // continues even off the ice (momentum carries off the patch); a new slide
    // starts only when the tank moved last tick and is currently on ice.
    if (tank.sliding || (tank.moving && onIce(state, tank))) {
      if (!tank.sliding) {
        tank.sliding = true;
        tank.slideV = speed;
        state.events.push({ t: 'iceSkidStarted', tankId: tank.id });
      }
      const desired = tank.slideV * dt;
      const moved = sweptMove(state, tank, tank.dir, desired);
      tank.x += DIR_VECS[tank.dir][0] * moved;
      tank.y += DIR_VECS[tank.dir][1] * moved;
      tank.slideV = Math.max(0, tank.slideV - ICE_DECEL * dt);
      if (tank.slideV === 0 || moved < desired) {
        // Ran out of momentum or hit an obstacle — come to rest.
        tank.sliding = false;
        tank.slideV = 0;
        tank.moving = false;
      } else {
        tank.moving = moved > 0;
      }
    } else {
      tank.moving = false;
    }
  }

  // Step 5 — trees event: fire once when the tank's center first enters a Trees
  // tile (relative to where its center was at the start of the tick).
  if (
    centerKind(state, tank.x, tank.y) === Terrain.Trees &&
    centerKind(state, tank.prevX, tank.prevY) !== Terrain.Trees
  ) {
    state.events.push({ t: 'treeEntered', tankId: tank.id });
  }
}

// --- System ---------------------------------------------------------------

export function movementSystem(
  state: GameState,
  intents: readonly [PlayerIntent, PlayerIntent],
): void {
  // Snapshot the previous position of EVERY tank first (interpolation contract),
  // so no tank's move this tick pollutes another tank's prev reference.
  for (const t of state.tanks) {
    t.prevX = t.x;
    t.prevY = t.y;
  }
  // Then move the player tanks from their intents (enemies move via the AI
  // system in a later task).
  for (const t of state.tanks) {
    if (t.kind !== 'player' || t.playerIndex === undefined) continue;
    moveTank(state, t, intents[t.playerIndex].dir, TICK_S);
  }
}

// --- Internals ------------------------------------------------------------

function speedOf(tank: Tank): number {
  if (tank.kind === 'enemy' && tank.enemyType !== undefined) {
    return ENEMY_SPEED[tank.enemyType];
  }
  return PLAYER_SPEED;
}

// True when any subcell under the tank's center 8x8 box is ice (spec §4).
function onIce(state: GameState, tank: Tank): boolean {
  const off = (TANK_SIZE - SUBCELL) / 2; // center-box inset = 4u
  const ax = tank.x + off;
  const ay = tank.y + off;
  const sxMin = Math.max(0, Math.floor(ax / SUBCELL));
  const syMin = Math.max(0, Math.floor(ay / SUBCELL));
  const sxMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((ax + SUBCELL) / SUBCELL) - 1);
  const syMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((ay + SUBCELL) / SUBCELL) - 1);
  for (let sy = syMin; sy <= syMax; sy++) {
    for (let sx = sxMin; sx <= sxMax; sx++) {
      if (state.terrain[subcellIndex(sx, sy)] === Terrain.Ice) return true;
    }
  }
  return false;
}

// Terrain kind of the subcell under the tank's center point.
function centerKind(state: GameState, x: number, y: number): number {
  const cx = x + TANK_SIZE / 2;
  const cy = y + TANK_SIZE / 2;
  const sx = Math.min(FIELD_SUBCELLS - 1, Math.max(0, Math.floor(cx / SUBCELL)));
  const sy = Math.min(FIELD_SUBCELLS - 1, Math.max(0, Math.floor(cy / SUBCELL)));
  return state.terrain[subcellIndex(sx, sy)];
}

// Distance (<= dist) the tank may travel along `dir` before its 16x16 AABB would
// strictly overlap any blocker. Movement is single-axis, so this reduces to a 1D
// clamp against each obstacle that overlaps the tank on the perpendicular axis.
function sweptMove(
  state: GameState,
  tank: Tank,
  dir: Dir,
  dist: number,
): number {
  if (dist <= 0) return 0;

  const vx = DIR_VECS[dir][0];
  const vy = DIR_VECS[dir][1];
  const horizontal = vx !== 0;
  const sign = horizontal ? vx : vy; // +1 forward, -1 backward on the move axis
  const p = horizontal ? tank.x : tank.y; // tank's top-left on the move axis
  const qLo = horizontal ? tank.y : tank.x; // tank span on the perpendicular axis
  const qHi = qLo + TANK_SIZE;

  let allowed = dist;

  // Field border.
  if (sign > 0) {
    const lim = FIELD_U - TANK_SIZE - p;
    if (lim < allowed) allowed = lim;
  } else if (p < allowed) {
    allowed = p;
  }
  if (allowed <= 0) return 0;

  // Terrain subcells overlapping the swept region.
  const dx = vx * dist;
  const dy = vy * dist;
  const regionX = Math.min(tank.x, tank.x + dx);
  const regionY = Math.min(tank.y, tank.y + dy);
  const regionW = TANK_SIZE + Math.abs(dx);
  const regionH = TANK_SIZE + Math.abs(dy);
  const sxMin = Math.max(0, Math.floor(regionX / SUBCELL));
  const syMin = Math.max(0, Math.floor(regionY / SUBCELL));
  const sxMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((regionX + regionW) / SUBCELL) - 1);
  const syMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((regionY + regionH) / SUBCELL) - 1);
  for (let sy = syMin; sy <= syMax; sy++) {
    for (let sx = sxMin; sx <= sxMax; sx++) {
      const kind = state.terrain[subcellIndex(sx, sy)];
      if (kind === Terrain.Brick || kind === Terrain.Steel || kind === Terrain.Water) {
        allowed = clampToObstacle(
          horizontal, sign, p, qLo, qHi,
          sx * SUBCELL, sy * SUBCELL, SUBCELL, SUBCELL, allowed,
        );
      }
    }
  }

  // Eagle (a static 16x16 tile-sized blocker) while it is alive.
  if (state.eagleAlive) {
    allowed = clampToObstacle(
      horizontal, sign, p, qLo, qHi,
      EAGLE_TILE[0] * TILE, EAGLE_TILE[1] * TILE, TILE, TILE, allowed,
    );
  }

  // Other alive, materialized tanks (spawning tanks have no hitbox yet).
  for (const other of state.tanks) {
    if (other === tank || !other.alive || other.spawningT > 0) continue;
    allowed = clampToObstacle(
      horizontal, sign, p, qLo, qHi,
      other.x, other.y, TANK_SIZE, TANK_SIZE, allowed,
    );
  }

  return allowed > 0 ? allowed : 0;
}

// Reduce `allowed` so the tank stops flush against one obstacle AABB. Returns the
// input unchanged when the obstacle does not overlap on the perpendicular axis or
// lies behind the tank's direction of travel. Pure numeric — no allocation.
function clampToObstacle(
  horizontal: boolean,
  sign: number,
  p: number,
  qLo: number,
  qHi: number,
  ox: number,
  oy: number,
  ow: number,
  oh: number,
  allowed: number,
): number {
  const moveLo = horizontal ? ox : oy;
  const moveHi = horizontal ? ox + ow : oy + oh;
  const perpLo = horizontal ? oy : ox;
  const perpHi = horizontal ? oy + oh : ox + ow;

  // Strict overlap on the perpendicular axis (flush edges do not block).
  if (!(qLo < perpHi && perpLo < qHi)) return allowed;

  if (sign > 0) {
    // Moving forward: only obstacles ahead of the leading edge constrain us.
    if (moveLo >= p + TANK_SIZE) {
      const lim = moveLo - (p + TANK_SIZE);
      if (lim < allowed) return lim;
    }
  } else if (moveHi <= p) {
    // Moving backward: only obstacles behind the leading (top/left) edge.
    const lim = p - moveHi;
    if (lim < allowed) return lim;
  }
  return allowed;
}
