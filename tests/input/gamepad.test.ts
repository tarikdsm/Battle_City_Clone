// tests/input/gamepad.test.ts — the gamepad driver (GDD §7, arch §7).
//
// Node environment, **fake Gamepad API**. `createGamepads` takes a
// `GamepadProvider` — one method, `getGamepads()` — and a clock, so the whole
// layer runs against plain objects: no browser, no `navigator`, no real pad.
//
// That is also this file's honest limit, and the T9 report says so out loud: a
// fake provider proves the *mapping, the latch, the dead zone, the hot-plug
// assignment and the nav timing*. It cannot prove that a physical Xbox pad
// reports button 12 for D-pad up on this machine's driver stack.

import { describe, expect, it } from 'vitest';
import type { Dir, PlayerIntent } from '../../src/core/types';
import {
  BUTTON,
  DEAD_ZONE,
  NAV_REPEAT_DELAY_MS,
  NAV_REPEAT_MS,
  createGamepads,
  stickDir,
  type GamepadHub,
  type GamepadLike,
  type GamepadProvider,
} from '../../src/input/gamepad';
import { TURBO_PERIOD_TICKS } from '../../src/input/latch';

const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const P1 = 0;
const P2 = 1;

// ---------------------------------------------------------------------------
// The fake Gamepad API
// ---------------------------------------------------------------------------

/** One writable pad. `buttons`/`axes` are the two things a test drives. */
interface FakePad {
  readonly index: number;
  pressed: Set<number>;
  axes: number[];
  connected: boolean;
}

interface Rig {
  provider: GamepadProvider;
  /** Plug a pad in at `index`. Returns the handle a test drives. */
  plug(index: number): FakePad;
  /** Unplug: the slot in `getGamepads()` goes back to `null`, as it does live. */
  unplug(index: number): void;
  /** Advance the fake clock. */
  advance(ms: number): void;
  now(): number;
  hub(): GamepadHub;
}

function rig(): Rig {
  const pads = new Map<number, FakePad>();
  let clock = 1000;

  const provider: GamepadProvider = {
    getGamepads(): readonly (GamepadLike | null)[] {
      // The real API answers with a sparse, index-addressed array whose holes
      // are `null` — reproducing that shape is most of the point of the fake.
      const highest = Math.max(-1, ...pads.keys());
      const out: (GamepadLike | null)[] = [];
      for (let i = 0; i <= highest; i++) {
        const pad = pads.get(i);
        out.push(
          pad === undefined || !pad.connected
            ? null
            : {
                index: pad.index,
                id: `fake pad ${pad.index}`,
                connected: true,
                mapping: 'standard',
                axes: pad.axes,
                buttons: Array.from({ length: 17 }, (_, b) => ({
                  pressed: pad.pressed.has(b),
                  value: pad.pressed.has(b) ? 1 : 0,
                })),
              },
        );
      }
      return out;
    },
  };

  const created = createGamepads(provider, { now: () => clock });

  return {
    provider,
    plug(index) {
      const pad: FakePad = {
        index,
        pressed: new Set<number>(),
        axes: [0, 0, 0, 0],
        connected: true,
      };
      pads.set(index, pad);
      return pad;
    },
    unplug(index) {
      const pad = pads.get(index);
      if (pad !== undefined) {
        pad.connected = false;
      }
    },
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    hub: () => created,
  };
}

/** Sample the hardware, then take the tick's intents — the live call order. */
function step(hub: GamepadHub): readonly [PlayerIntent, PlayerIntent] {
  hub.sample();
  return hub.poll();
}

// ---------------------------------------------------------------------------

describe('stickDir — vector to a 4-way direction (arch §7)', () => {
  it('is null inside the dead zone', () => {
    expect(stickDir(0, 0)).toBeNull();
    expect(stickDir(0.3, 0)).toBeNull();
    expect(stickDir(0, -0.39)).toBeNull();
    // Resting drift on both axes still adds up to less than the dead zone.
    expect(stickDir(0.2, 0.2)).toBeNull();
  });

  it('uses a RADIAL dead zone, so a diagonal push is not swallowed', () => {
    // 45° at magnitude 0.6: each component is 0.424. A per-axis dead zone would
    // be a coin flip here; a radial one answers "the stick is clearly pushed".
    expect(stickDir(0.424, 0.424)).not.toBeNull();
    // …and the same 45° below the radius is still rest.
    expect(stickDir(0.28, 0.28)).toBeNull();
  });

  it('takes the dead zone at exactly 0.4 as pushed', () => {
    expect(DEAD_ZONE).toBe(0.4);
    expect(stickDir(DEAD_ZONE, 0)).toBe(RIGHT);
    expect(stickDir(DEAD_ZONE - 1e-9, 0)).toBeNull();
  });

  it('picks the dominant axis — there are no diagonals', () => {
    expect(stickDir(0.9, 0.5)).toBe(RIGHT);
    expect(stickDir(-0.9, 0.5)).toBe(LEFT);
    expect(stickDir(0.5, 0.9)).toBe(DOWN);
    expect(stickDir(0.5, -0.9)).toBe(UP);
    // Y is down-positive in the Gamepad API, as it is in `Dir`.
    expect(stickDir(0, -1)).toBe(UP);
    expect(stickDir(0, 1)).toBe(DOWN);
  });

  it('breaks an exact tie toward the horizontal, deterministically', () => {
    expect(stickDir(0.7, 0.7)).toBe(RIGHT);
    expect(stickDir(-0.7, -0.7)).toBe(LEFT);
  });

  it('honours a caller-supplied dead zone', () => {
    expect(stickDir(0.5, 0, 0.6)).toBeNull();
    expect(stickDir(0.7, 0, 0.6)).toBe(RIGHT);
  });
});

