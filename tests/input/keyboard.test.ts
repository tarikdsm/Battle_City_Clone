// tests/input/keyboard.test.ts — the keyboard driver (GDD §7, arch §7).
//
// Node environment, no DOM library: `createInput` takes an `InputTarget` (three
// subscriptions, each returning its own remover), so the whole layer — the
// reverse binding map, the 4-way latch, the turbo pulse, the blur reset and the
// listener bookkeeping — is exercised with plain objects and no jsdom.
import { describe, expect, it } from 'vitest';
import { TICK_S } from '../../src/core/constants';
import type { Dir } from '../../src/core/types';
import {
  createInput,
  type InputTarget,
  type KeyEventLike,
} from '../../src/input/input';
import {
  DEFAULT_BINDINGS,
  TURBO_HZ,
  TURBO_PERIOD_TICKS,
  type Bindings,
} from '../../src/input/keyboard';

const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const P1 = 0;
const P2 = 1;

interface Rig {
  target: InputTarget;
  /** Dispatch a key event; returns whether the driver called `preventDefault`. */
  key(type: 'keydown' | 'keyup', code: string): boolean;
  blur(): void;
  /** Subscriptions made / removers invoked — `dispose` must square them. */
  adds(): number;
  removes(): number;
  /** Handlers still registered right now. */
  live(): number;
}

function rig(): Rig {
  const keys: Record<'keydown' | 'keyup', ((e: KeyEventLike) => void)[]> = {
    keydown: [],
    keyup: [],
  };
  const blurs: (() => void)[] = [];
  let adds = 0;
  let removes = 0;

  const drop = <T>(list: T[], fn: T): void => {
    const i = list.indexOf(fn);
    if (i >= 0) {
      list.splice(i, 1);
    }
  };

  const target: InputTarget = {
    onKey(type, fn) {
      adds++;
      keys[type].push(fn);
      return (): void => {
        removes++;
        drop(keys[type], fn);
      };
    },
    onBlur(fn) {
      adds++;
      blurs.push(fn);
      return (): void => {
        removes++;
        drop(blurs, fn);
      };
    },
  };

  return {
    target,
    key(type, code) {
      let prevented = false;
      const event: KeyEventLike = {
        code,
        preventDefault(): void {
          prevented = true;
        },
      };
      // Copy: a handler is allowed to unsubscribe itself mid-dispatch.
      for (const fn of [...keys[type]]) {
        fn(event);
      }
      return prevented;
    },
    blur() {
      for (const fn of [...blurs]) {
        fn();
      }
    },
    adds: () => adds,
    removes: () => removes,
    live: () => keys.keydown.length + keys.keyup.length + blurs.length,
  };
}

describe('createInput — bindings (GDD §7)', () => {
  it('maps WASD + J onto P1 and leaves P2 neutral', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyW');
    r.key('keydown', 'KeyJ');

    const [p1, p2] = input.poll();
    expect(p1.dir).toBe(UP);
    expect(p1.fire).toBe(true);
    expect(p2.dir).toBeNull();
    expect(p2.fire).toBe(false);

    input.dispose();
  });

  it('maps each WASD key to its direction', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    for (const [code, dir] of [
      ['KeyW', UP],
      ['KeyD', RIGHT],
      ['KeyS', DOWN],
      ['KeyA', LEFT],
    ] as const) {
      r.key('keydown', code);
      expect(input.poll()[P1].dir).toBe(dir);
      r.key('keyup', code);
    }
    expect(input.poll()[P1].dir).toBeNull();

    input.dispose();
  });

  it('maps the arrows + Numpad0 onto P2 and leaves P1 neutral', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'ArrowLeft');
    r.key('keydown', 'Numpad0');

    const [p1, p2] = input.poll();
    expect(p2.dir).toBe(LEFT);
    expect(p2.fire).toBe(true);
    expect(p1.dir).toBeNull();
    expect(p1.fire).toBe(false);

    input.dispose();
  });

  it('accepts ControlRight as an alias for P2 fire', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'ControlRight');
    expect(input.poll()[P2].fire).toBe(true);

    r.key('keyup', 'ControlRight');
    expect(input.poll()[P2].fire).toBe(false);

    input.dispose();
  });

  it('holds fire while either P2 fire code is still down', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'Numpad0');
    r.key('keydown', 'ControlRight');
    r.key('keyup', 'Numpad0');

    // One code released, the other still held: the level must not drop, and the
    // pulse phase must not restart (that would be a free extra shot per release).
    let pulses = 0;
    for (let i = 0; i < TURBO_PERIOD_TICKS; i++) {
      if (input.poll()[P2].fire) {
        pulses++;
      }
    }
    expect(pulses).toBe(1);

    input.dispose();
  });
});

