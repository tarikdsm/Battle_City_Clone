// src/input/input.ts — the browser adapter, and the place the sources merge
// (arch §7).
//
// Everything with logic lives in `keyboard.ts`, `gamepad.ts` and `touch.ts`;
// this file is the part that touches the DOM, and it is deliberately the only
// part that does. The seam is {@link InputTarget}: three subscriptions, each
// returning its own remover. It exists so `tests/input/*.test.ts` can drive the
// whole layer in the node environment with plain objects — no jsdom, and no
// casting a fake through the DOM's `EventListener` type.
//
// ## The merge (arch §7: "sources merge with precedence")
//
// One player may have a keyboard, a pad and a thumb on the glass at once, and
// the spec's rule is "any active source wins; latest direction latched". Two
// things fall out of that and both are in {@link mergeInto}:
//
// - **Fire and pause are a union.** Any source asking is enough.
// - **Direction goes to the source that most recently *started* one**, and stays
//   there until that source lets go — at which point it falls back to whatever
//   another source is still holding. That is the same fall-back the 4-way latch
//   performs between two keys (`latch.ts` rule 1), lifted one level up so it
//   also works between two devices.

import type { Dir, PlayerIntent } from '../core/types';
import { createIntents } from './latch';
import {
  DEFAULT_BINDINGS,
  createKeyboard,
  type Bindings,
  type Keyboard,
} from './keyboard';

export {
  DEFAULT_BINDINGS,
  TURBO_HZ,
  TURBO_PERIOD_TICKS,
  type Bindings,
  type InputAction,
} from './keyboard';

/** The two fields we read off a `KeyboardEvent`; `KeyboardEvent` satisfies it. */
export interface KeyEventLike {
  readonly code: string;
  preventDefault(): void;
}

/** Where key events come from. `window` in the game; a plain object in tests. */
export interface InputTarget {
  /** Subscribe; the returned function removes exactly this listener. */
  onKey(type: 'keydown' | 'keyup', fn: (e: KeyEventLike) => void): () => void;
  /** Subscribe to focus loss; the returned function removes this listener. */
  onBlur(fn: () => void): () => void;
}

/**
 * A producer of `PlayerIntent`s — the gamepad hub, the touch overlay, and (from
 * the inside) the keyboard itself. Everything optional is optional because the
 * three sources genuinely differ: only a polled device needs `sample`, and only
 * the gamepad cares who is at the keyboard.
 */
export interface IntentSource {
  /**
   * Read hardware that delivers no events. Called once per rendered FRAME, so a
   * display faster than the 60 Hz simulation catches presses that begin and end
   * inside one tick. Must be idempotent within a frame.
   */
  sample?(): void;
  /** The intents for the tick about to run. Called once per tick. */
  poll(): readonly [PlayerIntent, PlayerIntent];
  /** Forget every held control. Focus loss, screen change, dispose. */
  clear(): void;
  /** A key bound to this player slot went down (GDD §7's hot-plug rule). */
  noteKeyboard?(slot: 0 | 1): void;
  /** Release anything this source owns. The caller may still own the object. */
  dispose?(): void;
}

/** Contract Zero's input surface: one poll per tick, and a clean teardown. */
export interface InputSystem {
  /** Sample the polled sources. Once per frame, before the tick(s) it feeds. */
  sample(): void;
  poll(): readonly [PlayerIntent, PlayerIntent];
  dispose(): void;
}

/** Adapts a real `Window` to {@link InputTarget}. */
export function windowTarget(w: Window): InputTarget {
  return {
    onKey(type, fn) {
      // A wrapper rather than a cast: `KeyboardEvent` satisfies `KeyEventLike`,
      // so the narrowing is a real subtype relation and the same reference is
      // handed to `removeEventListener` — passing a different function there is
      // a silent no-op, which is how listener leaks usually happen.
      const listener = (e: KeyboardEvent): void => {
        fn(e);
      };
      w.addEventListener(type, listener);
      return (): void => {
        w.removeEventListener(type, listener);
      };
    },
    onBlur(fn) {
      const listener = (): void => {
        fn();
      };
      w.addEventListener('blur', listener);
      return (): void => {
        w.removeEventListener('blur', listener);
      };
    },
  };
}

/**
 * Fold every source's view of one player into one intent.
 *
 * `prev` and `active` are the merge's only state, one entry per source per
 * player: `prev` is what each source said last tick (so a *new* direction is
 * distinguishable from a held one), and `active` remembers which source owns
 * the direction right now.
 */
function mergeInto(
  out: PlayerIntent,
  polled: readonly (readonly [PlayerIntent, PlayerIntent])[],
  slot: 0 | 1,
  prev: (Dir | null)[],
  active: number[],
): void {
  let fire = false;
  let pause = false;
  let winner = -1;

  for (let s = 0; s < polled.length; s++) {
    const it = polled[s][slot];
    fire = fire || it.fire;
    pause = pause || it.pause;
    // A direction that was not there last tick is a *press*, and the latest
    // press wins — the same rule the per-device latch applies to two keys.
    if (it.dir !== null && it.dir !== prev[s]) {
      winner = s;
    }
    prev[s] = it.dir;
  }

  if (winner < 0) {
    const held = active[slot];
    if (held >= 0 && polled[held][slot].dir !== null) {
      winner = held; // nothing new: the source already steering keeps it
    } else {
      // It let go. Fall back to any source still holding a direction.
      for (let s = 0; s < polled.length; s++) {
        if (polled[s][slot].dir !== null) {
          winner = s;
          break;
        }
      }
    }
  }

  active[slot] = winner;
  out.dir = winner >= 0 ? polled[winner][slot].dir : null;
  out.fire = fire;
  out.pause = pause;
}

