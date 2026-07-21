// src/core/systems/bullets.ts — firing (system #5) and bullet advance + the full
// interaction matrix (system #6), per fidelity spec §5–§6. This is the combat
// heart of the simulation; the collision ORDER below is canonical and covered by
// golden-replay tests, so it must not be reordered:
//
//   1. advance every alive bullet (swept AABB = union of old+new box)
//   2. bullet vs bullet   (player/enemy + player/player cancel; enemy/enemy pass)
//   3. bullet vs tank      (array order; a consumed bullet skips step 4 entirely)
//   4. bullet vs terrain / eagle / border (nearest obstacle along travel wins)
//
// Written allocation-free in steady state: the bullet pool grows lazily and
// reuses dead slots, and all per-tick geometry uses the two module-level scratch
// AABBs below (never a fresh object).
import {
  BULLET_FAST,
  BULLET_SIZE,
  BULLET_SLOW,
  EAGLE_TILE,
  FIELD_SUBCELLS,
  FIELD_U,
  SCORE,
  STUN_S,
  SUBCELL,
  TANK_SIZE,
  TICK_S,
  TILE,
} from '../constants';
import { aabbOverlap, subcellIndex, type Aabb } from '../grid';
import {
  DIR_VECS,
  Terrain,
  type Bullet,
  type GameState,
  type PlayerIntent,
  type Tank,
} from '../types';

type Intents = readonly [PlayerIntent, PlayerIntent];

// Near/far brick-and-steel subcell pairs to clear, indexed by Dir (Up,Right,
// Down,Left). Bits: 1=TL, 2=TR, 4=BL, 8=BR (the partial-tile convention shared
// with game.ts). A bullet removes the pair on its impacted face (perpendicular to
// travel): Right->west column (1|4=5), Left->east (2|8=10), Down->north row
// (1|2=3), Up->south row (4|8=12). The far pair is the opposite face.
const NEAR_PAIR: readonly number[] = [12, 5, 3, 10];
const FAR_PAIR: readonly number[] = [3, 10, 12, 5];

// Obstacle discriminants for the step-4 nearest-wins scan (no allocation).
const NONE = 0;
const BORDER = 1;
const EAGLE = 2;
const STEEL = 3;
const BRICK = 4;

// Module-level scratch — reused every tick so the hot path never allocates.
const boxA: Aabb = { x: 0, y: 0, w: 0, h: 0 };
const boxB: Aabb = { x: 0, y: 0, w: 0, h: 0 };

// --- Public API ------------------------------------------------------------

// Spawn a bullet for `tank` if every firing gate is open (alive, materialized,
// not stunned/frozen, below its airborne cap). Returns whether it fired. Shared
// by firingSystem (players, edge-triggered) and the AI task (enemies) later.
export function tryFire(state: GameState, tank: Tank): boolean {
  if (!tank.alive || tank.spawningT > 0 || tank.stunT > 0 || tank.frozenT > 0) {
    return false;
  }
  if (tank.bulletsAirborne >= fireCap(tank)) return false;
  spawnBullet(state, tank);
  return true;
}

// System #5. Players only: fire on the press edge (fire && !fireHeld), then latch
// fireHeld = intent.fire for BOTH player tanks every tick — unconditionally, even
// when dead or stunned, so edge tracking never desynchronizes from the input.
export function firingSystem(state: GameState, intents: Intents): void {
  for (const t of state.tanks) {
    if (t.kind !== 'player' || t.playerIndex === undefined) continue;
    const intent = intents[t.playerIndex];
    if (intent.fire && !t.fireHeld) tryFire(state, t);
    t.fireHeld = intent.fire;
  }
}

// System #6. Advance bullets and resolve the interaction matrix in canonical order.
export function bulletsSystem(state: GameState, intents: Intents): void {
  void intents;
  const bullets = state.bullets;

  // 1 — advance (record prev for the swept box, then step along dir).
  for (const b of bullets) {
    if (!b.alive) continue;
    b.prevX = b.x;
    b.prevY = b.y;
    const dist = b.speed * TICK_S;
    b.x += DIR_VECS[b.dir][0] * dist;
    b.y += DIR_VECS[b.dir][1] * dist;
  }

  // 2 — bullet vs bullet (ascending slot pairs; only enemy/enemy pass through).
  for (let i = 0; i < bullets.length; i++) {
    const a = bullets[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < bullets.length; j++) {
      const c = bullets[j];
      if (!c.alive) continue;
      if (!a.byPlayer && !c.byPlayer) continue; // enemy vs enemy: pass through
      fillSweptBox(boxA, a);
      fillSweptBox(boxB, c);
      if (!aabbOverlap(boxA, boxB)) continue;
      const mx = (Math.max(boxA.x, boxB.x) + Math.min(boxA.x + boxA.w, boxB.x + boxB.w)) / 2;
      const my = (Math.max(boxA.y, boxB.y) + Math.min(boxA.y + boxA.h, boxB.y + boxB.h)) / 2;
      killBullet(state, a);
      killBullet(state, c);
      state.events.push({ t: 'bulletsCanceled', x: mx, y: my });
      break; // a is dead — stop pairing it
    }
  }

  // 3 — bullet vs tank (a bullet consumed here never reaches step 4).
  for (const b of bullets) {
    if (b.alive) resolveBulletVsTanks(state, b);
  }

  // 4 — bullet vs terrain / eagle / border.
  for (const b of bullets) {
    if (b.alive) resolveBulletVsTerrain(state, b);
  }
}

