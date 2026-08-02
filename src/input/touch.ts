// src/input/touch.ts — GDD §7's fourth device: the on-glass controls.
//
// Two halves, and the split is the same one `hud.ts` uses:
//
// - **The model** (top) is pure. A virtual stick is a vector, and turning a
//   vector into one of four latched directions is arithmetic — so it is
//   arithmetic, in the node environment, in `tests/input/touch.test.ts`. So is
//   {@link isTouchDevice}, which is a policy decision that has to be *readable*
//   rather than discovered on a phone, and {@link zoneHeight}, which is the
//   number that keeps the controls off the playfield.
// - **The view** (bottom) is pointer events and DOM. Verified by screenshot at
//   two orientations, and — honestly — by emulation rather than by a phone: see
//   the T9 report's verification table.
//
// ## The one rule this file exists to keep
//
// Art §10 gives touch "a slim top bar + bottom control zone", and the reason
// that is a *layout* and not an overlay is that a thumb resting on the board is
// a thumb covering the board. So the control zone is a **reserved box**: it
// reports its height through {@link TouchControls.dock}, the play screen
// subtracts it from the viewport exactly as it already subtracts the HUD, and
// the board is drawn in what is left. The e2e suite asserts the two boxes are
// disjoint in both orientations, because "it looked fine" is not a measurement.
//
// ## Which player
//
// P1, always. Two thumbs are one player; a second player on the same glass has
// nowhere to stand, and GDD §7's touch column has one row per action rather than
// one per player.

import type { Dir, PlayerIntent } from '../core/types';
import { stickDir } from './gamepad';
import { createIntents, createPad } from './latch';
import type { IntentSource } from './input';

// ---------------------------------------------------------------------------
// The model (pure)
// ---------------------------------------------------------------------------

/**
 * How far the thumb must travel from where it landed, as a fraction of the
 * stick's radius, before the tank moves.
 *
 * The same 0.4 the gamepad uses (arch §7), and for the same reason: it is far
 * enough that resting a thumb does not drive, and near enough that a deliberate
 * push is instant. It is a *fraction* here because a virtual stick has no
 * hardware travel — its radius is however many CSS pixels the layout gave it.
 */
export const TOUCH_DEAD_ZONE = 0.4;

/** Fraction of the viewport height the control zone takes, by orientation. */
export const ZONE_FRACTION_PORTRAIT = 0.3;
export const ZONE_FRACTION_LANDSCAPE = 0.28;
/** Clamps. Below the minimum a thumb has no room; above it the board suffers. */
export const ZONE_MIN_PX = 116;
export const ZONE_MAX_PX = 250;

/**
 * The height the control zone reserves for a viewport, in CSS pixels.
 *
 * Landscape gets a smaller fraction of a smaller number — a phone on its side
 * is ~390 px tall and the board is square, so every pixel taken from the height
 * is taken from both sides of the board.
 */
export function zoneHeight(viewportW: number, viewportH: number): number {
  const fraction =
    viewportW >= viewportH ? ZONE_FRACTION_LANDSCAPE : ZONE_FRACTION_PORTRAIT;
  return Math.round(
    Math.min(ZONE_MAX_PX, Math.max(ZONE_MIN_PX, viewportH * fraction)),
  );
}

/** The slice of `Window` {@link isTouchDevice} reads. */
export interface TouchProbe {
  readonly navigator?: { readonly maxTouchPoints?: number };
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
}

/**
 * Should the on-glass controls be shown at all? (GDD §7: "only on touch
 * devices".)
 *
 * Two signals, and the second one is the interesting one. `maxTouchPoints > 0`
 * alone is wrong: a touchscreen laptop reports it, and a player using that
 * laptop with a keyboard would get a virtual stick eating a third of their
 * screen. `(pointer: coarse)` asks about the **primary** pointer — the one the
 * player is actually using — and it is false on exactly that laptop and true on
 * a phone.
 *
 * The composition is deliberately asymmetric: a coarse primary pointer is
 * required *not to be denied* rather than required to be confirmed, so an engine
 * with no `matchMedia` at all still shows the controls to a device that reports
 * touch points. Failing towards "show" is right for the one input a player
 * cannot work around: a phone with no controls is unplayable, while a laptop
 * with spurious controls is merely wrong.
 */
export function isTouchDevice(win: TouchProbe): boolean {
  const points = win.navigator?.maxTouchPoints ?? 0;
  if (points <= 0) {
    return false;
  }
  const coarse = win.matchMedia?.('(pointer: coarse)').matches;
  return coarse !== false;
}

/**
 * The device-independent half of the touch controls: a stick vector and three
 * buttons in, one `PlayerIntent` pair out.
 *
 * Every rule that makes it *feel* like the keyboard — the 4-way latch, the
 * 10 Hz turbo, the sub-tick press latch — comes from `latch.ts`, which is the
 * whole reason that module exists. What is added here is the stick's own rule:
 * a thumb sliding from right to up is a **release and a press**, not a second
 * direction added to the stack, so letting go leaves nothing held.
 */
