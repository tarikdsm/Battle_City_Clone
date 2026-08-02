// Boot / composition root.
//
// Brings up the screen machine, installs the global error rails (arch §12),
// mounts the game canvas and runs GDD §5's flow — in that order, and the order
// is deliberate: the rails go up before the first lookup that can throw.
//
// ## What lives here and why
//
// This file owns the *flow* — which screen answers which outcome — because that
// is the composition root's job (arch §8) and because it is the only place that
// can see all of the screens at once. Every screen below it is a leaf: it takes
// callbacks, it never reaches for another screen, and it can therefore be read
// (and screenshotted) on its own.
//
// The three long-lived singletons are built here and injected downward:
//
// - the **screen machine** (two layers: screens, and the overlays that sit over
//   a live simulation — see `screens.ts`),
// - one **AudioSystem** for the whole app. An `AudioContext` is a scarce,
//   process-wide resource, and a campaign enters the play screen once per
//   stage; one context per stage would exhaust the browser's cap. It is also
//   what lets the menus use audio §5's `uiMove`/`uiSelect`/`uiBack`.
// - the live **settings**, which every screen reads through `settingsNow()` and
//   writes through `applySettings()`, so a change made in one place reaches the
//   audio graph, the renderer and the input layer in one call.

import { createSession, type Session } from './session';
import { parseDebugFlags } from './debug';
import { createErrorRail, createErrorScreen } from './errorScreen';
import { loadSettings, saveSettings, type SettingsV1 } from './storage';
import { createScreenMachine, OVERLAY_STYLE, type Screen } from './screens';
import { validateLevel } from '../levels/schema';
import type { LevelData } from '../core/types';
import { createAudio } from '../audio/audio';
import {
  concreteQuality,
  decideAutoQuality,
  sampleDevice,
} from '../render/post';
import type { Quality } from '../render/renderer';
import { createPlayScreen, type PlayRun } from '../ui/screens/play';
import { createTitleScreen } from '../ui/screens/title';
import { createMenuScreen, type MenuChoice } from '../ui/screens/menu';
import { createSettingsScreen, volumesFor } from '../ui/screens/settings';
import { createPauseScreen } from '../ui/screens/pause';
import { loadScores } from './storage';
import stage01 from '../levels/original/stage01.json';

/**
 * The preset the auto probe runs **under**.
 *
 * This is the fix for T2.5's inert fps term. The probe used to sample on the
 * boot screen, before any renderer existed: rAF was vsync-locked with nothing
 * to draw, so `fps` read ≈60 on every machine and `AUTO_THRESHOLDS.lowFps` /
 * `highFps` could not fire. The decision collapsed to DPR + cores, which is how
 * Auto could hand High to a device that cannot hold 60 fps at High.
 *
 * So the sample is taken while the game is **already drawing**, and it is taken
 * at High — the preset whose viability is the actual question. A device that
 * holds ≥55 fps under the heaviest chain has earned it; one that drops below 45
 * has answered "not even close" with a measurement rather than a core count.
 * The cost is up to one second of a heavy preset on a weak device, paid once.
 */
const PROBE_QUALITY: Quality = 'high';

// The overlay root is resolved first and deliberately CANNOT fail: the error
// screen has to have somewhere to render, so a missing #ui falls back to <body>
// rather than throwing before the rails below are armed.
//
// COUPLING: `document.body` is non-null here only because index.html loads this
// module from the END of <body>. TypeScript cannot catch a regression — it types
// `document.body` as non-nullable — so moving the <script> into <head> (or
// dropping `type="module"`) would break this silently.
const foundUiRoot = document.querySelector<HTMLElement>('#ui');
const uiRoot = foundUiRoot ?? document.body;
if (!foundUiRoot) {
  // Every screen is position:fixed/inset:0, so <body> renders the same and the
  // fallback is invisible. That stops being true the moment a screen relies on
  // #ui's own stacking context or CSS, so say so out loud. A warning, not an
  // error: the e2e smoke asserts zero console ERRORS on a clean boot.
  console.warn('#ui not found — mounting screens on <body> instead');
}

const screens = createScreenMachine(uiRoot);
screens.register('boot', createBootScreen());
screens.register('error', createErrorScreen());

