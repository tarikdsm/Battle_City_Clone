// src/input/keyboard.ts — the DOM-free half of the keyboard driver (arch §7).
//
// It turns a stream of *bound key codes going down and up* into the two
// `PlayerIntent`s the simulation consumes, and it knows nothing about events,
// listeners or the browser. `input.ts` is the thin adapter that feeds it.
//
// The three rules that make the output *feel* right — the 4-way latch, the
// turbo pulse and the sub-tick press latch — are **not here**. They moved to
// `latch.ts` at T9.1, because GDD §7 gives the same job to a gamepad and to a
// touch stick, and "identical semantics" is a promise no amount of care keeps
// when it is written out three times. This file's whole remaining job is the
// reverse binding map: which key code is whose, and which action.

import type { Dir, PlayerIntent } from '../core/types';
import { createIntents, createPad, type InputPad } from './latch';

export { TURBO_HZ, TURBO_PERIOD_TICKS } from './latch';

/**
 * The action vocabulary a bindings map may use. Anything else in the map is
 * ignored rather than rejected: `bc.settings.v1` stores a free-form
 * `Record<string, string>` (storage.ts) and a stale key from an older build
 * must not cost the player their whole layout.
 *
 * `fireAlt` exists because GDD §7 gives P2 two fire keys (Numpad 0 and Right
 * Ctrl). It is a second binding for the same intent field, not a second button.
 */
export type InputAction =
  'up' | 'right' | 'down' | 'left' | 'fire' | 'fireAlt' | 'pause';

/** Per player: action → `KeyboardEvent.code`. Layout-independent by design. */
export interface Bindings {
  p1: Record<string, string>;
  p2: Record<string, string>;
}

/** Direction actions, in `Dir` order (types.ts: 0 Up, 1 Right, 2 Down, 3 Left). */
const DIR_OF_ACTION: Readonly<Record<string, Dir | undefined>> = Object.freeze({
  up: 0,
  right: 1,
  down: 2,
  left: 3,
});

const P1_DEFAULTS: Record<string, string> = {
  up: 'KeyW',
  left: 'KeyA',
  down: 'KeyS',
  right: 'KeyD',
  fire: 'KeyJ',
  // GDD §7 gives Esc *and* P to both players. The core toggles pause on a press
  // edge from EITHER intent slot and coalesces a same-tick double press into one
  // toggle (`stepGame`), so one key per slot is exactly equivalent to two keys
  // per player — and it keeps the map one-code-per-action, which is what a
  // remapping UI can actually present.
  pause: 'Escape',
};

const P2_DEFAULTS: Record<string, string> = {
  up: 'ArrowUp',
  left: 'ArrowLeft',
  down: 'ArrowDown',
  right: 'ArrowRight',
  fire: 'Numpad0',
  fireAlt: 'ControlRight',
  pause: 'KeyP',
};

/**
 * GDD §7's table. Frozen at both levels: this object is handed to every
 * `createInput` call that does not override it, and a driver that wrote into it
 * would corrupt the defaults for the rest of the session.
 */
export const DEFAULT_BINDINGS: Bindings = Object.freeze({
  p1: Object.freeze(P1_DEFAULTS),
  p2: Object.freeze(P2_DEFAULTS),
});

/**
 * The reducer. `down`/`up` return whether the code was bound, which is the
 * caller's cue to `preventDefault` — an unbound key (F5, Tab, the devtools
 * chord) must reach the page untouched.
 */
export interface Keyboard {
  down(code: string): boolean;
  up(code: string): boolean;
  /** Forget every held key. Focus loss, screen change, dispose. */
  clear(): void;
  /** The intents for the tick that is about to run. Called once per tick. */
  poll(): readonly [PlayerIntent, PlayerIntent];
}

interface Binding {
  readonly pad: 0 | 1;
  readonly action: InputAction;
}

function isAction(action: string): action is InputAction {
  return (
    DIR_OF_ACTION[action] !== undefined ||
    action === 'fire' ||
    action === 'fireAlt' ||
    action === 'pause'
  );
}

/**
 * @param onPadUsed called with a player slot whenever a key bound to it goes
 *                  down. GDD §7's hot-plug rule needs to know whether a player
 *                  is *at the keyboard* before it can decide which slot a pad
 *                  that arrives later should take, and this is the only place in
 *                  the app that knows the answer.
 */
export function createKeyboard(
  bindings: Bindings,
  onPadUsed?: (slot: 0 | 1) => void,
): Keyboard {
  // Built once, from a snapshot: the caller's map is never read again, so a
  // settings screen editing its own object cannot change a live game's controls
  // half way through a stage. A code may legitimately appear more than once
  // (the same key bound for both players), hence a list per code.
  const byCode = new Map<string, Binding[]>();
  const addSide = (pad: 0 | 1, map: Record<string, string>): void => {
    for (const [action, code] of Object.entries(map)) {
      if (typeof code !== 'string' || code.length === 0 || !isAction(action)) {
        continue;
      }
      const list = byCode.get(code);
      if (list === undefined) {
        byCode.set(code, [{ pad, action }]);
      } else {
        list.push({ pad, action });
      }
    }
  };
  addSide(0, bindings.p1);
  addSide(1, bindings.p2);

  // The codes currently down. This — not the OS — is what makes auto-repeat a
  // no-op: the browser re-fires `keydown` for a held key, and re-pushing an
  // already-latched direction would be harmless, but re-pushing the OLDER one
  // (which some platforms do on a chord) would silently invert the latch.
  const held = new Set<string>();
  const pads: readonly [InputPad, InputPad] = [createPad(), createPad()];

  // Reused every tick: `poll` allocates nothing (arch §11 — steady state).
  const intents: [PlayerIntent, PlayerIntent] = createIntents();

  function applyDown(pad: InputPad, action: InputAction): void {
    const dir = DIR_OF_ACTION[action];
    if (dir !== undefined) {
      pad.pressDir(dir);
      return;
    }
    if (action === 'pause') {
      pad.pressPause();
      return;
    }
    pad.pressFire();
  }

  function applyUp(pad: InputPad, action: InputAction): void {
    const dir = DIR_OF_ACTION[action];
    if (dir !== undefined) {
      pad.releaseDir(dir);
      return;
    }
    if (action === 'pause') {
      pad.releasePause();
      return;
    }
    pad.releaseFire();
  }

  return {
    down(code: string): boolean {
      const list = byCode.get(code);
      if (list === undefined) {
        return false;
      }
      if (held.has(code)) {
        return true; // auto-repeat: bound (so still preventDefault'd), no change
      }
      held.add(code);
      for (const b of list) {
        applyDown(pads[b.pad], b.action);
        // "The keyboard is playing this slot" (GDD §7's hot-plug rule). Reported
        // on every press rather than only the first: it is a cheap idempotent
        // flag, and a driver rebuilt mid-run by a rebind would otherwise start
        // life having forgotten who is at the keys.
        onPadUsed?.(b.pad);
      }
      return true;
    },

    up(code: string): boolean {
      const list = byCode.get(code);
      if (list === undefined) {
        return false;
      }
      // `delete` returns false when the key was never down — the keyup the
      // browser delivers after a blur that already cleared everything.
      if (!held.delete(code)) {
        return true;
      }
      for (const b of list) {
        applyUp(pads[b.pad], b.action);
      }
      return true;
    },

    clear(): void {
      held.clear();
      pads[0].reset();
      pads[1].reset();
    },

    poll(): readonly [PlayerIntent, PlayerIntent] {
      pads[0].drain(intents[0]);
      pads[1].drain(intents[1]);
      return intents;
    },
  };
}
