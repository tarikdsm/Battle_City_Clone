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
}

export function createScreenMachine(root: HTMLElement): ScreenMachine {
  const registry = new Map<ScreenName, Screen>();
  // `null` = nothing mounted yet, which is what makes the very first
  // `show('boot')` a real entry rather than a no-op self-transition.
  let active: { name: ScreenName; screen: Screen } | null = null;

  return {
    register(name: ScreenName, s: Screen): void {
      registry.set(name, s);
    },

    show(name: ScreenName, params?: unknown): void {
      const next = registry.get(name);
      if (!next) {
        throw new Error(`unknown screen: ${name}`);
      }
      if (active?.name === name) {
        return; // already on stage — re-entering would rebuild it for nothing
      }
      active?.screen.leave();
      active = { name, screen: next };
      next.enter(root, params);
    },

    current(): ScreenName {
      // Before the first show the app is, by definition, still booting.
      return active?.name ?? 'boot';
    },
  };
}