// The rails go up before the first lookup that CAN throw (the canvas, below). A
// document without #game is exactly the kind of failure this screen exists for,
// and it would die uncaught if the handlers were registered afterwards.
const rail = createErrorRail((message, details) => {
  screens.show('error', { message, details });
}, window);

window.addEventListener('error', (event) => {
  rail.onError(event);
});
window.addEventListener('unhandledrejection', (event) => {
  rail.onRejection(event);
});

const found = document.querySelector<HTMLCanvasElement>('#game');
if (!found) {
  throw new Error('canvas#game not found');
}
const canvas = found;

const debug = parseDebugFlags(window.location.search, import.meta.env.DEV);
if (
  debug.overlay ||
  debug.stage !== undefined ||
  debug.seed !== undefined ||
  debug.quality !== undefined
) {
  // Unreachable in a production bundle: parseDebugFlags returns all-inert flags
  // when `import.meta.env.DEV` is the literal `false` Vite substitutes.
  console.log('debug flags', debug);
}

screens.show('boot');

console.log('boot ok');

// --- the app's singletons ---------------------------------------------------

// The level is validated rather than trusted, even though it ships in the
// bundle: `resolveJsonModule` types it as a loose object literal (`version:
// number`, `terrain: string[]`), so the validator is what turns it into a
// `LevelData` — and a hand-edited row of the wrong length surfaces on the error
// screen instead of as an out-of-bounds read three systems deep.
const parsed = validateLevel(stage01);
if (!parsed.ok) {
  throw new Error(`stage01.json is invalid:\n${parsed.errors.join('\n')}`);
}
const level: LevelData = parsed.level;

let settings: SettingsV1 = loadSettings();
const settingsNow = (): SettingsV1 => settings;

// Audio §2: the context is built **suspended** and only ever resumed from a
// real user gesture, which the input layer forwards (`createInput`). Built here
// rather than in the play screen so the menus can use it too.
const audio = createAudio();
audio.setVolumes(volumesFor(settings));

// Art §11's `prefers-reduced-motion`. Read once: it is an OS-level preference,
// and a screen that re-queried it per frame would be asking a media query 60
// times a second for an answer that changes about never.
const reducedMotion =
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Resolution order (arch §5): `?quality=` debug flag → stored setting → probe.
// `null` here means "the player asked for Auto", which is the only case that
// pays for a sample.
const settled = concreteQuality(settings.quality, debug.quality);

const play = createPlayScreen({
  canvas,
  quality: settled ?? PROBE_QUALITY,
  audio,
  settings: settingsNow,
  reducedMotion,
  onPauseChanged(paused: boolean): void {
    // Core owns the pause (P-26); this is the screen that answers it. Either
    // source can flip it — the player's Escape or the overlay's Resume — and
    // both arrive here as the same state change.
    if (paused) {
      // Suspend BEFORE the overlay mounts: from here on every key belongs to
      // the menu, so one Escape cannot both close a panel and unpause.
      play.setInputSuspended(true);
      screens.showOverlay('pause');
    } else if (screens.currentOverlay() === 'pause') {
      screens.hideOverlay();
      play.setInputSuspended(false);
    }
  },

  onStageCleared(): void {
    // T6.2 replaces this with the tally and the next stage.
    toTitle();
  },

  onGameOver(): void {
    // T6.2 replaces this with the game-over → high-score sequence.
    toTitle();
  },
});
screens.register('play', play);

/** Where `back` from the settings screen returns to. Set before showing it. */
let settingsReturn: () => void = () => {
  toMenu('settings');
};

screens.register(
  'title',
  createTitleScreen({
    audio,
    topScore: () => loadScores()[0] ?? null,
    onStart: () => {
      toMenu();
    },
  }),
);

screens.register(
  'menu',
  createMenuScreen({
    audio,
    onBack: () => {
      toTitle();
    },
    onChoose: (choice: MenuChoice) => {
      if (choice === 'campaign') {
        // T6.2 puts the stage-select screen here; until then Campaign starts a
        // fresh run at stage 1.
        startRun(createSession({ players: 1, seed: debug.seed }));
        return;
      }
      if (choice === 'settings') {
        settingsReturn = (): void => {
          toMenu('settings');
        };
        screens.show('settings');
        return;
      }
      // 'scores' lands with T6.2; the three Phase 8 entries are disabled rows
      // and never reach this callback.
    },
  }),
);