// --- Firing internals ------------------------------------------------------

function fireCap(tank: Tank): number {
  if (tank.kind === 'player') return tank.tier >= 2 ? 2 : 1;
  return 1;
}

function bulletSpeedFor(tank: Tank): number {
  if (tank.kind === 'player') return tank.tier >= 1 ? BULLET_FAST : BULLET_SLOW;
  return tank.enemyType === 'power' ? BULLET_FAST : BULLET_SLOW;
}

function spawnBullet(state: GameState, tank: Tank): void {
  const dir = tank.dir;
  const cx = tank.x + TANK_SIZE / 2;
  const cy = tank.y + TANK_SIZE / 2;
  // Bullet top-left = tank-centre + half-tank along dir - half-bullet, i.e. the
  // 4x4 bullet centred on the midpoint of the tank's leading edge. The
  // perpendicular term reduces to the fixed (TANK_SIZE-BULLET_SIZE)/2 = 6u inset.
  const bx = cx + DIR_VECS[dir][0] * (TANK_SIZE / 2) - BULLET_SIZE / 2;
  const by = cy + DIR_VECS[dir][1] * (TANK_SIZE / 2) - BULLET_SIZE / 2;
  const byPlayer = tank.kind === 'player';

  const b = acquireBulletSlot(state);
  b.alive = true;
  b.x = bx;
  b.y = by;
  b.prevX = bx;
  b.prevY = by;
  b.dir = dir;
  b.speed = bulletSpeedFor(tank);
  b.fromTankId = tank.id;
  b.byPlayer = byPlayer;
  b.playerIndex = byPlayer ? tank.playerIndex : undefined;
  b.canHurtSteel = byPlayer && tank.tier === 3;

  tank.bulletsAirborne++;
  state.events.push({ t: 'shotFired', tankId: tank.id, x: bx, y: by, dir, byPlayer });
}

// Reuse the first dead slot, else append. `id` == slot index and is stable for
// a slot's whole life (reuse across lifetimes is fine and deterministic).
function acquireBulletSlot(state: GameState): Bullet {
  for (const b of state.bullets) {
    if (!b.alive) return b;
  }
  const b: Bullet = {
    id: state.bullets.length,
    alive: false,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    dir: 0,
    speed: 0,
    fromTankId: -1,
    byPlayer: false,
    playerIndex: undefined,
    canHurtSteel: false,
  };
  state.bullets.push(b);
  return b;
}

// --- Collision internals ---------------------------------------------------

// Kill a bullet and refund its owner's airborne count (owner may be dead but is
// still in the array; if it is truly gone, skip — nothing to decrement).
function killBullet(state: GameState, b: Bullet): void {
  b.alive = false;
  const owner = findTank(state, b.fromTankId);
  if (owner !== undefined) {
    owner.bulletsAirborne = Math.max(0, owner.bulletsAirborne - 1);
  }
}

function findTank(state: GameState, id: number): Tank | undefined {
  for (const t of state.tanks) {
    if (t.id === id) return t;
  }
  return undefined;
}

// The swept AABB for this tick: the union of the bullet's old and new 4x4 box.
function fillSweptBox(box: Aabb, b: Bullet): void {
  const x0 = Math.min(b.prevX, b.x);
  const y0 = Math.min(b.prevY, b.y);
  box.x = x0;
  box.y = y0;
  box.w = Math.max(b.prevX, b.x) + BULLET_SIZE - x0;
  box.h = Math.max(b.prevY, b.y) + BULLET_SIZE - y0;
}

