// tests/input/touch.test.ts — the on-glass controls (GDD §7, art §10).
//
// Node environment: everything here is the *model* half of `touch.ts` — the
// vector→4-way mapping, the device gate and the reserved-zone arithmetic. The
// DOM half (pointer capture, the floating stick origin) is not reachable from
// here and is not pretended to be; the T9 report says which parts were verified
// by emulation and which by hardware.

import { describe, expect, it } from 'vitest';
import type { Dir } from '../../src/core/types';
import {
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  TOUCH_DEAD_ZONE,
  ZONE_MAX_PX,
  ZONE_MIN_PX,
  columnWidth,
  createTouchModel,
  isTouchDevice,
  touchLayout,
  zoneHeight,
} from '../../src/input/touch';
import { tileCssPx } from '../../src/render/sceneRoot';
import { TURBO_PERIOD_TICKS } from '../../src/input/latch';

const UP: Dir = 0;
const RIGHT: Dir = 1;
const DOWN: Dir = 2;
const LEFT: Dir = 3;

const P1 = 0;

describe('isTouchDevice — GDD §7: "only on touch devices"', () => {
  it('is false with no touch points at all', () => {
    expect(isTouchDevice({ navigator: { maxTouchPoints: 0 } })).toBe(false);
    expect(isTouchDevice({})).toBe(false);
  });

  it('is true on a phone: touch points and a coarse primary pointer', () => {
    expect(
      isTouchDevice({
        navigator: { maxTouchPoints: 5 },
        matchMedia: () => ({ matches: true }),
      }),
    ).toBe(true);
  });

  it('is false on a touchscreen laptop being used with a mouse', () => {
    // The case `maxTouchPoints > 0` alone gets wrong, and it is not exotic —
    // most current laptops report touch points. A virtual stick taking a third
    // of that screen would be a bug the player cannot dismiss.
    expect(
      isTouchDevice({
        navigator: { maxTouchPoints: 10 },
        matchMedia: (q) => ({ matches: q !== '(pointer: coarse)' }),
      }),
    ).toBe(false);
  });

  it('shows the controls when the pointer type cannot be asked about', () => {
    // Failing towards "show": a phone with no controls is unplayable, a desktop
    // with spurious ones is merely wrong.
    expect(isTouchDevice({ navigator: { maxTouchPoints: 1 } })).toBe(true);
  });

  it('asks about the PRIMARY pointer, not any pointer', () => {
    let asked = '';
    isTouchDevice({
      navigator: { maxTouchPoints: 5 },
      matchMedia: (q) => {
        asked = q;
        return { matches: true };
      },
    });
    expect(asked).toBe('(pointer: coarse)');
  });
});

describe('zoneHeight — the box the board must not be drawn in', () => {
  it('reserves less of a landscape viewport than of a portrait one', () => {
    // Same height, different orientation: the board is square, so height taken
    // in landscape costs both sides of it.
    expect(zoneHeight(900, 500)).toBeLessThan(zoneHeight(500, 900));
  });

  it('never falls below a usable thumb reach', () => {
    expect(zoneHeight(320, 200)).toBe(ZONE_MIN_PX);
  });

  it('never eats a tall screen', () => {
    expect(zoneHeight(1080, 2400)).toBe(ZONE_MAX_PX);
  });

  it('leaves the board the majority of the viewport at phone sizes', () => {
    // A Pixel-5-ish portrait viewport: the zone is a control strip, not half
    // the screen.
    const h = zoneHeight(393, 851);
    expect(h).toBeLessThan(851 * 0.35);
    expect(h).toBeGreaterThan(0);
  });

  it('rounds to whole pixels — the caller subtracts it from a layout', () => {
    expect(Number.isInteger(zoneHeight(393, 851))).toBe(true);
    expect(Number.isInteger(zoneHeight(851, 393))).toBe(true);
  });
});