describe('createInput — 4-way latch (GDD §7: no diagonals)', () => {
  it('latches the most recently pressed direction and falls back on release', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    // Hold Right…
    r.key('keydown', 'KeyD');
    expect(input.poll()[P1].dir).toBe(RIGHT);

    // …tap Up while Right is still down: the newest press wins, no diagonal.
    r.key('keydown', 'KeyW');
    expect(input.poll()[P1].dir).toBe(UP);

    // Release Up: Right is still held, so the tank resumes going right. This is
    // the "hold a direction and peek" move the whole latch exists for.
    r.key('keyup', 'KeyW');
    expect(input.poll()[P1].dir).toBe(RIGHT);

    // Release the rest: no direction at all.
    r.key('keyup', 'KeyD');
    expect(input.poll()[P1].dir).toBeNull();

    input.dispose();
  });

  it('falls back through a three-deep hold in press order', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyA'); // Left
    r.key('keydown', 'KeyS'); // Down
    r.key('keydown', 'KeyW'); // Up
    expect(input.poll()[P1].dir).toBe(UP);

    r.key('keyup', 'KeyW');
    expect(input.poll()[P1].dir).toBe(DOWN);

    r.key('keyup', 'KeyS');
    expect(input.poll()[P1].dir).toBe(LEFT);

    input.dispose();
  });

  it('ignores auto-repeat: a repeated keydown does not re-latch', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyD');
    r.key('keydown', 'KeyW');
    // The OS keeps firing keydown for the held key. Re-pushing it would be
    // harmless here, but re-pushing the OLDER one would silently break the latch.
    r.key('keydown', 'KeyD');
    r.key('keydown', 'KeyW');
    expect(input.poll()[P1].dir).toBe(UP);

    r.key('keyup', 'KeyW');
    expect(input.poll()[P1].dir).toBe(RIGHT);

    input.dispose();
  });

  it('keeps the two players independent', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyW');
    r.key('keydown', 'ArrowDown');

    const [p1, p2] = input.poll();
    expect(p1.dir).toBe(UP);
    expect(p2.dir).toBe(DOWN);

    input.dispose();
  });
});

describe('createInput — fire turbo (fidelity §5.1)', () => {
  it('is 10 Hz expressed in simulation ticks', () => {
    // `poll()` is called exactly once per 60 Hz tick, so the turbo period is a
    // tick count — which makes the shot rate independent of the frame rate.
    expect(TURBO_PERIOD_TICKS).toBe(Math.round(1 / (TURBO_HZ * TICK_S)));
    expect(TURBO_HZ).toBe(10);
  });

  it('pulses ~10 times over a second of holding rather than streaming', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');

    const levels: boolean[] = [];
    for (let i = 0; i < 60; i++) {
      levels.push(input.poll()[P1].fire);
    }

    const pulses = levels.filter(Boolean).length;
    // 60 ticks / 6 = 10. The core fires on the press edge of this level, so the
    // pulse count IS the shot count a held key can produce in one second.
    expect(pulses).toBe(10);
    expect(pulses).toBeGreaterThanOrEqual(9);
    expect(pulses).toBeLessThanOrEqual(11);
    // Not a stream: there is always a released tick between two pulses, or the
    // core's edge detector would see one press and fire exactly once per hold.
    expect(levels.filter((v) => !v).length).toBe(50);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] && levels[i - 1]).toBe(false);
    }

    input.dispose();
  });

  it('fires on the very first poll after the press, not a period later', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    expect(input.poll()[P1].fire).toBe(true);

    input.dispose();
  });

  it('lets mashing beat the turbo — a fresh press always fires', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    // Press / release / press inside one turbo period. Mashing is not throttled
    // (the NES does not throttle it either); the airborne-bullet cap is the real
    // limit. Only a HELD key is rate-limited.
    r.key('keydown', 'KeyJ');
    expect(input.poll()[P1].fire).toBe(true);
    r.key('keyup', 'KeyJ');
    expect(input.poll()[P1].fire).toBe(false);
    r.key('keydown', 'KeyJ');
    expect(input.poll()[P1].fire).toBe(true);

    input.dispose();
  });

  it('drops the level the moment the key is released', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    input.poll();
    r.key('keyup', 'KeyJ');
    for (let i = 0; i < 20; i++) {
      expect(input.poll()[P1].fire).toBe(false);
    }

    input.dispose();
  });
});