function resolveBulletVsTanks(state: GameState, b: Bullet): void {
  fillSweptBox(boxA, b);
  for (const tank of state.tanks) {
    if (tank.id === b.fromTankId || !tank.alive || tank.spawningT > 0) continue;
    boxB.x = tank.x;
    boxB.y = tank.y;
    boxB.w = TANK_SIZE;
    boxB.h = TANK_SIZE;
    if (!aabbOverlap(boxA, boxB)) continue;

    if (b.byPlayer) {
      if (tank.kind === 'enemy') {
        // Player bullet vs enemy: damage. Carrier power-up drop is T1.5's job.
        tank.hp -= 1;
        if (tank.hp > 0) {
          state.events.push({ t: 'tankHit', tankId: tank.id, hpLeft: tank.hp });
        } else {
          tank.alive = false;
          state.events.push({
            t: 'tankDestroyed',
            tankId: tank.id,
            kind: 'enemy',
            enemyType: tank.enemyType,
            byPlayerIndex: b.playerIndex,
            points: tank.enemyType === undefined ? 0 : SCORE[tank.enemyType],
            x: b.x,
            y: b.y,
          });
        }
      } else {
        // Player bullet vs the other player: stun, never damage; cancel its slide.
        tank.stunT = STUN_S;
        tank.sliding = false;
        tank.slideV = 0;
        if (tank.playerIndex !== undefined) {
          state.events.push({
            t: 'playerStunned',
            playerIndex: tank.playerIndex,
            durS: STUN_S,
          });
        }
      }
      killBullet(state, b);
      return;
    }

    // Enemy bullet.
    if (tank.kind === 'player') {
      if (tank.shieldT > 0) {
        killBullet(state, b);
        state.events.push({ t: 'bulletDespawned', x: b.x, y: b.y, reason: 'hit' });
        return;
      }
      tank.hp -= 1;
      if (tank.hp <= 0) {
        tank.alive = false;
        state.events.push({
          t: 'tankDestroyed',
          tankId: tank.id,
          kind: 'player',
          points: 0,
          x: b.x,
          y: b.y,
        });
      }
      killBullet(state, b);
      return;
    }
    // Enemy bullet vs enemy tank: pass through (no friendly fire) — keep scanning.
  }
}

function resolveBulletVsTerrain(state: GameState, b: Bullet): void {
  fillSweptBox(boxA, b);
  const dir = b.dir;
  const horizontal = DIR_VECS[dir][0] !== 0;
  const forward = (horizontal ? DIR_VECS[dir][0] : DIR_VECS[dir][1]) > 0;

  let bestKind = NONE;
  let bestFace = forward ? Infinity : -Infinity;
  let bestSubTravel = -1; // subcell index on the travel axis of the winning cell

  // Terrain subcells strictly overlapping the swept box.
  const sxMin = Math.max(0, Math.floor(boxA.x / SUBCELL));
  const syMin = Math.max(0, Math.floor(boxA.y / SUBCELL));
  const sxMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((boxA.x + boxA.w) / SUBCELL) - 1);
  const syMax = Math.min(FIELD_SUBCELLS - 1, Math.ceil((boxA.y + boxA.h) / SUBCELL) - 1);
  for (let sy = syMin; sy <= syMax; sy++) {
    for (let sx = sxMin; sx <= sxMax; sx++) {
      const kind = state.terrain[subcellIndex(sx, sy)];
      if (kind !== Terrain.Brick && kind !== Terrain.Steel) continue;
      boxB.x = sx * SUBCELL;
      boxB.y = sy * SUBCELL;
      boxB.w = SUBCELL;
      boxB.h = SUBCELL;
      if (!aabbOverlap(boxA, boxB)) continue;
      const face = horizontal
        ? forward
          ? boxB.x
          : boxB.x + SUBCELL
        : forward
          ? boxB.y
          : boxB.y + SUBCELL;
      if (forward ? face < bestFace : face > bestFace) {
        bestFace = face;
        bestKind = kind === Terrain.Steel ? STEEL : BRICK;
        bestSubTravel = horizontal ? sx : sy;
      }
    }
  }

  // Eagle (16x16 tile blocker) while it stands.
  if (state.eagleAlive) {
    boxB.x = EAGLE_TILE[0] * TILE;
    boxB.y = EAGLE_TILE[1] * TILE;
    boxB.w = TILE;
    boxB.h = TILE;
    if (aabbOverlap(boxA, boxB)) {
      const face = horizontal
        ? forward
          ? boxB.x
          : boxB.x + TILE
        : forward
          ? boxB.y
          : boxB.y + TILE;
      if (forward ? face < bestFace : face > bestFace) {
        bestFace = face;
        bestKind = EAGLE;
      }
    }
  }

  // Field border (only when the leading edge actually crossed out of bounds).
  const lead = leadingEdge(b, horizontal, forward);
  const borderFace = forward ? FIELD_U : 0;
  if ((forward && lead > FIELD_U) || (!forward && lead < 0)) {
    if (forward ? borderFace < bestFace : borderFace > bestFace) {
      bestFace = borderFace;
      bestKind = BORDER;
    }
  }

  if (bestKind === NONE) return; // nothing struck this tick

  // Reposition flush to the winning face (the impact/crossing point).
  if (horizontal) b.x = forward ? bestFace - BULLET_SIZE : bestFace;
  else b.y = forward ? bestFace - BULLET_SIZE : bestFace;

  if (bestKind === BORDER) {
    killBullet(state, b);
    state.events.push({ t: 'bulletDespawned', x: b.x, y: b.y, reason: 'border' });
    return;
  }
  if (bestKind === EAGLE) {
    state.eagleAlive = false;
    state.phase = 'baseLost';
    state.phaseT = 0;
    killBullet(state, b);
    state.events.push({ t: 'baseDestroyed' });
    return;
  }

  // Brick / steel: impacted tile = travel-axis tile of the struck subcell, with
  // the perpendicular axis taken from the bullet's centre (matches the spec's
  // "tile containing the bullet's centre at impact" for straddle disambiguation).
  const travelTile = Math.floor(bestSubTravel / 2);
  const perpTile = horizontal
    ? Math.floor((b.y + BULLET_SIZE / 2) / TILE)
    : Math.floor((b.x + BULLET_SIZE / 2) / TILE);
  const tx = horizontal ? travelTile : perpTile;
  const ty = horizontal ? perpTile : travelTile;

  if (bestKind === STEEL) {
    const removedMask = b.canHurtSteel ? damageTile(state, tx, ty, Terrain.Steel, b) : 0;
    killBullet(state, b);
    state.events.push({
      t: 'steelHit',
      tx,
      ty,
      removedMask,
      destroyed: b.canHurtSteel,
      x: b.x,
      y: b.y,
      dir,
    });
    return;
  }

  // Brick.
  const removedMask = damageTile(state, tx, ty, Terrain.Brick, b);
  killBullet(state, b);
  state.events.push({ t: 'brickHit', tx, ty, removedMask, x: b.x, y: b.y, dir });
}

