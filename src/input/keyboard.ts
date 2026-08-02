// src/input/keyboard.ts — the DOM-free half of the keyboard driver (arch §7).
//
// It turns a stream of *bound key codes going down and up* into the two
// `PlayerIntent`s the simulation consumes, and it knows nothing about events,
// listeners or the browser. `input.ts` is the thin adapter that feeds it.
//
// Two rules here are feel-critical and neither is obvious from the type:
//
// 1. **The 4-way latch.** Battle City has no diagonals, and the NES resolves a
//    two-key hold as "the most recent press wins, and releasing it falls back to
//    whatever is still held". That is a *stack*, not a bitmask and not a
//    priority order — and it is what makes the standard move work: hold a
//    direction, tap another to peek down a corridor, release, keep going.
//
// 2. **The turbo pulse.** Fire is reported as a level and the core fires on the
//    press EDGE (fidelity §5.1), so a plain held level would fire exactly once
//    per hold. Autofire is therefore an input-layer job: the level is *pulsed*
//    at 10 Hz so the core's edge detector sees repeated presses, capped at what
//    a human mashing the button achieves on the NES. The period is counted in
//    TICKS, not milliseconds, because `poll()` is called once per simulation
//    tick — so the shot rate is identical on a 30 fps laptop and a 144 Hz
//    monitor, which a wall-clock pulse would not be.
//
// 3. **The press latch.** Every value above is a LEVEL sampled once per tick,
//    and a level has one failure mode: a key that goes down and up *between*
//    two polls was never down as far as the simulation is concerned. A 60 Hz
//    tick is 16.7 ms, and a fast tap is not much longer — so the driver latches
//    a press the moment it arrives and holds it until the next `poll()` reports
//    it. Without this, tapping fire quickly does nothing at all, which reads as
//    an unresponsive game and quietly undermines fidelity §5.1's press-edge
//    design: the core is waiting for an edge the driver already threw away.
//    (Found at T6.1/T6.2 — Playwright's synthetic presses land inside one tick
//    roughly half the time, and both the e2e suite and the capture script had
//    to hold keys for 90 ms to work around it. Fixed here instead.)

import type { Dir, PlayerIntent } from '../core/types';

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

/** Autofire rate while the fire key is held (fidelity §5.1). */
export const TURBO_HZ = 10;

/**
 * The turbo period in simulation ticks. 60 Hz / 10 Hz = 6, i.e. one pulse then
 * five released ticks. Written as a literal rather than derived from `TICK_S`
 * because arch §2 scopes `input/` to core *types*; `tests/input/keyboard.test.ts`
 * imports `TICK_S` and pins the arithmetic, so the two cannot drift silently.
 */
export const TURBO_PERIOD_TICKS = 6;

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

interface Pad {
  /** Held directions, oldest first — the LAST entry is the latched one. */
  readonly stack: Dir[];
  /** How many of this pad's fire codes are down (`fire` and `fireAlt`). */
  fireCodes: number;
  pauseCodes: number;
  /** Ticks left before the next turbo pulse; 0 = the next poll fires. */
  turbo: number;
  // --- the press latch (rule 3 in the header) -----------------------------
  // Each of these records "a press arrived since the last poll", and each is
  // cleared BY that poll. They only ever change the answer when the matching
  // level is already back to zero — i.e. exactly the sub-tick tap that would
  // otherwise vanish.
  /** A direction pressed since the last poll, even if already released. */
  tapDir: Dir | null;
  firePressed: boolean;
  pausePressed: boolean;
}

function makePad(): Pad {
  return {
    stack: [],
    fireCodes: 0,
    pauseCodes: 0,
    turbo: 0,
    tapDir: null,
    firePressed: false,
    pausePressed: false,
  };
}

function resetPad(pad: Pad): void {
  pad.stack.length = 0;
  pad.fireCodes = 0;
  pad.pauseCodes = 0;
  pad.turbo = 0;
  // Blur drops the latches too: a tap the player made on the way out of the
  // window must not fire a shot when they come back.
  pad.tapDir = null;
  pad.firePressed = false;
  pad.pausePressed = false;
}

function isAction(action: string): action is InputAction {
  return (
    DIR_OF_ACTION[action] !== undefined ||
    action === 'fire' ||
    action === 'fireAlt' ||
    action === 'pause'
  );
}

export function createKeyboard(bindings: Bindings): Keyboard {
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
  const pads: readonly [Pad, Pad] = [makePad(), makePad()];

  // Reused every tick: `poll` allocates nothing (arch §11 — steady state).
  const intents: [PlayerIntent, PlayerIntent] = [
    { dir: null, fire: false, pause: false },
    { dir: null, fire: false, pause: false },
  ];

  function applyDown(pad: Pad, action: InputAction): void {
    const dir = DIR_OF_ACTION[action];
    if (dir !== undefined) {
      pad.stack.push(dir);
      pad.tapDir = dir;
      return;
    }
    if (action === 'pause') {
      pad.pauseCodes++;
      pad.pausePressed = true;
      return;
    }
    pad.firePressed = true;
    pad.fireCodes++;
    if (pad.fireCodes === 1) {
      // A fresh press fires on the NEXT poll, whatever the pulse phase was.
      // Mashing therefore beats the turbo, exactly as on the NES, where the
      // only limit is the airborne-bullet cap.
      pad.turbo = 0;
    }
  }

  function applyUp(pad: Pad, action: InputAction): void {
    const dir = DIR_OF_ACTION[action];
    if (dir !== undefined) {
      const i = pad.stack.lastIndexOf(dir);
      if (i >= 0) {
        pad.stack.splice(i, 1);
      }
      return;
    }
    if (action === 'pause') {
      pad.pauseCodes = Math.max(0, pad.pauseCodes - 1);
      return;
    }
    pad.fireCodes = Math.max(0, pad.fireCodes - 1);
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
      resetPad(pads[0]);
      resetPad(pads[1]);
    },

    poll(): readonly [PlayerIntent, PlayerIntent] {
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        const intent = intents[i];

        // A still-held direction wins over a latched tap: the latch's promise
        // is "a press survives to the next poll", not "a tap overrides the key
        // you are holding". Releasing the tapped key already fell back through
        // the stack (rule 1), so the held key is the one still down.
        intent.dir =
          pad.stack.length > 0 ? pad.stack[pad.stack.length - 1] : pad.tapDir;
        pad.tapDir = null;

        intent.pause = pad.pauseCodes > 0 || pad.pausePressed;
        pad.pausePressed = false;

        if (pad.fireCodes === 0) {
          // Released — but report the tap if one came and went inside this
          // tick. The core sees a clean single-tick edge either way.
          intent.fire = pad.firePressed;
          pad.turbo = 0;
        } else if (pad.turbo <= 0) {
          intent.fire = true;
          pad.turbo = TURBO_PERIOD_TICKS - 1;
        } else {
          intent.fire = false;
          pad.turbo--;
        }
        pad.firePressed = false;
      }
      return intents;
    },
  };
}
