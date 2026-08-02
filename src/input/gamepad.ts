// src/input/gamepad.ts — the Standard Gamepad driver (GDD §7, arch §7).
//
// ## Why this is a hub and not one object per pad
//
// The Gamepad API is a **polled, process-wide** interface: `getGamepads()`
// answers with the live state of every pad attached to the page, and there is no
// per-pad subscription to own. Two readers would therefore not be two devices,
// they would be two copies of the same truth — and each would run its own
// hot-plug assignment, so plugging one pad in could hand it to P1 in the menus
// and to P2 on the board. So there is exactly one hub (see {@link sharedGamepads}),
// and everything that wants pad input reads it.
//
// ## Two clocks, and why `sample()` is not `poll()`
//
// - `sample()` reads the hardware and turns it into *edges*. It belongs to the
//   FRAME, and it is safe to call twice in one frame: the second call sees the
//   same levels and produces no new edges.
// - `poll()` drains one tick's worth of intent. It belongs to the 60 Hz
//   SIMULATION, and it is what advances the turbo pulse.
//
// Splitting them is what gives a polled device the same sub-tick press latch the
// keyboard got at T6.3: on a 144 Hz display the loop samples between two ticks,
// so a flick that lands entirely inside one tick is caught by a sample and held
// by the latch until the tick that follows asks for it. Sampling only inside
// `poll()` would throw exactly those presses away, which is the failure the
// keyboard already had and the reason both live on `latch.ts`.
//
// ## Hot-plug without the events
//
// `gamepadconnected` is deliberately not used. Chrome does not expose a pad —
// or fire the event — until the player presses a button on it, so the event adds
// nothing a diff of `getGamepads()` does not already give, and it would make the
// whole layer need a real `window` to be tested. Connection is therefore
// *observed*, once per sample, by comparing the connected set against the last
// one. That also means an `unplug` is noticed within one frame, which is what
// clears the direction a yanked pad was holding.

import type { Dir, PlayerIntent } from '../core/types';
import { createIntents, createPad, type InputPad } from './latch';

// ---------------------------------------------------------------------------
// The W3C Standard Gamepad, as data
// ---------------------------------------------------------------------------

/**
 * Button indices from the *standard mapping* (W3C Gamepad §3.4.1 layout),
 * named for the job GDD §7 gives them rather than for the plastic.
 *
 * The indices are the whole reason the mapping is called "standard": a pad that
 * reports `mapping: "standard"` has already been normalised by the browser, so
 * an Xbox pad and a DualSense both put the bottom face button at 0 and D-pad up
 * at 12. A pad that reports something else is read the same way anyway — see
 * {@link readPad} — because a wrong guess costs a wrong button while refusing
 * costs the player their controller.
 */
export const BUTTON = Object.freeze({
  /** A / Cross — GDD §7's fire, and confirm in the menus. */
  fire: 0,
  /** B / Circle — back in the menus. */
  back: 1,
  /** Select / Share / View — back, for pads whose B is elsewhere. */
  select: 8,
  /** Start / Options — GDD §7's pause, and confirm in the menus. */
  start: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
});

/** Left stick axes. Y is **down-positive**, as `Dir` is. */
export const AXIS_X = 0;
export const AXIS_Y = 1;

/**
 * The stick dead zone (arch §7).
 *
 * Applied **radially**, to the magnitude of the whole vector, not per axis. A
 * per-axis test would swallow a genuine 45° push at half deflection — both
 * components of a 0.6-magnitude diagonal are 0.42, so one axis test passes and
 * the other does not, and which direction you get depends on noise. Radial asks
 * the only question that matters ("is the stick pushed?") and leaves the
 * *which* to the dominant axis.
 */
export const DEAD_ZONE = 0.4;

/** Cursor auto-repeat while a direction is held in a menu, in milliseconds. */
export const NAV_REPEAT_DELAY_MS = 400;
export const NAV_REPEAT_MS = 120;

/**
 * The six abstract navigation events (`ui/menus.ts`'s `NavEvent`).
 *
 * Declared here, and re-exported by `menus.ts`, so the vocabulary has one
 * definition without `input/` having to import `ui/` — which arch §2's layering
 * forbids in that direction.
 */
export type PadNavEvent = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';

// ---------------------------------------------------------------------------
// The seam: what a gamepad looks like from here
// ---------------------------------------------------------------------------

/** The two fields read off a `GamepadButton`; `GamepadButton` satisfies it. */
export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** The fields read off a `Gamepad`; the DOM's `Gamepad` satisfies it. */
export interface GamepadLike {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonLike[];
}