// The bullet's leading-edge coordinate along its travel axis (post-advance).
function leadingEdge(b: Bullet, horizontal: boolean, forward: boolean): number {
  if (horizontal) return forward ? b.x + BULLET_SIZE : b.x;
  return forward ? b.y + BULLET_SIZE : b.y;
}

// Clear subcells of tile (tx,ty) that still equal `kind`, returning the mask of
// bits actually removed. tier-3 brick removes ALL remaining subcells; otherwise
// the near pair (or the far pair when the near one is already fully gone).
function damageTile(
  state: GameState,
  tx: number,
  ty: number,
  kind: number,
  b: Bullet,
): number {
  const present = tileKindMask(state, tx, ty, kind);
  let removed: number;
  if (kind === Terrain.Brick && b.canHurtSteel) {
    removed = present; // tier-3 obliterates the whole brick tile
  } else {
    removed = NEAR_PAIR[b.dir] & present;
    if (removed === 0) removed = FAR_PAIR[b.dir] & present;
  }
  clearTileSubcells(state, tx, ty, removed);
  return removed;
}

function tileKindMask(state: GameState, tx: number, ty: number, kind: number): number {
  const sx = tx * 2;
  const sy = ty * 2;
  let m = 0;
  if (state.terrain[subcellIndex(sx, sy)] === kind) m |= 1;
  if (state.terrain[subcellIndex(sx + 1, sy)] === kind) m |= 2;
  if (state.terrain[subcellIndex(sx, sy + 1)] === kind) m |= 4;
  if (state.terrain[subcellIndex(sx + 1, sy + 1)] === kind) m |= 8;
  return m;
}

function clearTileSubcells(state: GameState, tx: number, ty: number, mask: number): void {
  const sx = tx * 2;
  const sy = ty * 2;
  if (mask & 1) state.terrain[subcellIndex(sx, sy)] = Terrain.Empty;
  if (mask & 2) state.terrain[subcellIndex(sx + 1, sy)] = Terrain.Empty;
  if (mask & 4) state.terrain[subcellIndex(sx, sy + 1)] = Terrain.Empty;
  if (mask & 8) state.terrain[subcellIndex(sx + 1, sy + 1)] = Terrain.Empty;
}
