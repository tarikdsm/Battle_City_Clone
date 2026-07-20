// src/core/events.ts — the exhaustive game-event union, discriminated on `t`.
// Core systems append these to GameState.events each tick; presentation/audio
// layers read them. Adding a case here is the contract for a new observable event.
import type { Dir, EnemyType, PowerupType } from './types';

export type GameEvent =
  | {
      t: 'shotFired';
      tankId: number;
      x: number;
      y: number;
      dir: Dir;
      byPlayer: boolean;
    }
  | { t: 'bulletsCanceled'; x: number; y: number }
  | { t: 'bulletDespawned'; x: number; y: number; reason: 'border' | 'hit' }
  | {
      t: 'brickHit';
      tx: number;
      ty: number;
      removedMask: number;
      x: number;
      y: number;
      dir: Dir;
    }
  | {
      t: 'steelHit';
      tx: number;
      ty: number;
      removedMask: number;
      destroyed: boolean;
      x: number;
      y: number;
      dir: Dir;
    }
  | { t: 'tankHit'; tankId: number; hpLeft: number }
  | {
      t: 'tankDestroyed';
      tankId: number;
      kind: 'player' | 'enemy';
      enemyType?: EnemyType;
      byPlayerIndex?: 0 | 1;
      points: number;
      x: number;
      y: number;
    }
  | { t: 'playerStunned'; playerIndex: 0 | 1; durS: number }
  | { t: 'playerSpawned'; playerIndex: 0 | 1; x: number; y: number }
  | {
      t: 'enemySpawnStarted';
      spawnOrdinal: number;
      x: number;
      y: number;
      enemyType: EnemyType;
      carrier: boolean;
    }
  | { t: 'enemySpawned'; tankId: number }
  | { t: 'powerupSpawned'; type: PowerupType; x: number; y: number }
  | {
      t: 'powerupCollected';
      type: PowerupType;
      playerIndex: 0 | 1;
      x: number;
      y: number;
    }
  | { t: 'tierChanged'; playerIndex: 0 | 1; tier: 0 | 1 | 2 | 3 }
  | { t: 'shovelPhase'; phase: 'steel' | 'blink' | 'revert' }
  | { t: 'clockStarted' }
  | { t: 'clockEnded' }
  | { t: 'grenadeUsed'; kills: number }
  | { t: 'extraLife'; playerIndex: 0 | 1 }
  | {
      t: 'scoreAwarded';
      playerIndex: 0 | 1;
      points: number;
      x: number;
      y: number;
    }
  | { t: 'iceSkidStarted'; tankId: number }
  | { t: 'treeEntered'; tankId: number }
  | { t: 'baseDestroyed' }
  | { t: 'stageCleared' }
  | { t: 'gameOver' }
  | { t: 'pauseToggled'; paused: boolean };