describe('createGamepads — standard mapping (GDD §7)', () => {
  it('reports nothing at all with no pad connected', () => {
    const r = rig();
    const [p1, p2] = step(r.hub());
    expect(p1).toEqual({ dir: null, fire: false, pause: false });
    expect(p2).toEqual({ dir: null, fire: false, pause: false });
  });

  it('maps the D-pad onto the four directions', () => {
    const r = rig();
    const pad = r.plug(0);
    const cases: [number, Dir][] = [
      [BUTTON.dpadUp, UP],
      [BUTTON.dpadRight, RIGHT],
      [BUTTON.dpadDown, DOWN],
      [BUTTON.dpadLeft, LEFT],
    ];
    for (const [button, dir] of cases) {
      pad.pressed = new Set([button]);
      expect(step(r.hub())[P1].dir).toBe(dir);
    }
    pad.pressed = new Set();
    expect(step(r.hub())[P1].dir).toBeNull();
  });

  it('maps the left stick onto the same four directions', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.axes = [0, -1, 0, 0];
    expect(step(r.hub())[P1].dir).toBe(UP);
    pad.axes = [1, 0, 0, 0];
    expect(step(r.hub())[P1].dir).toBe(RIGHT);
    // The RIGHT stick (axes 2/3) is not a movement control.
    pad.axes = [0, 0, -1, 0];
    expect(step(r.hub())[P1].dir).toBeNull();
  });

  it('maps A to fire and Start to pause', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.fire]);
    expect(step(r.hub())[P1].fire).toBe(true);
    pad.pressed = new Set([BUTTON.start]);
    const [p1] = step(r.hub());
    expect(p1.pause).toBe(true);
    expect(p1.fire).toBe(false);
  });

  it('pulses a held fire button at the keyboard turbo rate (fidelity §5.1)', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.fire]);

    // The pattern the keyboard produces: one pulse, then TURBO_PERIOD_TICKS-1
    // silent ticks. A gamepad that fired every tick would be a different game.
    const fired: boolean[] = [];
    for (let i = 0; i < TURBO_PERIOD_TICKS * 2; i++) {
      fired.push(step(r.hub())[P1].fire);
    }
    expect(fired[0]).toBe(true);
    for (let i = 1; i < TURBO_PERIOD_TICKS; i++) {
      expect(fired[i], `tick ${i} should be silent`).toBe(false);
    }
    expect(fired[TURBO_PERIOD_TICKS]).toBe(true);
  });
});