describe('createTouchModel — the virtual stick (GDD §7)', () => {
  it('reports nothing until a thumb arrives', () => {
    const m = createTouchModel();
    const [p1, p2] = m.poll();
    expect(p1).toEqual({ dir: null, fire: false, pause: false });
    expect(p2).toEqual({ dir: null, fire: false, pause: false });
  });

  it('maps the thumb vector to the dominant axis, no diagonals', () => {
    const m = createTouchModel();
    const cases: [number, number, Dir][] = [
      [0, -1, UP],
      [1, 0, RIGHT],
      [0, 1, DOWN],
      [-1, 0, LEFT],
      [0.9, 0.5, RIGHT],
      [0.5, 0.9, DOWN],
    ];
    for (const [nx, ny, dir] of cases) {
      m.stickAt(nx, ny);
      expect(m.poll()[P1].dir, `(${nx},${ny})`).toBe(dir);
    }
  });

  it('holds the direction while the thumb stays put', () => {
    const m = createTouchModel();
    m.stickAt(1, 0);
    expect(m.poll()[P1].dir).toBe(RIGHT);
    // No further events — a thumb that is not moving fires none.
    expect(m.poll()[P1].dir).toBe(RIGHT);
    expect(m.poll()[P1].dir).toBe(RIGHT);
  });

  it('ignores a thumb inside the dead zone', () => {
    const m = createTouchModel();
    m.stickAt(TOUCH_DEAD_ZONE - 0.01, 0);
    expect(m.poll()[P1].dir).toBeNull();
    m.stickAt(TOUCH_DEAD_ZONE, 0);
    expect(m.poll()[P1].dir).toBe(RIGHT);
  });

  it('honours a custom dead zone', () => {
    const m = createTouchModel(0.8);
    m.stickAt(0.5, 0);
    expect(m.poll()[P1].dir).toBeNull();
    m.stickAt(0.9, 0);
    expect(m.poll()[P1].dir).toBe(RIGHT);
  });

  it('treats a slide as a release and a press, leaving nothing latched', () => {
    // The stick's own rule. If a slide pushed a second direction onto the latch
    // stack, lifting the thumb would resume the first one and the tank would
    // drive off on its own.
    const m = createTouchModel();
    m.stickAt(1, 0);
    expect(m.poll()[P1].dir).toBe(RIGHT);
    m.stickAt(0, -1);
    expect(m.poll()[P1].dir).toBe(UP);
    m.stickAt(0.1, 0.1); // back into the dead zone without lifting
    expect(m.poll()[P1].dir).toBeNull();
    m.stickAt(-1, 0);
    expect(m.poll()[P1].dir).toBe(LEFT);
    m.stickRelease();
    expect(m.poll()[P1].dir).toBeNull();
    expect(m.poll()[P1].dir).toBeNull();
  });

  it('survives a flick that lands entirely inside one tick', () => {
    // The same sub-tick latch the keyboard and the pad have (T6.3, T9.1). A
    // pointer stream is faster than 60 Hz and a tap on the glass is short.
    const m = createTouchModel();
    m.stickAt(0, -1);
    m.stickRelease();
    expect(m.poll()[P1].dir).toBe(UP);
    expect(m.poll()[P1].dir).toBeNull();
  });
});

