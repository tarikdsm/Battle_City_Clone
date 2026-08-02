// src/input/input.ts — the browser adapter for the keyboard driver (arch §7).
//
// Everything with logic lives in `keyboard.ts`; this file is the part that
// touches the DOM, and it is deliberately the only part that does. The seam is
// {@link InputTarget}: three subscriptions, each returning its own remover. It
// exists so `tests/input/keyboard.test.ts` can drive the whole layer in the node
// environment with plain objects — no jsdom, and no casting a fake through the
// DOM's `EventListener` type.

import type { PlayerIntent } from '../core/types';
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

/** Contract Zero's input surface: one poll per tick, and a clean teardown. */
export interface InputSystem {
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
 * @param bindings action → `KeyboardEvent.code`, per player. Snapshotted, so the
 *                 caller may keep editing its own object.
 * @param target   where to listen. Defaults to the game window; the default is
 *                 evaluated only when it is used, so a node test never touches
 *                 `window`.
 */
export function createInput(
  bindings: Bindings = DEFAULT_BINDINGS,
  target: InputTarget = windowTarget(window),
): InputSystem {
  const keyboard: Keyboard = createKeyboard(bindings);

  const removers: (() => void)[] = [
    target.onKey('keydown', (e) => {
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
      // as the player is in another window.
      keyboard.clear();
    }),
  ];

  return {
    poll(): readonly [PlayerIntent, PlayerIntent] {
      return keyboard.poll();
    },

    dispose(): void {
      // Idempotent: `leave()` may run after an error rail has already torn the
      // screen down. Emptying the array is what makes a second call a no-op.
      for (const remove of removers) {
        remove();
      }
      removers.length = 0;
      keyboard.clear();
    },
  };
}