/**
 * Where pads come from. `navigator` in the game, a plain object in tests —
 * which is what lets `tests/input/gamepad.test.ts` drive the entire layer in the
 * node environment with no DOM at all.
 */
export interface GamepadProvider {
  getGamepads(): readonly (GamepadLike | null)[];
}

/** The slice of `Navigator` this needs. Optional: not every browser has it. */
export interface NavigatorLike {
  getGamepads?: () => readonly (Gamepad | null)[];
}

/**
 * Adapts a real `Navigator`, or returns `null` when the API is absent.
 *
 * A wrapper rather than passing `navigator` itself: `getGamepads` is a method
 * and needs its receiver, so an unbound reference throws "Illegal invocation".
 */
export function navigatorGamepads(nav: NavigatorLike): GamepadProvider | null {
  if (typeof nav.getGamepads !== 'function') {
    return null;
  }
  return {
    getGamepads(): readonly (GamepadLike | null)[] {
      return nav.getGamepads?.() ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// The pure part
// ---------------------------------------------------------------------------

/**
 * A stick vector as one of four directions, or `null` inside the dead zone.
 *
 * Dominant axis, no diagonals (GDD §7). An exact tie goes to the horizontal:
 * arbitrary, but *deterministic*, which is the property that matters — a tie
 * broken by floating-point noise would make a perfectly diagonal hold flicker
 * between two directions at 60 Hz.
 */
export function stickDir(
  x: number,
  y: number,
  deadZone: number = DEAD_ZONE,
): Dir | null {
  // `Math.hypot` rather than `x*x + y*y`: it is the same comparison and it does
  // not overflow on a driver that hands back a nonsense magnitude.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  if (Math.hypot(x, y) < deadZone) {
    return null;
  }
  if (Math.abs(x) >= Math.abs(y)) {
    return x >= 0 ? 1 : 3; // Right : Left
  }
  return y >= 0 ? 2 : 0; // Down : Up
}

/** One pad's buttons, reduced to the levels the rest of this file works in. */
interface PadLevels {
  /** D-pad direction, or `null`. Latched separately from the stick. */
  readonly dpad: Dir | null;
  /** Left-stick direction, or `null`. */
  readonly stick: Dir | null;
  readonly fire: boolean;
  readonly pause: boolean;
  /** Menu `confirm` — A or Start. */
  readonly confirm: boolean;
  /** Menu `back` — B or Select. */
  readonly back: boolean;
  /** Menu direction: whichever of the two is pushed. */
  readonly nav: Dir | null;
}

/**
 * Read one pad's levels.
 *
 * `mapping` is deliberately **not** required to be `"standard"`. Firefox
 * reports `"standard"` for the pads it knows and `""` for the rest, and a
 * `""` pad is usually still a normal controller with the standard layout — so
 * refusing it would tell a player their controller does not work when the worst
 * realistic outcome is that one button is somewhere else.
 */
function readPad(pad: GamepadLike): PadLevels {
  const down = (i: number): boolean => pad.buttons[i]?.pressed === true;
  const dpadDir = ((): Dir | null => {
    if (down(BUTTON.dpadUp)) return 0;
    if (down(BUTTON.dpadRight)) return 1;
    if (down(BUTTON.dpadDown)) return 2;
    if (down(BUTTON.dpadLeft)) return 3;
    return null;
  })();
  const stick = stickDir(pad.axes[AXIS_X] ?? 0, pad.axes[AXIS_Y] ?? 0);
  return {
    dpad: dpadDir,
    stick,
    fire: down(BUTTON.fire),
    pause: down(BUTTON.start),
    confirm: down(BUTTON.fire) || down(BUTTON.start),
    back: down(BUTTON.back) || down(BUTTON.select),
    nav: dpadDir ?? stick,
  };
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

export interface GamepadHub {
  /** Read the hardware and turn it into edges. Once per frame; idempotent. */
  sample(): void;
  /** The intents for the tick about to run. Once per tick. */
  poll(): readonly [PlayerIntent, PlayerIntent];
  /** Forget every held button, keeping the slot assignments. */
  clear(): void;
  /** "The keyboard is playing this slot" — see {@link GamepadHub.slotOf}. */
  noteKeyboard(slot: 0 | 1): void;
  /** Which player a connected pad drives, or `null` if it drives nobody. */
  slotOf(index: number): 0 | 1 | null;
  /**
   * Start recording navigation events, and return the release.
   *
   * Refcounted, and **off by default**: during a run nothing is listening, and
   * a hub that queued a nav event for every direction the player steered would
   * hand the pause menu a few hundred of them the moment it opened.
   */
  retainNav(): () => void;
  /** Take the navigation events recorded since the last call. */
  drainNav(): readonly PadNavEvent[];
  dispose(): void;
}

interface Slot {
  /** The `Gamepad.index` driving this player, or `null`. */
  padIndex: number | null;
  /** A bound key for this player has been pressed at least once. */
  keyboard: boolean;
  readonly pad: InputPad;
  /** The D-pad direction this slot's gamepad held at the last sample. */
  dpad: Dir | null;
  stick: Dir | null;
  fire: boolean;
  pause: boolean;
}

interface NavState {
  dir: Dir | null;
  /** When the current direction next repeats, in ms. */
  nextRepeat: number;
  confirm: boolean;
  back: boolean;
}

const NAV_OF_DIR: readonly PadNavEvent[] = ['up', 'right', 'down', 'left'];

/**
 * How many nav events may queue between drains.
 *
 * Recording is already gated on {@link GamepadHub.retainNav}, so this is a
 * second belt: a screen that mounts a retainer and then blocks its own rAF (an
 * `await` in a lazy screen, a long GC pause) must not accumulate a scroll of
 * cursor moves that all land at once.
 */
const NAV_QUEUE_MAX = 8;

export interface GamepadOptions {
  /** Clock for the nav auto-repeat. Injected in tests. */
  now?: () => number;
}

export function createGamepads(
  provider: GamepadProvider | null,
  opts?: GamepadOptions,
): GamepadHub {
  const now = opts?.now ?? ((): number => performance.now());

  const slots: readonly [Slot, Slot] = [makeSlot(), makeSlot()];
  const intents = createIntents();

  /** Per `Gamepad.index`, the nav edge state — every pad drives the cursor. */
  const nav = new Map<number, NavState>();
  const navQueue: PadNavEvent[] = [];
  let navRetainers = 0;
  let disposed = false;

  function makeSlot(): Slot {
    return {
      padIndex: null,
      keyboard: false,
      pad: createPad(),
      dpad: null,
      stick: null,
      fire: false,
      pause: false,
    };
  }

  function slotFor(index: number): Slot | null {
    if (slots[0].padIndex === index) return slots[0];
    if (slots[1].padIndex === index) return slots[1];
    return null;
  }

  /**
   * GDD §7: "first pad = P1 unless P1 uses keyboard, then it becomes P2".
   *
   * Two passes, and the second one matters: when *both* slots have been claimed
   * by the keyboard, a pad still has a human holding it, so it takes the first
   * slot without a pad rather than being silently ignored.
   */
  function assign(index: number): void {
    for (const wantFree of [true, false]) {
      for (const i of [0, 1] as const) {
        const slot = slots[i];
        if (slot.padIndex === null && (!wantFree || !slot.keyboard)) {
          slot.padIndex = index;
          return;
        }
      }
    }
    // A third pad: no slot, no input, no error. It still navigates menus.
  }

  function release(slot: Slot): void {
    slot.padIndex = null;
    slot.dpad = null;
    slot.stick = null;
    slot.fire = false;
    slot.pause = false;
    // A pad yanked out mid-move must not leave a direction held for ever.
    slot.pad.reset();
  }

  function pushNav(ev: PadNavEvent): void {
    if (navRetainers === 0) {
      return;
    }
    if (navQueue.length >= NAV_QUEUE_MAX) {
      navQueue.shift();
    }
    navQueue.push(ev);
  }

  /** Fold one pad's levels into its player slot's edges. */
  function applyLevels(slot: Slot, levels: PadLevels): void {
    slot.pad.moveDir(slot.dpad, levels.dpad);
    slot.dpad = levels.dpad;
    slot.pad.moveDir(slot.stick, levels.stick);
    slot.stick = levels.stick;

    if (levels.fire !== slot.fire) {
      slot.fire = levels.fire;
      if (levels.fire) {
        slot.pad.pressFire();
      } else {
        slot.pad.releaseFire();
      }
    }
    if (levels.pause !== slot.pause) {
      slot.pause = levels.pause;
      if (levels.pause) {
        slot.pad.pressPause();
      } else {
        slot.pad.releasePause();
      }
    }
  }

  /** Fold one pad's levels into the menu cursor. */
  function applyNav(index: number, levels: PadLevels, t: number): void {
    let state = nav.get(index);
    if (state === undefined) {
      state = { dir: null, nextRepeat: 0, confirm: false, back: false };
      nav.set(index, state);
    }

    if (levels.nav !== state.dir) {
      state.dir = levels.nav;
      if (levels.nav !== null) {
        pushNav(NAV_OF_DIR[levels.nav]);
        state.nextRepeat = t + NAV_REPEAT_DELAY_MS;
      }
    } else if (state.dir !== null && t >= state.nextRepeat) {
      pushNav(NAV_OF_DIR[state.dir]);
      state.nextRepeat = t + NAV_REPEAT_MS;
    }

    // Confirm and back fire on the edge and never repeat: a held confirm would
    // start a game and immediately confirm the next screen, which is the exact
    // rule `attachNav` applies to a held Enter.
    if (levels.confirm !== state.confirm) {
      state.confirm = levels.confirm;
      if (levels.confirm) {
        pushNav('confirm');
      }
    }
    if (levels.back !== state.back) {
      state.back = levels.back;
      if (levels.back) {
        pushNav('back');
      }
    }
  }

  return {
    sample(): void {
      if (disposed || provider === null) {
        return;
      }
      const list = provider.getGamepads();
      const t = now();
      const seen = new Set<number>();

      for (const pad of list) {
        if (pad === null || !pad.connected) {
          continue;
        }
        seen.add(pad.index);
        if (slotFor(pad.index) === null) {
          assign(pad.index);
        }
        const levels = readPad(pad);
        const slot = slotFor(pad.index);
        if (slot !== null) {
          applyLevels(slot, levels);
        }
        applyNav(pad.index, levels, t);
      }

      // Disconnects, observed rather than subscribed to (see the header).
      for (const slot of slots) {
        if (slot.padIndex !== null && !seen.has(slot.padIndex)) {
          release(slot);
        }
      }
      for (const index of [...nav.keys()]) {
        if (!seen.has(index)) {
          nav.delete(index);
        }
      }
    },

    poll(): readonly [PlayerIntent, PlayerIntent] {
      slots[0].pad.drain(intents[0]);
      slots[1].pad.drain(intents[1]);
      return intents;
    },

    clear(): void {
      for (const slot of slots) {
        slot.pad.reset();
        // The LEVELS are cleared too, so the next sample re-presses whatever is
        // genuinely still held rather than treating it as an unchanged hold.
        slot.dpad = null;
        slot.stick = null;
        slot.fire = false;
        slot.pause = false;
      }
    },

    noteKeyboard(slot: 0 | 1): void {
      slots[slot].keyboard = true;
    },

    slotOf(index: number): 0 | 1 | null {
      if (slots[0].padIndex === index) return 0;
      if (slots[1].padIndex === index) return 1;
      return null;
    },

    retainNav(): () => void {
      navRetainers++;
      // The queue is emptied on the way IN as well as out: whatever happened
      // while nobody was listening belongs to nobody.
      navQueue.length = 0;
      let released = false;
      return (): void => {
        if (released) {
          return;
        }
        released = true;
        navRetainers = Math.max(0, navRetainers - 1);
        if (navRetainers === 0) {
          navQueue.length = 0;
        }
      };
    },

    drainNav(): readonly PadNavEvent[] {
      if (navQueue.length === 0) {
        return EMPTY_NAV;
      }
      const out = navQueue.slice();
      navQueue.length = 0;
      return out;
    },

    dispose(): void {
      disposed = true;
      release(slots[0]);
      release(slots[1]);
      nav.clear();
      navQueue.length = 0;
      navRetainers = 0;
    },
  };
}

const EMPTY_NAV: readonly PadNavEvent[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// The app's one hub
// ---------------------------------------------------------------------------

let shared: GamepadHub | null = null;

/**
 * The application's single hub, built on first use from `navigator`.
 *
 * A module-level singleton, and the header says why: the Gamepad API is itself
 * process-wide, so a second hub would be a second reader of one truth with its
 * own hot-plug assignment. It is reached rather than injected because the
 * alternative is threading a handle through nine screens that each ask for pad
 * navigation and nothing else — the rework `menus.ts`'s abstract nav model was
 * built to avoid.
 *
 * Safe where there is no browser: `navigatorGamepads` returns `null` and the hub
 * is a well-behaved no-op. Tests build their own hub with a fake provider and
 * never touch this one.
 */
export function sharedGamepads(): GamepadHub {
  if (shared === null) {
    const provider =
      typeof navigator === 'undefined' ? null : navigatorGamepads(navigator);
    shared = createGamepads(provider);
  }
  return shared;
}