/**
 * @param bindings action → `KeyboardEvent.code`, per player. Snapshotted, so the
 *                 caller may keep editing its own object.
 * @param target   where to listen. Defaults to the game window; the default is
 *                 evaluated only when it is used, so a node test never touches
 *                 `window`.
 * @param onUserGesture called on **every** key press, bound or not.
 * @param sources  the non-keyboard sources to merge — the gamepad hub, the touch
 *                 overlay. Owned by the caller: this function polls, clears and
 *                 notifies them, and never disposes them, because the gamepad
 *                 hub outlives every screen that reads it.
 *
 * The browser's autoplay policy only lets an `AudioContext` start from a user
 * gesture, and this layer is where the game's gestures already arrive — so the
 * audio system hooks in here rather than adding a second `keydown` listener
 * that would race this one for `preventDefault`.
 *
 * It fires on every press, not just the first, and that is deliberate: a
 * `resume()` the browser refuses (it can happen on the very first key of a
 * freshly restored tab) has to be retried, and `AudioSystem.resume` is
 * idempotent and cheap once the context is running. Unbound keys count too —
 * a gesture is a gesture, and Escape reaching the pause menu should also be
 * enough to wake the sound up.
 */
export function createInput(
  bindings: Bindings = DEFAULT_BINDINGS,
  target: InputTarget = windowTarget(window),
  onUserGesture?: () => void,
  sources: readonly IntentSource[] = [],
): InputSystem {
  const keyboard: Keyboard = createKeyboard(bindings, (slot) => {
    for (const source of sources) {
      source.noteKeyboard?.(slot);
    }
  });

  // The keyboard is source 0 and the injected ones follow, which is also the
  // fall-back order in `mergeInto`: with two devices holding a direction and
  // neither having pressed most recently, the keys win. Arbitrary, but stable.
  const all: readonly IntentSource[] = [keyboard, ...sources];

  // Everything below is allocated once (arch §11 — the steady state allocates
  // nothing). `polled` is refilled per tick with the sources' own reused tuples.
  const polled: (readonly [PlayerIntent, PlayerIntent])[] = new Array<
    readonly [PlayerIntent, PlayerIntent]
  >(all.length).fill(IDLE);
  const merged = createIntents();
  const prev: (Dir | null)[][] = [
    new Array<Dir | null>(all.length).fill(null),
    new Array<Dir | null>(all.length).fill(null),
  ];
  const active: number[] = [-1, -1];

  const removers: (() => void)[] = [
    target.onKey('keydown', (e) => {
      onUserGesture?.();
      // Bound keys only. The arrows scroll the page and Ctrl+Right jumps a
      // word in whatever is focused; F5, Tab and the devtools chords are not
      // ours to swallow.
      if (keyboard.down(e.code)) {
        e.preventDefault();
      }
    }),
    target.onKey('keyup', (e) => {
      if (keyboard.up(e.code)) {
        e.preventDefault();
      }
    }),
    target.onBlur(() => {
      // Alt-tab mid-move: the browser delivers no keyup for a key that was down
      // when focus left, so without this the tank drives into a wall for as long
      // as the player is in another window. Every source is cleared, not just
      // the keyboard — a thumb lifted off the glass outside the window produces
      // no `pointerup` either.
      for (const source of all) {
        source.clear();
      }
    }),
  ];

  return {
    sample(): void {
      for (const source of all) {
        source.sample?.();
      }
    },

    poll(): readonly [PlayerIntent, PlayerIntent] {
      for (let s = 0; s < all.length; s++) {
        polled[s] = all[s].poll();
      }
      // Single-source is the overwhelmingly common case and it costs nothing to
      // keep it exact: no merge state to consult, no fall-back to walk.
      if (polled.length === 1) {
        return polled[0];
      }
      mergeInto(merged[0], polled, 0, prev[0], active);
      mergeInto(merged[1], polled, 1, prev[1], active);
      return merged;
    },

    dispose(): void {
      // Idempotent: `leave()` may run after an error rail has already torn the
      // screen down. Emptying the array is what makes a second call a no-op.
      for (const remove of removers) {
        remove();
      }
      removers.length = 0;
      // The injected sources are cleared, not disposed — see `sources` above.
      for (const source of all) {
        source.clear();
      }
      keyboard.clear();
    },
  };
}

/** The placeholder `polled` holds before the first tick. Never read from. */
const IDLE: readonly [PlayerIntent, PlayerIntent] = [
  { dir: null, fire: false, pause: false },
  { dir: null, fire: false, pause: false },
];