describe('createGamepads — the 4-way latch (arch §7)', () => {
  it('resumes the held direction when a tapped one is released', () => {
    const r = rig();
    const pad = r.plug(0);

    pad.pressed = new Set([BUTTON.dpadLeft]);
    expect(step(r.hub())[P1].dir).toBe(LEFT);

    // Peek down a corridor: the newest press wins…
    pad.pressed = new Set([BUTTON.dpadLeft, BUTTON.dpadUp]);
    expect(step(r.hub())[P1].dir).toBe(UP);

    // …and releasing it falls back to what is still held. This is the whole
    // reason the latch is a stack and not a priority order.
    pad.pressed = new Set([BUTTON.dpadLeft]);
    expect(step(r.hub())[P1].dir).toBe(LEFT);

    pad.pressed = new Set();
    expect(step(r.hub())[P1].dir).toBeNull();
  });

  it('latches the stick and the D-pad against each other', () => {
    const r = rig();
    const pad = r.plug(0);

    pad.axes = [1, 0, 0, 0]; // stick right
    expect(step(r.hub())[P1].dir).toBe(RIGHT);

    pad.pressed = new Set([BUTTON.dpadUp]); // tap up on the D-pad
    expect(step(r.hub())[P1].dir).toBe(UP);

    pad.pressed = new Set(); // release the D-pad — the stick is still right
    expect(step(r.hub())[P1].dir).toBe(RIGHT);

    pad.axes = [0, 0, 0, 0];
    expect(step(r.hub())[P1].dir).toBeNull();
  });

  it('treats a stick swing as a release and a press, not a hold', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.axes = [1, 0, 0, 0];
    expect(step(r.hub())[P1].dir).toBe(RIGHT);
    pad.axes = [0, 1, 0, 0]; // swung to down
    expect(step(r.hub())[P1].dir).toBe(DOWN);
    // Back through the dead zone: nothing is held, so there is nothing to
    // resume — a stick that left a ghost direction behind would drive the tank
    // into a wall.
    pad.axes = [0, 0, 0, 0];
    expect(step(r.hub())[P1].dir).toBeNull();
  });

  it('survives a press that arrives and leaves between two polls', () => {
    // The sub-tick latch T6.3 added to the keyboard, applied to a polled
    // source: the frame loop samples more often than the 60 Hz simulation
    // polls, so a flick that lands entirely inside one tick must not vanish.
    const r = rig();
    const hub = r.hub();
    const pad = r.plug(0);

    pad.pressed = new Set([BUTTON.dpadRight, BUTTON.fire]);
    hub.sample();
    pad.pressed = new Set();
    hub.sample();

    const [p1] = hub.poll();
    expect(p1.dir).toBe(RIGHT);
    expect(p1.fire).toBe(true);

    // …and the tap is consumed exactly once.
    const [after] = step(hub);
    expect(after.dir).toBeNull();
    expect(after.fire).toBe(false);
  });
});

describe('createGamepads — hot-plug assignment (GDD §7)', () => {
  it('gives the first pad the first player slot', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadUp]);
    const [p1, p2] = step(r.hub());
    expect(r.hub().slotOf(0)).toBe(P1);
    expect(p1.dir).toBe(UP);
    expect(p2.dir).toBeNull();
  });

  it('gives the second pad the second slot', () => {
    const r = rig();
    const a = r.plug(0);
    const b = r.plug(3); // a sparse index, as a real re-plug produces
    a.pressed = new Set([BUTTON.dpadUp]);
    b.pressed = new Set([BUTTON.dpadDown]);
    const [p1, p2] = step(r.hub());
    expect(r.hub().slotOf(0)).toBe(P1);
    expect(r.hub().slotOf(3)).toBe(P2);
    expect(p1.dir).toBe(UP);
    expect(p2.dir).toBe(DOWN);
  });

  it('becomes P2 when the keyboard is already playing P1', () => {
    const r = rig();
    r.hub().noteKeyboard(P1);
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadUp]);
    const [p1, p2] = step(r.hub());
    expect(r.hub().slotOf(0)).toBe(P2);
    expect(p1.dir).toBeNull();
    expect(p2.dir).toBe(UP);
  });

  it('keeps its slot when the keyboard joins afterwards', () => {
    // Assignment happens once, at connect. A player who reaches over to the
    // keyboard mid-run must not have the pad reassigned under their thumbs.
    const r = rig();
    const pad = r.plug(0);
    step(r.hub());
    expect(r.hub().slotOf(0)).toBe(P1);
    r.hub().noteKeyboard(P1);
    pad.pressed = new Set([BUTTON.dpadUp]);
    expect(step(r.hub())[P1].dir).toBe(UP);
  });

  it('takes a free slot even when both are claimed by the keyboard', () => {
    const r = rig();
    r.hub().noteKeyboard(P1);
    r.hub().noteKeyboard(P2);
    r.plug(0);
    step(r.hub());
    expect(r.hub().slotOf(0)).toBe(P1);
  });

  it('ignores a third pad — there are two players', () => {
    const r = rig();
    r.plug(0);
    r.plug(1);
    const third = r.plug(2);
    third.pressed = new Set([BUTTON.dpadLeft]);
    const [p1, p2] = step(r.hub());
    expect(r.hub().slotOf(2)).toBeNull();
    expect(p1.dir).toBeNull();
    expect(p2.dir).toBeNull();
  });

  it('frees the slot on disconnect and clears what the pad was holding', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadUp]);
    expect(step(r.hub())[P1].dir).toBe(UP);

    r.unplug(0);
    // A pad yanked out mid-move leaves no held direction behind.
    expect(step(r.hub())[P1].dir).toBeNull();
    expect(r.hub().slotOf(0)).toBeNull();

    // …and the freed slot is available to the next pad that arrives.
    const next = r.plug(5);
    next.pressed = new Set([BUTTON.dpadRight]);
    expect(step(r.hub())[P1].dir).toBe(RIGHT);
    expect(r.hub().slotOf(5)).toBe(P1);
  });

  it('clear() drops every held direction without unassigning the pads', () => {
    const r = rig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadUp, BUTTON.fire]);
    step(r.hub());
    r.hub().clear();
    const [p1] = r.hub().poll();
    expect(p1.dir).toBeNull();
    expect(p1.fire).toBe(false);
    expect(r.hub().slotOf(0)).toBe(P1);
  });
});