screens.register(
  'settings',
  createSettingsScreen({
    audio,
    read: settingsNow,
    apply: applySettings,
    onBack: () => {
      settingsReturn();
    },
  }),
);

screens.register(
  'pause',
  createPauseScreen({
    audio,
    read: settingsNow,
    apply: (next) => {
      applySettings(next);
      saveSettings(next);
    },
    onResume: () => {
      play.togglePause();
    },
    onRestart: () => {
      const state = play.state();
      if (state === null) {
        return;
      }
      // A restart is a fresh stage at the same number. T6.2 restores the run's
      // carryover here, once a run is more than one stage.
      screens.hideOverlay();
      startRun(createSession({ players: 1, stageNumber: state.stageNumber }));
    },
    onQuit: () => {
      toTitle();
    },
    onSettings: () => {
      settingsReturn = (): void => {
        // Back from settings during a run returns to the pause overlay, which
        // is still sitting over a frozen simulation.
        screens.showOverlay('pause');
      };
      // `showOverlay` replaces the pause overlay rather than stacking, so the
      // settings screen sits over the same live, frozen board — which is what
      // makes the high-contrast toggle previewable while it is being flipped.
      screens.showOverlay('settings');
    },
  }),
);

// --- the flow (GDD §5) ------------------------------------------------------

/** Swap what the board is running without disturbing the screen machine. */
function startBoard(run: PlayRun): void {
  if (screens.current() === 'play') {
    // Already on the board: `show('play')` would be a no-op (a self-transition
    // is ignored), so the run is swapped in place. This is also the path that
    // keeps one GL context across a whole campaign.
    screens.hideOverlay();
    play.start(run);
  } else {
    screens.show('play', run);
  }
}

function toTitle(): void {
  // GDD §5's "subtle attract camera drift over a diorama": the title mounts
  // over a real, running stage with no controls attached.
  startBoard({
    session: createSession({ players: 1 }),
    level,
    attract: true,
  });
  screens.showOverlay('title');
  audio.playMusic('title');
}

function toMenu(focus?: string): void {
  screens.show('menu', focus === undefined ? undefined : { focus });
  audio.stopMusic();
}

/**
 * Put a run on the board.
 *
 * There is exactly one level until Phase 7 transcribes the other 34, so the
 * layout is stage 1's whatever the number says. T6.2 adds the stage intro, the
 * per-run carryover and the 35-stage loop around this.
 */
function startRun(run: Session): void {
  startBoard({ session: run, level });
}

function applySettings(next: SettingsV1): void {
  settings = next;
  play.applySettings(next);
}

// --- boot into the flow -----------------------------------------------------

if (debug.stage !== undefined) {
  // `?stage=` means "put me on the board at stage N" — the path the capture
  // scripts and the calibration harnesses drive. Dev-only: `parseDebugFlags`
  // returns all-inert flags in a production bundle.
  startRun(
    createSession({ players: 1, stageNumber: debug.stage, seed: debug.seed }),
  );
} else {
  toTitle();
}

if (settled === null) {
  // `void` + async IIFE rather than a top-level await: this module is the entry
  // chunk, and a top-level await there makes the whole bundle async. The sample
  // runs over the first second of play — the loop is already drawing — and a
  // rejection lands on the `unhandledrejection` rail armed above.
  void (async (): Promise<void> => {
    const sample = await sampleDevice(window);
    const picked = decideAutoQuality(sample);
    play.setQuality(picked);
    if (import.meta.env.DEV) {
      // An Auto decision is otherwise invisible: "why does this machine look
      // softer than that one" has to be answerable without a debugger.
      console.log('auto quality', picked, sample);
    }
  })();
}

/** The first paint, before the title's board exists. */
function createBootScreen(): Screen {
  let node: HTMLElement | null = null;
  return {
    enter(root: HTMLElement): void {
      const panel = document.createElement('div');
      panel.style.cssText = OVERLAY_STYLE;
      panel.textContent = 'Loading…';
      root.append(panel);
      node = panel;
    },
    leave(): void {
      node?.remove();
      node = null;
    },
  };
}
