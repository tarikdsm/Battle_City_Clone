// tests/input/merge.test.ts — one player, several devices (arch §7).
//
// GDD §7 lets a player use a keyboard, a gamepad and a touch stick at the same
// time, and arch §7 gives the rule in one line: "sources merge with precedence
// (any active source wins; latest direction latched)". This file is that line,
// pinned — including the case the line does not spell out and the 4-way latch
// does: when the winning source lets go, the direction falls back to whatever
// another device is *still* holding.
//
// Node environment. The keyboard comes through `createInput`'s own `InputTarget`
// seam; the gamepad comes through a fake Gamepad API. No DOM.

import { describe, expect, it } from 'vitest';
import type { Dir, PlayerIntent } from '../../src/core/types';
import {
  createInput,
  type InputTarget,
  type IntentSource,
  type KeyEventLike,
} from '../../src/input/input';
import {
  BUTTON,
  createGamepads,
  type GamepadHub,
  type GamepadLike,
  type GamepadProvider,
} from '../../src/input/gamepad';

const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const P1 = 0;
const P2 = 1;

interface KeyRig {
  target: InputTarget;
  down(code: string): void;
  up(code: string): void;
  blur(): void;
}

function keyRig(): KeyRig {
  const keys: Record<'keydown' | 'keyup', ((e: KeyEventLike) => void)[]> = {
    keydown: [],
    keyup: [],
  };
  const blurs: (() => void)[] = [];
  const fire = (type: 'keydown' | 'keyup', code: string): void => {
    const event: KeyEventLike = { code, preventDefault(): void {} };
    for (const fn of [...keys[type]]) {
      fn(event);
    }
  };
  return {
    target: {
      onKey(type, fn) {
        keys[type].push(fn);
        return (): void => {
          keys[type].splice(keys[type].indexOf(fn), 1);
        };
      },
      onBlur(fn) {
        blurs.push(fn);
        return (): void => {
          blurs.splice(blurs.indexOf(fn), 1);
        };
      },
    },
    down: (code) => {
      fire('keydown', code);
    },
    up: (code) => {
      fire('keyup', code);
    },
    blur: () => {
      for (const fn of [...blurs]) {
        fn();
      }
    },
  };
}

/** A one-pad fake, driven by a mutable button set. */
function padRig(): { hub: GamepadHub; press(...b: number[]): void } {
  let pressed = new Set<number>();
  const provider: GamepadProvider = {
    getGamepads(): readonly (GamepadLike | null)[] {
      const pad: GamepadLike = {
        index: 0,
        id: 'fake',
        connected: true,
        mapping: 'standard',
        axes: [0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: pressed.has(i),
          value: pressed.has(i) ? 1 : 0,
        })),
      };
      return [pad];
    },
  };
  return {
    hub: createGamepads(provider, { now: () => 0 }),
    press(...b: number[]): void {
      pressed = new Set(b);
    },
  };
}

/** One frame + one tick, in the order the loop runs them. */
function step(input: {
  sample(): void;
  poll(): readonly [PlayerIntent, PlayerIntent];
}): readonly [PlayerIntent, PlayerIntent] {
  input.sample();
  return input.poll();
}

describe('createInput — merging a keyboard and a gamepad (arch §7)', () => {
  it('takes a direction from whichever device is being used', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    pads.press(BUTTON.dpadRight);
    expect(step(input)[P1].dir).toBe(RIGHT);

    pads.press();
    keys.down('KeyW');
    expect(step(input)[P1].dir).toBe(UP);

    input.dispose();
  });

  it('gives the direction to the LATEST press, across devices', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    // One frame with nothing pressed, so the pad claims P1 before the keyboard
    // does — otherwise GDD §7's hot-plug rule would (correctly) put it on P2
    // and there would be no merge to test.
    step(input);

    keys.down('KeyA'); // holding left on the keyboard
    expect(step(input)[P1].dir).toBe(LEFT);

    pads.press(BUTTON.dpadUp); // …and tapping up on the pad
    expect(step(input)[P1].dir).toBe(UP);

    // The pad keeps it while it is held — a held keyboard key does not steal
    // it back on the next tick.
    expect(step(input)[P1].dir).toBe(UP);

    // Release the pad: the keyboard is still holding left, so the direction
    // falls back to it. This is the 4-way latch's fall-back, one level up.
    pads.press();
    expect(step(input)[P1].dir).toBe(LEFT);

    keys.up('KeyA');
    expect(step(input)[P1].dir).toBeNull();

    input.dispose();
  });

  it('unions fire and pause', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    pads.press(BUTTON.fire);
    expect(step(input)[P1].fire).toBe(true);
    pads.press();
    step(input);

    keys.down('KeyJ');
    expect(step(input)[P1].fire).toBe(true);
    keys.up('KeyJ');
    step(input);

    pads.press(BUTTON.start);
    expect(step(input)[P1].pause).toBe(true);

    input.dispose();
  });

  it('keeps the two players apart', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    keys.down('ArrowDown'); // P2's keyboard layout
    pads.press(BUTTON.dpadUp); // the pad took the first free slot: P1
    const [p1, p2] = step(input);
    expect(p1.dir).toBe(UP);
    expect(p2.dir).toBe(DOWN);

    input.dispose();
  });

  it('tells the pads who is already at the keyboard (GDD §7)', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    // P1 plays on the keyboard first…
    keys.down('KeyW');
    keys.up('KeyW');
    step(input);
    // …so the pad that arrives is P2, not P1. `createInput` is the only thing
    // that can report this: it owns the binding map.
    expect(pads.hub.slotOf(0)).toBe(P2);

    pads.press(BUTTON.dpadLeft);
    const [p1, p2] = step(input);
    expect(p1.dir).toBeNull();
    expect(p2.dir).toBe(LEFT);

    input.dispose();
  });

  it('clears every source on focus loss, not just the keyboard', () => {
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);

    keys.down('KeyW');
    pads.press(BUTTON.dpadRight, BUTTON.fire);
    step(input);

    keys.blur();
    // Polled without a sample: nothing has been re-read, so what survives the
    // blur is exactly what the clear left behind.
    const [p1] = input.poll();
    expect(p1.dir).toBeNull();
    expect(p1.fire).toBe(false);

    input.dispose();
  });

  it('leaves the injected sources alive after dispose', () => {
    // The hub outlives every screen (`sharedGamepads`), so a play screen that
    // disposed it would take the pads down with it — and the pause menu behind
    // it navigates with the same pads.
    const keys = keyRig();
    const pads = padRig();
    const input = createInput(undefined, keys.target, undefined, [pads.hub]);
    pads.press(BUTTON.dpadUp);
    step(input);
    input.dispose();

    pads.hub.sample();
    expect(pads.hub.poll()[P1].dir).toBe(UP);
  });

  it('is a straight pass-through with only the keyboard', () => {
    const keys = keyRig();
    const input = createInput(undefined, keys.target);
    keys.down('KeyD');
    expect(step(input)[P1].dir).toBe(RIGHT);
    input.dispose();
  });

  it('samples every source that asks to be sampled', () => {
    let sampled = 0;
    const source: IntentSource = {
      sample(): void {
        sampled++;
      },
      poll: () => IDLE,
      clear(): void {},
    };
    const keys = keyRig();
    const input = createInput(undefined, keys.target, undefined, [source]);
    input.sample();
    input.sample();
    expect(sampled).toBe(2);
    input.dispose();
  });
});

const IDLE: readonly [PlayerIntent, PlayerIntent] = [
  { dir: null, fire: false, pause: false },
  { dir: null, fire: false, pause: false },
];