describe('createInput — pause (GDD §7)', () => {
  it('reports a level from either player, and the core edge-detects it', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'Escape');
    expect(input.poll()[P1].pause).toBe(true);
    // Still a LEVEL: it stays true while held. `stepGame` toggles once, on the
    // press edge, so holding Escape must not flip pause 60 times a second.
    expect(input.poll()[P1].pause).toBe(true);
    r.key('keyup', 'Escape');
    expect(input.poll()[P1].pause).toBe(false);

    r.key('keydown', 'KeyP');
    expect(input.poll()[P2].pause).toBe(true);
    r.key('keyup', 'KeyP');
    expect(input.poll()[P2].pause).toBe(false);

    input.dispose();
  });
});

describe('createInput — focus and preventDefault', () => {
  it('clears every held key on blur', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyD');
    r.key('keydown', 'KeyJ');
    r.key('keydown', 'Escape');
    r.key('keydown', 'ArrowUp');
    expect(input.poll()[P1].dir).toBe(RIGHT);

    // Alt-tab. The browser never sends the keyup, so without this the tank
    // drives into a wall forever while the player is in another window.
    r.blur();

    const [p1, p2] = input.poll();
    expect(p1.dir).toBeNull();
    expect(p1.fire).toBe(false);
    expect(p1.pause).toBe(false);
    expect(p2.dir).toBeNull();

    // …and coming back works: the next press is a fresh press.
    r.key('keydown', 'KeyA');
    expect(input.poll()[P1].dir).toBe(LEFT);

    input.dispose();
  });

  it('preventDefaults bound keys only', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    // Arrows scroll the page; the fire keys do not, but the rule is one rule.
    expect(r.key('keydown', 'ArrowUp')).toBe(true);
    expect(r.key('keyup', 'ArrowUp')).toBe(true);
    expect(r.key('keydown', 'KeyJ')).toBe(true);

    // Anything unbound must reach the page untouched — F5, Tab, Ctrl+Shift+I.
    expect(r.key('keydown', 'F5')).toBe(false);
    expect(r.key('keydown', 'Tab')).toBe(false);
    expect(r.key('keydown', 'Space')).toBe(false);
    expect(input.poll()[P1].dir).toBeNull();

    input.dispose();
  });

  it('ignores a keyup for a key that was never down', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyD');
    r.blur();
    // The keyup the browser DOES deliver when focus returns mid-hold.
    r.key('keyup', 'KeyD');
    expect(input.poll()[P1].dir).toBeNull();

    r.key('keydown', 'KeyD');
    expect(input.poll()[P1].dir).toBe(RIGHT);

    input.dispose();
  });
});

describe('createInput — remapping (arch §7)', () => {
  it('honours a custom binding map', () => {
    const r = rig();
    const custom: Bindings = {
      p1: {
        up: 'KeyI',
        down: 'KeyK',
        left: 'KeyJ',
        right: 'KeyL',
        fire: 'Space',
      },
      p2: {
        up: 'Numpad8',
        down: 'Numpad5',
        left: 'Numpad4',
        right: 'Numpad6',
        fire: 'NumpadEnter',
      },
    };
    const input = createInput(custom, r.target);

    r.key('keydown', 'KeyL');
    r.key('keydown', 'Space');
    r.key('keydown', 'Numpad8');
    const [p1, p2] = input.poll();
    expect(p1.dir).toBe(RIGHT);
    expect(p1.fire).toBe(true);
    expect(p2.dir).toBe(UP);

    // The defaults are not implicitly still live underneath.
    r.key('keydown', 'KeyW');
    expect(input.poll()[P1].dir).toBe(RIGHT);
    expect(r.key('keydown', 'KeyW')).toBe(false);

    input.dispose();
  });

  it('does not read the caller’s map after construction', () => {
    const r = rig();
    const custom: Bindings = { p1: { up: 'KeyI' }, p2: {} };
    const input = createInput(custom, r.target);

    custom.p1.up = 'KeyZ'; // a settings screen edits its own object later

    r.key('keydown', 'KeyI');
    expect(input.poll()[P1].dir).toBe(UP);
    expect(r.key('keydown', 'KeyZ')).toBe(false);

    input.dispose();
  });

  it('never mutates DEFAULT_BINDINGS', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);
    r.key('keydown', 'KeyW');
    input.poll();
    r.blur();
    input.dispose();

    // Written out independently rather than snapshotted, so this fails if the
    // table itself is quietly edited as well as if it is mutated at runtime.
    expect(DEFAULT_BINDINGS).toEqual({
      p1: {
        up: 'KeyW',
        left: 'KeyA',
        down: 'KeyS',
        right: 'KeyD',
        fire: 'KeyJ',
        pause: 'Escape',
      },
      p2: {
        up: 'ArrowUp',
        left: 'ArrowLeft',
        down: 'ArrowDown',
        right: 'ArrowRight',
        fire: 'Numpad0',
        fireAlt: 'ControlRight',
        pause: 'KeyP',
      },
    });
    expect(Object.isFrozen(DEFAULT_BINDINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BINDINGS.p1)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BINDINGS.p2)).toBe(true);
  });
});

