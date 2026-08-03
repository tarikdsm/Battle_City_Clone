// src/app/screens.ts — typed screen state machine (arch §8, GDD §5).
//
// It owns the *which screen is on stage* question and nothing else: it holds no
// DOM of its own, it just hands the shared root to whichever screen it enters.

export type ScreenName =
  | 'boot'
  | 'title'
  | 'menu'
  | 'stageSelect'
  | 'intro'
  | 'play'
  | 'pause'
  | 'tally'
  | 'gameOver'
  | 'hiScore'
  | 'settings'
  | 'editor'
  | 'customLevels'
  | 'error';

export interface Screen {
  /** Mount into `root`. Called once per visit; `params` is screen-specific. */
  enter(root: HTMLElement, params?: unknown): void;
  /** Unmount and release everything `enter` created. */
  leave(): void;
}

export interface ScreenMachine {
  register(name: ScreenName, s: Screen): void;
  show(name: ScreenName, params?: unknown): void;
  current(): ScreenName;

  /**
   * Put a screen **over** the current one without leaving it (T6.1).
   *
   * GDD §5 draws Intro, Pause and Tally as nodes in the same flow as Play, and
   * they are — from the player's side. From the app's side they cannot be
   * *replacements* for it: the play screen owns the WebGL context, the audio
   * context, the simulation and the loop, so `show('pause')` would tear all
   * four down and `show('play')` would rebuild them, losing the run. (That is
   * not a hypothetical: `createPlayScreen.leave()` disposes the renderer, which
   * forces a GL context loss.)
   *
   * So the machine has two layers. Everything the player navigates *between* is
   * a screen; the three that sit over a live, frozen simulation are overlays. A
   * second `showOverlay` replaces the first — overlays do not stack, because
   * nothing in GDD §5 stacks them and a stack is a state a `back` press can get
   * lost in.
   */
  showOverlay(name: ScreenName, params?: unknown): void;
  /** Remove the overlay, if any. Idempotent. */
  hideOverlay(): void;
  currentOverlay(): ScreenName | null;
}

/**
 * Baseline look for a full-bleed screen panel: centred column over the canvas.
 * It lives with the screen machine because it belongs to *every* screen —
 * T3.x's title/menu/pause and the error screen alike. (Placeholder styling
 * until the UI layer gets real CSS with custom properties, arch §8.)
 */
export const OVERLAY_STYLE =
  'position:fixed;inset:0;display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;gap:0.75rem;padding:1.5rem;' +
  'font:16px/1.5 system-ui,sans-serif;color:#e8e8e8;text-align:center;';

/**
 * A screen whose module is fetched the first time it is shown (arch §9's
 * "route `#editor` (code-split chunk)").
 *
 * The construction mode is a second application living inside this one — a
 * 26×26 painting surface, a wave editor, a validator and a share codec — and a
 * player who never opens it should not pay for its bytes on the boot path. A
 * `Screen` whose `enter` is synchronous cannot express that on its own, so this
 * adapter does: it shows `whileLoading` (the boot panel, in `main.ts`), awaits
 * the dynamic import, then enters the real screen with the same `params`.
 *
 * **DOM-free on purpose.** The placeholder is injected rather than built here,
 * which is what lets `tests/app/screens.test.ts` cover every path of this in
 * Vitest's node environment, where `document` does not exist.
 *
 * A rejected import is deliberately left unhandled: `main.ts` arms
 * `unhandledrejection` before the first screen exists, so a chunk that fails to
 * load lands on the error screen with its real message instead of being
 * swallowed into a blank panel.
 */
export function createLazyScreen(
  load: () => Promise<Screen>,
  whileLoading?: Screen,
): Screen {
  let real: Screen | null = null;
  /** `real.enter` has been called and its `leave` has not. */
  let entered = false;
  /** This screen is on stage right now. */
  let active = false;
  let waiting = false;

  return {
    enter(root: HTMLElement, params?: unknown): void {
      active = true;
      if (real !== null) {
        real.enter(root, params);
        entered = true;
        return;
      }
      whileLoading?.enter(root, params);
      waiting = true;
      void load().then((screen) => {
        // Cached even if the player has already navigated away — the module is
        // loaded either way, and the next visit should be instant.
        real = screen;
        if (!active || entered) {
          return;
        }
        if (waiting) {
          whileLoading?.leave();
          waiting = false;
        }
        screen.enter(root, params);
        entered = true;
      });
    },

    leave(): void {
      active = false;
      if (waiting) {
        whileLoading?.leave();
        waiting = false;
      }
      if (entered) {
        real?.leave();
        entered = false;
      }
    },
  };
}

export function createScreenMachine(root: HTMLElement): ScreenMachine {
  const registry = new Map<ScreenName, Screen>();
  // `null` = nothing mounted yet, which is what makes the very first
  // `show('boot')` a real entry rather than a no-op self-transition.
  let active: { name: ScreenName; screen: Screen } | null = null;
  let overlay: { name: ScreenName; screen: Screen } | null = null;

  function lookup(name: ScreenName): Screen {
    const found = registry.get(name);
    if (!found) {
      throw new Error(`unknown screen: ${name}`);
    }
    return found;
  }

  function dropOverlay(): void {
    overlay?.screen.leave();
    overlay = null;
  }

  return {
    register(name: ScreenName, s: Screen): void {
      registry.set(name, s);
    },

    show(name: ScreenName, params?: unknown): void {
      const next = lookup(name);
      if (active?.name === name) {
        return; // already on stage — re-entering would rebuild it for nothing
      }
      // An overlay belongs to the screen underneath it, so changing that screen
      // takes the overlay with it. Dropped BEFORE the outgoing screen leaves,
      // so teardown runs top-down and an overlay can never outlive the
      // simulation it was reading.
      dropOverlay();
      active?.screen.leave();
      active = { name, screen: next };
      next.enter(root, params);
    },

    current(): ScreenName {
      // Before the first show the app is, by definition, still booting.
      return active?.name ?? 'boot';
    },

    showOverlay(name: ScreenName, params?: unknown): void {
      const next = lookup(name);
      if (overlay?.name === name) {
        return;
      }
      dropOverlay();
      overlay = { name, screen: next };
      next.enter(root, params);
    },

    hideOverlay(): void {
      dropOverlay();
    },

    currentOverlay(): ScreenName | null {
      return overlay?.name ?? null;
    },
  };
}