export interface TouchModel extends IntentSource {
  /** The thumb is at `(nx, ny)`, in stick radii from where it landed. */
  stickAt(nx: number, ny: number): void;
  /** The thumb left the stick. */
  stickRelease(): void;
  firePress(): void;
  fireRelease(): void;
  pausePress(): void;
  pauseRelease(): void;
  /** The direction currently held, for the knob's own rendering. */
  dir(): Dir | null;
}

export function createTouchModel(deadZone = TOUCH_DEAD_ZONE): TouchModel {
  const pad = createPad();
  const intents = createIntents();
  let held: Dir | null = null;
  let firing = false;
  let pausing = false;

  const setDir = (next: Dir | null): void => {
    pad.moveDir(held, next);
    held = next;
  };

  return {
    stickAt(nx: number, ny: number): void {
      setDir(stickDir(nx, ny, deadZone));
    },

    stickRelease(): void {
      setDir(null);
    },

    firePress(): void {
      if (firing) {
        return; // a second pointer on the same button is not a second press
      }
      firing = true;
      pad.pressFire();
    },

    fireRelease(): void {
      if (!firing) {
        return;
      }
      firing = false;
      pad.releaseFire();
    },

    pausePress(): void {
      if (pausing) {
        return;
      }
      pausing = true;
      pad.pressPause();
    },

    pauseRelease(): void {
      if (!pausing) {
        return;
      }
      pausing = false;
      pad.releasePause();
    },

    dir(): Dir | null {
      return held;
    },

    poll(): readonly [PlayerIntent, PlayerIntent] {
      // P1 only — see the header. P2 is left neutral rather than omitted so the
      // merge in `input.ts` reads one shape from every source.
      pad.drain(intents[0]);
      return intents;
    },

    clear(): void {
      pad.reset();
      held = null;
      firing = false;
      pausing = false;
    },
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface TouchControls {
  /** The intents this overlay produces. Hand it to `createInput`. */
  readonly source: TouchModel;
  /**
   * Re-lay-out for the current viewport and report the space reserved at the
   * bottom, in CSS pixels. The caller subtracts it from the viewport, exactly
   * as it does for the HUD — the controls are *beside* the board, never over it.
   *
   * @param insetRight what the HUD has already taken on the right (landscape).
   *        The strip is inset by it so the fire button does not end up under the
   *        HUD column, and so the strip's box is exactly the width of the board
   *        above it — which is what makes "no overlap" a measurable claim rather
   *        than a visual impression.
   */
  dock(insetRight?: number): { bottom: number };
  dispose(): void;
}

export interface TouchControlsOptions {
  /** Called on the first touch — the audio context's user gesture. */
  onUserGesture?: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `setPointerCapture`, without the crash.
 *
 * It throws `NotFoundError` when the pointer id is no longer active — a tap so
 * short that `pointerup` was already delivered, a gesture the browser took over,
 * or a synthetic event from a harness. Uncaught, that reaches `main.ts`'s global
 * error rail and replaces the running game with the error screen, which is a
 * spectacular outcome for a thumb that lifted early. Capture is an
 * *optimisation* (it keeps a thumb that slides off the button reporting to it),
 * so failing to get it is not a failure at all.
 */
function capture(target: Element, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Not capturable — the events still arrive, they just stop at the edge.
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * A `<button>`, typed as one.
 *
 * `type="button"` is not cosmetic: the default is `submit`, and a button inside
 * any future form would navigate the page away mid-game.
 */
function button(className: string, label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = className;
  node.type = 'button';
  node.setAttribute('aria-label', label);
  return node;
}

/** A chevron ring, so the stick reads as four directions and not as a joystick. */
function stickGlyph(): HTMLElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 48 48');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', 'bc-touch-rose');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M24 6l4 5h-8zM24 42l-4-5h8zM6 24l5-4v8zM42 24l-5 4v-8z',
  );
  path.setAttribute('fill', 'currentColor');
  node.append(path);
  return node as unknown as HTMLElement;
}

/**
 * Mounts the on-glass controls into `root` (the screen machine's `#ui`).
 *
 * The stick's origin is **where the thumb lands**, not the centre of the pad.
 * A fixed origin means the first thing a player does on every touch is drag
 * their thumb back to a circle they cannot feel; a floating one means the pad is
 * a *region* and the stick appears under the thumb already centred. The knob is
 * drawn at the offset so the region still reads as a stick.
 */
export function createTouchControls(
  root: HTMLElement,
  opts: TouchControlsOptions = {},
): TouchControls {
  const model = createTouchModel();

  const node = el('div', 'bc-touch');
  node.dataset.touch = 'root';

  const stick = el('div', 'bc-touch-stick');
  stick.dataset.touch = 'stick';
  const base = el('div', 'bc-touch-stick-base');
  const knob = el('div', 'bc-touch-stick-knob');
  knob.dataset.touch = 'knob';
  base.append(stickGlyph());
  stick.append(base, knob);

  const fire = button('bc-touch-fire', 'Fire');
  fire.dataset.touch = 'fire';
  fire.append(el('span', 'bc-touch-fire-dot'));

  const pause = button('bc-touch-pause', 'Pause');
  pause.dataset.touch = 'pause';
  pause.append(
    el('span', 'bc-touch-pause-bar'),
    el('span', 'bc-touch-pause-bar'),
  );

  // Stick, pause, fire — left, centre, right. The DOM order IS the layout
  // order (`justify-content: space-between`), so it is also the tab order, and
  // putting the two thumbs at the two ends is the whole ergonomic argument.
  node.append(stick, pause, fire);
  root.append(node);

  /** The active stick pointer, its origin, and the radius in CSS pixels. */
  let stickPointer: number | null = null;
  let originX = 0;
  let originY = 0;
  let radius = 48;

  const gesture = (): void => {
    opts.onUserGesture?.();
  };

  function moveKnob(dx: number, dy: number): void {
    // Clamped to the radius: the knob is a readout of the direction, and one
    // that flew off with the thumb would stop being one.
    const len = Math.hypot(dx, dy);
    const scale = len > radius ? radius / len : 1;
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
  }

  const onStickDown = (e: PointerEvent): void => {
    if (stickPointer !== null) {
      return; // one thumb per stick
    }
    gesture();
    stickPointer = e.pointerId;
    const box = stick.getBoundingClientRect();
    // Half the shorter side: the pad is square by CSS, and taking the shorter
    // side keeps the radius honest if a layout ever makes it not so.
    radius = Math.max(24, Math.min(box.width, box.height) / 2);
    originX = e.clientX;
    originY = e.clientY;
    knob.style.left = `${e.clientX - box.left}px`;
    knob.style.top = `${e.clientY - box.top}px`;
    knob.classList.add('is-active');
    moveKnob(0, 0);
    capture(stick, e.pointerId);
    e.preventDefault();
  };

  const onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== stickPointer) {
      return;
    }
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    model.stickAt(dx / radius, dy / radius);
    moveKnob(dx, dy);
    e.preventDefault();
  };

  const onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== stickPointer) {
      return;
    }
    stickPointer = null;
    model.stickRelease();
    knob.classList.remove('is-active');
    knob.style.transform = '';
    e.preventDefault();
  };

  /** A button that reports press and release, and survives a thumb sliding off. */
  function wireButton(
    target: HTMLElement,
    press: () => void,
    release: () => void,
  ): void {
    let id: number | null = null;
    target.addEventListener('pointerdown', (e) => {
      if (id !== null) {
        return;
      }
      gesture();
      id = e.pointerId;
      capture(target, e.pointerId);
      target.classList.add('is-down');
      press();
      e.preventDefault();
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) {
        return;
      }
      id = null;
      target.classList.remove('is-down');
      release();
      e.preventDefault();
    };
    target.addEventListener('pointerup', end);
    // `pointercancel` is not an edge case on glass: the browser fires it when a
    // gesture is taken over (a system swipe, a call arriving). Without it the
    // button would be held down for ever, which for FIRE means a tank that
    // never stops shooting.
    target.addEventListener('pointercancel', end);
  }

  stick.addEventListener('pointerdown', onStickDown);
  stick.addEventListener('pointermove', onStickMove);
  stick.addEventListener('pointerup', onStickUp);
  stick.addEventListener('pointercancel', onStickUp);
  wireButton(
    fire,
    () => {
      model.firePress();
    },
    () => {
      model.fireRelease();
    },
  );
  wireButton(
    pause,
    () => {
      model.pausePress();
    },
    () => {
      model.pauseRelease();
    },
  );

  let lastHeight = -1;
  let lastInset = -1;

  return {
    source: model,

    dock(insetRight = 0): { bottom: number } {
      const landscape = window.innerWidth >= window.innerHeight;
      node.classList.toggle('landscape', landscape);
      node.classList.toggle('portrait', !landscape);
      const height = zoneHeight(window.innerWidth, window.innerHeight);
      // Written only when it moves: the play screen's `fit` runs from a
      // ResizeObserver on the document element, and an unconditional style
      // write would be a resize that re-triggers it for ever.
      if (height !== lastHeight) {
        lastHeight = height;
        node.style.height = `${height}px`;
      }
      if (insetRight !== lastInset) {
        lastInset = insetRight;
        node.style.right = `${insetRight}px`;
      }
      return { bottom: height };
    },

    dispose(): void {
      model.clear();
      node.remove();
    },
  };
}