describe('createInput — lifecycle', () => {
  it('polls a stable, allocation-free tuple', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    const a = input.poll();
    const b = input.poll();
    // The loop polls 60 times a second; a fresh pair of objects each tick would
    // be 7 200 allocations a minute for nothing.
    expect(b).toBe(a);
    expect(b[0]).toBe(a[0]);

    input.dispose();
  });

  it('dispose removes exactly the listeners it added', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    expect(r.adds()).toBe(3); // keydown, keyup, blur
    expect(r.live()).toBe(3);

    input.dispose();

    expect(r.removes()).toBe(r.adds());
    expect(r.live()).toBe(0);
  });

  it('dispose is idempotent and leaves a neutral intent', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyW');
    input.dispose();
    input.dispose();

    expect(r.removes()).toBe(3);
    const [p1, p2] = input.poll();
    expect(p1.dir).toBeNull();
    expect(p1.fire).toBe(false);
    expect(p2.dir).toBeNull();
  });
});

describe('createInput — the press latch (a tap shorter than one tick)', () => {
  // The defect this covers: every value the driver reports is a LEVEL sampled
  // once per 60 Hz tick, so a key that went down AND up between two polls was
  // never down as far as the simulation is concerned. A tick is 16.7 ms and a
  // fast tap is not much longer. Found at T6.1/T6.2, where Playwright's
  // synthetic presses landed inside one tick about half the time.

  it('reports a fire tap that came and went inside one tick', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    r.key('keyup', 'KeyJ'); // …all before the next poll
    expect(input.poll()[P1].fire).toBe(true);
    // …and exactly once: the latch is consumed by the poll that reports it, so
    // the core sees one clean press edge rather than a stuck level.
    expect(input.poll()[P1].fire).toBe(false);

    input.dispose();
  });

  it('reports a pause tap that came and went inside one tick', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'Escape');
    r.key('keyup', 'Escape');
    expect(input.poll()[P1].pause).toBe(true);
    expect(input.poll()[P1].pause).toBe(false);

    input.dispose();
  });

  it('reports a direction tap that came and went inside one tick', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyD');
    r.key('keyup', 'KeyD');
    expect(input.poll()[P1].dir).toBe(RIGHT);
    expect(input.poll()[P1].dir).toBe(null);

    input.dispose();
  });

  it('does not let a tap override a direction that is still held', () => {
    // The latch promises "a press survives to the next poll", not "a tap beats
    // the key under your thumb". Releasing the tapped key already fell back
    // through the stack, so the held key is the one still down.
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyW');
    expect(input.poll()[P1].dir).toBe(UP);
    r.key('keydown', 'KeyA');
    r.key('keyup', 'KeyA');
    expect(input.poll()[P1].dir).toBe(UP);

    input.dispose();
  });

  it('collapses several taps in one tick into a single press', () => {
    // A tick can only produce one press edge in the core, so three taps inside
    // one are one shot — not three queued ones that fire over three ticks.
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    for (let i = 0; i < 3; i++) {
      r.key('keydown', 'KeyJ');
      r.key('keyup', 'KeyJ');
    }
    expect(input.poll()[P1].fire).toBe(true);
    expect(input.poll()[P1].fire).toBe(false);
    expect(input.poll()[P1].fire).toBe(false);

    input.dispose();
  });

  it('still drops the level the moment a HELD key is released', () => {
    // The latch must not resurrect a release: the tap path only fires when the
    // press itself arrived after the previous poll.
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    expect(input.poll()[P1].fire).toBe(true);
    r.key('keyup', 'KeyJ');
    for (let i = 0; i < 20; i++) {
      expect(input.poll()[P1].fire).toBe(false);
    }

    input.dispose();
  });

  it('drops latched presses on blur', () => {
    // A tap made on the way out of the window must not fire a shot when the
    // player comes back.
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    r.key('keydown', 'KeyD');
    r.key('keydown', 'Escape');
    r.blur();
    const intent = input.poll()[P1];
    expect(intent.fire).toBe(false);
    expect(intent.dir).toBe(null);
    expect(intent.pause).toBe(false);

    input.dispose();
  });

  it('keeps auto-repeat from re-latching a key that is already down', () => {
    const r = rig();
    const input = createInput(DEFAULT_BINDINGS, r.target);

    r.key('keydown', 'KeyJ');
    input.poll(); // consumes the press
    r.key('keydown', 'KeyJ'); // the OS repeating a held key
    r.key('keydown', 'KeyJ');
    // Still throttled by the turbo: a repeat is not a new press.
    expect(input.poll()[P1].fire).toBe(false);

    input.dispose();
  });
});