describe('createGamepads — menu navigation (GDD §7)', () => {
  /** Menus only receive events while a screen is listening. */
  function navRig(): { r: Rig; hub: GamepadHub; release: () => void } {
    const r = rig();
    const hub = r.hub();
    const release = hub.retainNav();
    return { r, hub, release };
  }

  it('emits one event on the press edge, not one per frame', () => {
    const { r, hub } = navRig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);
    r.advance(16);
    hub.sample();
    expect(hub.drainNav()).toEqual([]);
  });

  it('auto-repeats a held direction after the initial delay', () => {
    const { r, hub } = navRig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);

    r.advance(NAV_REPEAT_DELAY_MS - 1);
    hub.sample();
    expect(hub.drainNav()).toEqual([]);

    r.advance(1);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);

    r.advance(NAV_REPEAT_MS);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);
  });

  it('restarts the delay when the direction changes', () => {
    const { r, hub } = navRig();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    hub.drainNav();
    r.advance(NAV_REPEAT_DELAY_MS);
    pad.pressed = new Set([BUTTON.dpadUp]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['up']);
    r.advance(NAV_REPEAT_MS);
    hub.sample();
    expect(hub.drainNav(), 'the new direction gets its own delay').toEqual([]);
  });

  it('navigates from the left stick too', () => {
    const { r, hub } = navRig();
    const pad = r.plug(0);
    pad.axes = [0, -1, 0, 0];
    hub.sample();
    expect(hub.drainNav()).toEqual(['up']);
  });

  it('maps A and Start to confirm, B and Select to back — no repeat', () => {
    const { r, hub } = navRig();
    const pad = r.plug(0);
    for (const [button, expected] of [
      [BUTTON.fire, 'confirm'],
      [BUTTON.start, 'confirm'],
      [BUTTON.back, 'back'],
      [BUTTON.select, 'back'],
    ] as const) {
      pad.pressed = new Set([button]);
      hub.sample();
      expect(hub.drainNav()).toEqual([expected]);
      // Held: a confirm that repeated would start a game and immediately
      // confirm the next screen — the same rule `attachNav` applies to Enter.
      r.advance(NAV_REPEAT_DELAY_MS + NAV_REPEAT_MS * 4);
      hub.sample();
      expect(hub.drainNav()).toEqual([]);
      pad.pressed = new Set();
      hub.sample();
      hub.drainNav();
    }
  });

  it('takes navigation from ANY connected pad, assigned or not', () => {
    // A menu has one cursor. Both players sit in front of it, and the third
    // pad that owns no player slot still has a human holding it.
    const { r, hub } = navRig();
    r.plug(0);
    r.plug(1);
    const third = r.plug(2);
    hub.sample();
    hub.drainNav();
    third.pressed = new Set([BUTTON.dpadUp]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['up']);
  });

  it('buffers nothing while no screen is listening', () => {
    // Otherwise a run played with the pad would queue hundreds of events and
    // the pause menu would jump the moment it opened.
    const r = rig();
    const hub = r.hub();
    const pad = r.plug(0);
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    expect(hub.drainNav()).toEqual([]);

    const release = hub.retainNav();
    // The button was ALREADY down when the screen mounted: that is not a press
    // edge, and it must not move the cursor the instant the menu appears.
    hub.sample();
    expect(hub.drainNav()).toEqual([]);
    pad.pressed = new Set();
    hub.sample();
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);

    release();
    pad.pressed = new Set();
    hub.sample();
    pad.pressed = new Set([BUTTON.dpadUp]);
    hub.sample();
    expect(hub.drainNav()).toEqual([]);
  });

  it('keeps listening while any one screen still holds a retainer', () => {
    const r = rig();
    const hub = r.hub();
    const first = hub.retainNav();
    const second = hub.retainNav();
    const pad = r.plug(0);
    hub.sample();
    hub.drainNav();
    first();
    pad.pressed = new Set([BUTTON.dpadDown]);
    hub.sample();
    expect(hub.drainNav()).toEqual(['down']);
    second();
  });
});

describe('createGamepads — a provider that is not there', () => {
  it('survives an environment with no Gamepad API', () => {
    const hub = createGamepads(null);
    hub.sample();
    const [p1, p2] = hub.poll();
    expect(p1.dir).toBeNull();
    expect(p2.dir).toBeNull();
    expect(hub.drainNav()).toEqual([]);
    expect(hub.slotOf(0)).toBeNull();
    hub.dispose();
  });
});