describe('createTouchModel — the buttons (GDD §7)', () => {
  it('pulses fire at the same turbo rate as every other device', () => {
    const m = createTouchModel();
    m.firePress();
    const fired: boolean[] = [];
    for (let i = 0; i < TURBO_PERIOD_TICKS + 1; i++) {
      fired.push(m.poll()[P1].fire);
    }
    expect(fired[0]).toBe(true);
    for (let i = 1; i < TURBO_PERIOD_TICKS; i++) {
      expect(fired[i]).toBe(false);
    }
    expect(fired[TURBO_PERIOD_TICKS]).toBe(true);
  });

  it('reports a tap that begins and ends between two polls', () => {
    const m = createTouchModel();
    m.firePress();
    m.fireRelease();
    expect(m.poll()[P1].fire).toBe(true);
    expect(m.poll()[P1].fire).toBe(false);
  });

  it('treats a repeated press as one press', () => {
    // Two pointers landing on one button, or a `pointerdown` the browser
    // delivers twice: one release must still stop the firing.
    const m = createTouchModel();
    m.firePress();
    m.firePress();
    expect(m.poll()[P1].fire).toBe(true);
    m.fireRelease();
    // Drain the tap latch from the press above, then confirm it is really off.
    m.poll();
    expect(m.poll()[P1].fire).toBe(false);
  });

  it('reports the pause button as a held level and a tap', () => {
    const m = createTouchModel();
    m.pausePress();
    expect(m.poll()[P1].pause).toBe(true);
    m.pauseRelease();
    expect(m.poll()[P1].pause).toBe(false);

    m.pausePress();
    m.pauseRelease();
    expect(m.poll()[P1].pause, 'a sub-tick tap still pauses').toBe(true);
  });

  it('drives P1 and never P2', () => {
    const m = createTouchModel();
    m.stickAt(1, 0);
    m.firePress();
    m.pausePress();
    const [, p2] = m.poll();
    expect(p2).toEqual({ dir: null, fire: false, pause: false });
  });

  it('clear() drops the stick and both buttons', () => {
    const m = createTouchModel();
    m.stickAt(1, 0);
    m.firePress();
    m.pausePress();
    m.clear();
    const [p1] = m.poll();
    expect(p1).toEqual({ dir: null, fire: false, pause: false });
    expect(m.dir()).toBeNull();
    // …and it is not a one-shot: the next press still works.
    m.firePress();
    expect(m.poll()[P1].fire).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Where the controls go (T9 follow-up)
// ---------------------------------------------------------------------------

/** The measured Pixel 5 landscape viewport, and what the HUD docks right. */
const LANDSCAPE_W = 802;
const LANDSCAPE_H = 294;
const HUD_RIGHT = 139;

describe('touchLayout — a strip or two columns', () => {
  it('always takes the bottom in portrait', () => {
    expect(touchLayout(394, 727)).toBe('bottom');
    expect(touchLayout(420, 900, 0)).toBe('bottom');
  });

  it('takes the side columns on a phone in landscape', () => {
    expect(touchLayout(LANDSCAPE_W, LANDSCAPE_H, HUD_RIGHT)).toBe('columns');
  });

  it('falls back to the strip when there is no horizontal slack', () => {
    // A near-square landscape viewport — a tablet. Columns would start eating
    // the board, and there the strip really is better.
    expect(touchLayout(760, 700, HUD_RIGHT)).toBe('bottom');
  });

  it('counts the HUD dock against the slack', () => {
    // The HUD takes the right in landscape, so the space the board can occupy
    // is narrower than the viewport — measuring slack against the viewport
    // would hand the columns room that is not theirs.
    const w = LANDSCAPE_H + 2 * COLUMN_MIN_PX + HUD_RIGHT;
    expect(touchLayout(w, LANDSCAPE_H, HUD_RIGHT)).toBe('columns');
    expect(touchLayout(w - 1, LANDSCAPE_H, HUD_RIGHT)).toBe('bottom');
  });
});

describe('columnWidth', () => {
  it('clamps to something a thumb can use', () => {
    expect(columnWidth(LANDSCAPE_W, LANDSCAPE_H, HUD_RIGHT)).toBe(
      COLUMN_MAX_PX,
    );
    expect(columnWidth(400, 390, HUD_RIGHT)).toBe(COLUMN_MIN_PX);
  });

  it('is a whole number of pixels — the caller subtracts it from a layout', () => {
    expect(Number.isInteger(columnWidth(901, 400, 139))).toBe(true);
  });
});

/**
 * The readability claim, as arithmetic.
 *
 * `tileCssPx` comes from `sceneRoot.ts` and is the camera's own contain-fit, so
 * this is not a re-statement of the layout's intent — it is what the renderer
 * will actually do with the box the layout hands it.
 */
describe('the landscape board is playable (T9 follow-up)', () => {
  const available = LANDSCAPE_W - HUD_RIGHT; // 663

  it('is bound by HEIGHT, which is why a bottom strip was the wrong shape', () => {
    // Taking width away changes nothing until it starts to bind; taking height
    // away costs immediately. That asymmetry is the whole argument.
    expect(tileCssPx(available, LANDSCAPE_H)).toBeCloseTo(
      tileCssPx(available - 2 * COLUMN_MAX_PX, LANDSCAPE_H),
      5,
    );
    expect(tileCssPx(available, LANDSCAPE_H - 116)).toBeLessThan(
      tileCssPx(available, LANDSCAPE_H) * 0.7,
    );
  });

  it('gives the columns layout a materially bigger tile than the strip', () => {
    const strip = tileCssPx(
      available,
      LANDSCAPE_H - zoneHeight(LANDSCAPE_W, LANDSCAPE_H),
    );
    const columns = tileCssPx(
      available - 2 * columnWidth(LANDSCAPE_W, LANDSCAPE_H, HUD_RIGHT),
      LANDSCAPE_H,
    );
    expect(strip).toBeLessThan(13);
    expect(columns).toBeGreaterThan(20);
    expect(columns / strip).toBeGreaterThan(1.6);
  });

  it('costs nothing against reserving no space at all', () => {
    // The columns take space a square board could not have used. If this ever
    // stops being true, the clamp has drifted past the slack.
    const columns = tileCssPx(
      available - 2 * columnWidth(LANDSCAPE_W, LANDSCAPE_H, HUD_RIGHT),
      LANDSCAPE_H,
    );
    expect(columns).toBeCloseTo(tileCssPx(available, LANDSCAPE_H), 5);
  });
});
