// src/ui/menus.ts — the abstract navigation model and the shared screen chrome
// (GDD §5/§7, art §10, arch §8).
//
// ## Why the model is abstract
//
// GDD §7 gives four input devices for one job: "menu navigate" is WASD/arrows +
// Enter on a keyboard, a D-pad + A on a gamepad, and a tap on touch. If each
// screen listened for `keydown` itself, Phase 9 would have to reopen all nine of
// them. So every screen consumes exactly six events —
//
//     up · down · left · right · confirm · back
//
// — and the *only* place in the app that knows a keyboard exists is
// {@link navFromKey}. A gamepad poller and a touch handler are then two more
// producers of the same six values and no screen changes at all.
//
// ## The DOM half
//
// Art §10 asks for dark translucent panels, a gold selection accent, a cyan
// focus ring and 150 ms transitions. All of that is `styles.css`; this file
// builds the markup it styles and keeps exactly one class in sync with
// {@link MenuModel.index}. **DOM only** — nothing here may draw to the canvas,
// because the post chain's composer blit overwrites anything drawn after
// `renderer.render()` (T2.5).

import { sharedGamepads, type PadNavEvent } from '../input/gamepad';

// ---------------------------------------------------------------------------
// --- The vocabulary --------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * The six events. Defined in `input/gamepad.ts` and re-exported here, so the
 * vocabulary has exactly one definition: `input/` may not import `ui/` (arch
 * §2's layering), and a second copy of a six-string union is precisely the kind
 * of duplicate that stays correct until the day somebody adds a seventh.
 */
export type NavEvent = PadNavEvent;

/**
 * `KeyboardEvent.code` → a nav event, or `null` for "not ours" (the caller must
 * then leave the key alone: F5, Tab and the devtools chords are not the game's
 * to swallow).
 *
 * Both movement layouts are accepted at once. In game they are two *players*
 * (GDD §7), but a menu has one cursor, so P1's WASD and P2's arrows are the same
 * control here — which is also what makes a 2P session able to navigate from
 * either side of the keyboard.
 */
export function navFromKey(code: string): NavEvent | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up';
    case 'ArrowDown':
    case 'KeyS':
      return 'down';
    case 'ArrowLeft':
    case 'KeyA':
      return 'left';
    case 'ArrowRight':
    case 'KeyD':
      return 'right';
    // `KeyJ` and `Numpad0` are GDD §7's two fire buttons, and they confirm as
    // well: a player whose thumb is already on fire should not have to go
    // looking for Enter to start a game.
    case 'Enter':
    case 'NumpadEnter':
    case 'Space':
    case 'KeyJ':
    case 'Numpad0':
      return 'confirm';
    case 'Escape':
    case 'Backspace':
      return 'back';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// --- Items -----------------------------------------------------------------
// ---------------------------------------------------------------------------

interface CommonItem {
  readonly id: string;
  label: string;
  /** Secondary line under the label — a placeholder's reason, a warning. */
  hint?: string;
  /**
   * Focusable, but not usable. This is what makes Phase 8's Neo / Construction
   * / Custom entries read as *deliberate* rather than broken: they take the
   * cursor, they say why they are unavailable, and confirm refuses them.
   */
  disabled?: boolean;
}

export interface ActionItem extends CommonItem {
  kind: 'action';
}

/** A non-focusable text row: a section heading or a note. */
export interface LabelItem extends CommonItem {
  kind: 'label';
}

export interface ToggleItem extends CommonItem {
  kind: 'toggle';
  value: boolean;
}

export interface SliderItem extends CommonItem {
  kind: 'slider';
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

export interface ChoiceItem extends CommonItem {
  kind: 'choice';
  value: string;
  options: readonly ChoiceOption[];
}

/** A remappable key. `listening` is set while the screen waits for a press. */
export interface BindingItem extends CommonItem {
  kind: 'binding';
  code: string;
  listening: boolean;
}

export type MenuItem =
  ActionItem | LabelItem | ToggleItem | SliderItem | ChoiceItem | BindingItem;

export interface NavResult {
  /** The cursor landed on a different row. */
  readonly moved: boolean;
  /** The row whose value actually changed, or `null`. */
  readonly changed: MenuItem | null;
  /** The row confirm activated (action / binding), or `null`. */
  readonly activated: MenuItem | null;
  /** `back` was pressed. */
  readonly back: boolean;
  /** Confirm landed on a disabled row — the cue for the *nope* sound. */
  readonly rejected: boolean;
}

export interface MenuModel {
  readonly items: readonly MenuItem[];
  index(): number;
  focused(): MenuItem | null;
  /** Move the cursor. Returns false when `i` is not a focusable row. */
  setIndex(i: number): boolean;
  /** Move the cursor to a row by id. Returns false when there is no such row. */
  focusId(id: string): boolean;
  handle(ev: NavEvent): NavResult;
}

const NOTHING: NavResult = Object.freeze({
  moved: false,
  changed: null,
  activated: null,
  back: false,
  rejected: false,
});

function focusable(item: MenuItem): boolean {
  return item.kind !== 'label';
}

/**
 * Snap a slider onto its own step grid.
 *
 * Volumes step by 0.05, and 0.7 − 0.05 is 0.6499999999999999 in binary floating
 * point — so a few key presses would persist a value that is not on the grid,
 * and the label would read "65%" one press and "64%" the next. Rounding to the
 * grid *and* then to a fixed precision is what keeps `0.6` exactly `0.6`.
 */
function onGrid(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.min(max, Math.max(min, Math.round(snapped * 1e6) / 1e6));
}

export function createMenu(items: MenuItem[]): MenuModel {
  let index = items.findIndex(focusable);
  if (index < 0) {
    index = 0;
  }

  function step(delta: number): boolean {
    const n = items.length;
    for (let i = 1; i <= n; i++) {
      const next = (((index + delta * i) % n) + n) % n;
      if (focusable(items[next])) {
        const moved = next !== index;
        index = next;
        return moved;
      }
    }
    return false;
  }

  /** left = −1, right = +1. Returns the row if its value actually moved. */
  function adjust(item: MenuItem, delta: -1 | 1): MenuItem | null {
    switch (item.kind) {
      case 'slider': {
        const next = onGrid(
          item.value + delta * item.step,
          item.min,
          item.max,
          item.step,
        );
        if (next === item.value) {
          return null;
        }
        item.value = next;
        return item;
      }
      case 'choice': {
        const n = item.options.length;
        if (n === 0) {
          return null;
        }
        const at = item.options.findIndex((o) => o.value === item.value);
        const next = ((((at < 0 ? 0 : at) + delta) % n) + n) % n;
        if (item.options[next].value === item.value) {
          return null;
        }
        item.value = item.options[next].value;
        return item;
      }
      case 'toggle': {
        // Left is off and right is on, rather than "either flips": a held key
        // that flip-flopped a setting sixty times a second would be unusable,
        // and an explicit direction is also what a slider-shaped row implies.
        const next = delta > 0;
        if (next === item.value) {
          return null;
        }
        item.value = next;
        return item;
      }
      default:
        return null;
    }
  }

  return {
    items,

    index(): number {
      return index;
    },

    focused(): MenuItem | null {
      const item: MenuItem | undefined = items[index];
      return item !== undefined && focusable(item) ? item : null;
    },

    setIndex(i: number): boolean {
      if (i < 0 || i >= items.length || !focusable(items[i])) {
        return false;
      }
      index = i;
      return true;
    },

    focusId(id: string): boolean {
      return this.setIndex(items.findIndex((item) => item.id === id));
    },

    handle(ev: NavEvent): NavResult {
      if (ev === 'back') {
        return { ...NOTHING, back: true };
      }
      if (ev === 'up' || ev === 'down') {
        return { ...NOTHING, moved: step(ev === 'up' ? -1 : 1) };
      }

      const item: MenuItem | undefined = items[index];
      if (item === undefined || !focusable(item) || item.disabled === true) {
        // A disabled row still answers confirm — with a refusal, so the screen
        // can play the *back* cue instead of leaving the press unacknowledged.
        return { ...NOTHING, rejected: ev === 'confirm' };
      }

      if (ev === 'left' || ev === 'right') {
        return { ...NOTHING, changed: adjust(item, ev === 'left' ? -1 : 1) };
      }

      // confirm
      if (item.kind === 'toggle') {
        item.value = !item.value;
        return { ...NOTHING, changed: item };
      }
      if (item.kind === 'action' || item.kind === 'binding') {
        return { ...NOTHING, activated: item };
      }
      // A slider or a choice has nothing to "open"; left/right is its editor.
      return NOTHING;
    },
  };
}

// ---------------------------------------------------------------------------
// --- The DOM chrome (art §10) ----------------------------------------------
// ---------------------------------------------------------------------------

export function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export interface ScreenChrome {
  /** The `<section>` the screen lives in. Carries `data-screen`. */
  readonly node: HTMLElement;
  /** Where a screen puts its own content. */
  readonly body: HTMLElement;
  /** Bottom strip for the control legend. */
  readonly footer: HTMLElement;
  dispose(): void;
}

export interface ChromeOptions {
  /** `data-screen` — what the e2e suite and the capture script key on. */
  screen: string;
  title?: string;
  subtitle?: string;
  /** A dimming sheet over the board, for the modal overlays (GDD §5: pause). */
  modal?: boolean;
  /** Full-bleed with no panel box — the title screen. */
  bare?: boolean;
}

/**
 * Mounts art §10's panel into `root` and returns the pieces a screen fills in.
 *
 * Every screen goes through here, which is what makes the panel treatment one
 * decision instead of nine: `styles.css` owns the colours and the 150 ms
 * transition, and a screen only ever adds rows.
 */
export function mountChrome(
  root: HTMLElement,
  opts: ChromeOptions,
): ScreenChrome {
  const node = el('section', 'bc-screen');
  node.dataset.screen = opts.screen;
  if (opts.modal === true) {
    node.classList.add('is-modal');
  }

  const panel = el('div', opts.bare === true ? 'bc-panel is-bare' : 'bc-panel');
  if (opts.title !== undefined) {
    const heading = el('h1', 'bc-title', opts.title);
    heading.dataset.role = 'title';
    panel.append(heading);
  }
  if (opts.subtitle !== undefined) {
    panel.append(el('p', 'bc-subtitle', opts.subtitle));
  }

  const body = el('div', 'bc-body');
  const footer = el('div', 'bc-footer');
  panel.append(body, footer);
  node.append(panel);
  root.append(node);

  // The entrance transition (art §10: 150 ms slide/fade). Applied on the next
  // frame rather than inline, so the browser has a start state to animate FROM
  // — setting both states in one task produces no transition at all.
  requestAnimationFrame(() => {
    node.classList.add('is-in');
  });

  return {
    node,
    body,
    footer,
    dispose(): void {
      node.remove();
    },
  };
}

/** A one-line control legend. Copy is English sentence case (plan constraints). */
export function legend(
  footer: HTMLElement,
  ...pairs: [string, string][]
): void {
  footer.replaceChildren();
  for (const [keys, what] of pairs) {
    const row = el('span', 'bc-legend');
    row.append(el('kbd', undefined, keys), el('span', undefined, what));
    footer.append(row);
  }
}

export interface MenuView {
  readonly node: HTMLElement;
  /** Re-read the model: focus class, values, disabled state. */
  sync(): void;
  dispose(): void;
}

function valueText(item: MenuItem): string | null {
  switch (item.kind) {
    case 'slider':
      // Percent for a 0..1 slider, the raw number otherwise.
      return item.min === 0 && item.max === 1
        ? `${Math.round(item.value * 100)}%`
        : String(item.value);
    case 'choice': {
      const found = item.options.find((o) => o.value === item.value);
      return found?.label ?? item.value;
    }
    case 'toggle':
      return item.value ? 'On' : 'Off';
    case 'binding':
      return item.listening ? 'Press a key…' : keyLabel(item.code);
    default:
      return null;
  }
}

/**
 * A `KeyboardEvent.code` as a human would name the key.
 *
 * Deliberately mechanical rather than a lookup table of 100 entries: codes are
 * layout-independent identifiers (that is why the input layer stores them), so
 * "KeyJ" really is the key labelled J on a US board and stripping the prefix is
 * the honest rendering. Anything unrecognised prints its code, which is more
 * useful than a blank.
 */
export function keyLabel(code: string): string {
  if (code === '') {
    return '—';
  }
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  if (code.startsWith('Numpad')) {
    return `Num ${code.slice(6)}`;
  }
  if (code.startsWith('Arrow')) {
    return `${code.slice(5)} arrow`;
  }
  switch (code) {
    case 'ControlLeft':
      return 'Left Ctrl';
    case 'ControlRight':
      return 'Right Ctrl';
    case 'ShiftLeft':
      return 'Left Shift';
    case 'ShiftRight':
      return 'Right Shift';
    case 'Space':
      return 'Space';
    default:
      return code;
  }
}

/**
 * Renders a {@link MenuModel} as a list and keeps it in sync.
 *
 * `onPick(i)` is the pointer path: a click focuses the row and asks the screen
 * to confirm it. That is the whole of mouse support, and it is also the seam
 * Phase 9's touch layer reuses — a tap is a click, and nothing below this line
 * knows the difference.
 */
export function mountMenu(
  parent: HTMLElement,
  model: MenuModel,
  onPick?: (index: number) => void,
): MenuView {
  const list = el('ul', 'bc-menu');
  list.setAttribute('role', 'menu');

  interface Row {
    node: HTMLElement;
    value: HTMLElement | null;
    hint: HTMLElement | null;
  }
  const rows: Row[] = [];

  for (let i = 0; i < model.items.length; i++) {
    const item = model.items[i];
    const node = el('li', item.kind === 'label' ? 'bc-row is-label' : 'bc-row');
    node.dataset.item = item.id;
    node.setAttribute(
      'role',
      item.kind === 'label' ? 'presentation' : 'menuitem',
    );
    node.append(el('span', 'bc-row-label', item.label));

    let value: HTMLElement | null = null;
    if (item.kind !== 'label' && item.kind !== 'action') {
      value = el('span', 'bc-row-value');
      value.dataset.value = item.id;
      node.append(value);
    }
    if (item.kind === 'slider') {
      const bar = el('span', 'bc-bar');
      bar.append(el('span', 'bc-bar-fill'));
      node.insertBefore(bar, value);
    }
    let hint: HTMLElement | null = null;
    if (item.hint !== undefined) {
      hint = el('span', 'bc-row-hint', item.hint);
      node.append(hint);
    }

    if (onPick !== undefined && item.kind !== 'label') {
      node.addEventListener('click', () => {
        if (model.setIndex(i)) {
          onPick(i);
        }
      });
    }
    rows.push({ node, value, hint });
    list.append(node);
  }
  parent.append(list);

  function sync(): void {
    const at = model.index();
    for (let i = 0; i < rows.length; i++) {
      const item = model.items[i];
      const row = rows[i];
      row.node.classList.toggle('is-focused', i === at);
      row.node.classList.toggle('is-disabled', item.disabled === true);
      if (item.kind !== 'label') {
        row.node.setAttribute('aria-current', i === at ? 'true' : 'false');
        row.node.setAttribute(
          'aria-disabled',
          item.disabled === true ? 'true' : 'false',
        );
      }
      const text = valueText(item);
      if (
        row.value !== null &&
        text !== null &&
        row.value.textContent !== text
      ) {
        row.value.textContent = text;
      }
      if (item.kind === 'slider') {
        const fill = row.node.querySelector<HTMLElement>('.bc-bar-fill');
        if (fill !== null) {
          const span = item.max - item.min;
          const pct = span > 0 ? ((item.value - item.min) / span) * 100 : 0;
          fill.style.width = `${pct}%`;
        }
      }
      row.node.classList.toggle(
        'is-listening',
        item.kind === 'binding' && item.listening,
      );
    }
  }

  sync();

  return {
    node: list,
    sync,
    dispose(): void {
      list.remove();
    },
  };
}

/**
 * Subscribes to navigation on `target` — **keyboard and gamepad** — and returns
 * the remover.
 *
 * `preventDefault` fires only for keys the menu actually consumed — the arrows
 * scroll the page and Space pages down, so a menu that swallowed everything
 * would break the browser, and one that swallowed nothing would scroll the page
 * behind the panel on every cursor move.
 *
 * The gamepad half is here, and *only* here, for the reason this file's header
 * gives: every screen already consumes the same six abstract events, so a
 * second producer of them is one subscription in one place and no screen
 * changes at all (T9.1). It costs a rAF while a menu is open — the pads are a
 * polled device, and a menu that read them once per key press would read them
 * never. The hub's own `retainNav` gate is what keeps a run played on the pad
 * from queueing hundreds of cursor moves for the next screen that opens.
 */
export function attachNav(
  target: Window,
  onNav: (ev: NavEvent) => void,
  onRawKey?: (code: string) => boolean,
): () => void {
  const pads = sharedGamepads();
  const releaseNav = pads.retainNav();
  let frame: number | null = null;
  const pump = (): void => {
    pads.sample();
    for (const ev of pads.drainNav()) {
      onNav(ev);
    }
    frame = target.requestAnimationFrame(pump);
  };
  frame = target.requestAnimationFrame(pump);

  const listener = (e: KeyboardEvent): void => {
    if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') {
      // Auto-repeat is welcome on the cursor and nowhere else: a held Enter
      // would otherwise start a game and immediately confirm the next screen.
      if (onRawKey === undefined) {
        return;
      }
    }
    if (onRawKey?.(e.code) === true) {
      e.preventDefault();
      return;
    }
    const nav = navFromKey(e.code);
    if (nav === null) {
      return;
    }
    e.preventDefault();
    onNav(nav);
  };
  target.addEventListener('keydown', listener);
  return (): void => {
    target.removeEventListener('keydown', listener);
    if (frame !== null) {
      target.cancelAnimationFrame(frame);
      frame = null;
    }
    releaseNav();
  };
}
