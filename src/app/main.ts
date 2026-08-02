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

import {
  absorbStage,
  advanceStage,
  commitScore,
  createSession,
  levelStageOf,
  loadProgress,
  loadTable,
  qualifies,
  runScores,
  stageTally,
  unlockStage,
  type Session,
} from './session';
import { parseDebugFlags } from './debug';
import { createErrorRail, createErrorScreen } from './errorScreen';
import { loadSettings, saveSettings, type SettingsV1 } from './storage';
import { createScreenMachine, OVERLAY_STYLE, type Screen } from './screens';
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
import { createStageSelectScreen } from '../ui/screens/stageSelect';
import { createIntroScreen } from '../ui/screens/intro';
import { createTallyScreen } from '../ui/screens/tally';
import { createGameOverScreen } from '../ui/screens/gameOver';
import { createHiScoreScreen } from '../ui/screens/hiScore';
import { originalStage } from '../levels/campaign';

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
  debug.quality !== undefined ||
  debug.enemies !== undefined
) {
  // Unreachable in a production bundle: parseDebugFlags returns all-inert flags
  // when `import.meta.env.DEV` is the literal `false` Vite substitutes.
  console.log('debug flags', debug);
}

screens.show('boot');

console.log('boot ok');

// --- the app's singletons ---------------------------------------------------

/**
 * The layout for a 1…35 stage number, ready to hand to core.
 *
 * `originalStage` validates rather than trusts the JSON — `resolveJsonModule`
 * types a stage file as a loose object literal (`version: number`, `terrain:
 * string[]`), so the validator is what turns it into a `LevelData`, and a
 * hand-edited row of the wrong length surfaces on the error screen instead of
 * as an out-of-bounds read three systems deep.
 *
 * `?enemies=` (dev-only) shortens the wave so the stage-clear beat and the
 * tally are reachable in a capture without twenty kills. It edits the LEVEL,
 * never a rule: `createGame` copies this array into the spawner queue and every
 * §7 behaviour runs against it unchanged.
 */
function stageLevel(levelStage: number): LevelData {
  const level = originalStage(levelStage);
  return debug.enemies === undefined
    ? level
    : { ...level, enemies: level.enemies.slice(0, debug.enemies) };
}

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

/**
 * The run in progress, or `null` on the title / in the menus. The attract
 * board's session is deliberately NOT held here: nothing about it is a run.
 */
let session: Session | null = null;

/**
 * The score waiting for initials, or `null`. Fidelity §13 puts the *decision*
 * (`qualifies`) before the screen, so this is set at the moment the run ends
 * and consumed by the entry's `commit`.
 */
let pendingEntry: { score: number; stage: number; playerIndex: 0 | 1 } | null =
  null;

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

  onStageCleared(state): void {
    if (session === null) {
      return;
    }
    // Fidelity §11.2: the stage's numbers are banked, progress is recorded, and
    // the tally shows what core counted — this layer adds no arithmetic.
    const columns = stageTally(state);
    const stage = levelStageOf(session.stageNumber);
    absorbStage(session, state);
    unlockStage(levelStageOf(session.stageNumber + 1));
    audio.playMusic('tally');
    // Same rule as the pause overlay: the tally sits over a live (cleared)
    // simulation, and an Escape that reached the pad would pause the run and
    // replace the tally with the pause menu.
    play.setInputSuspended(true);
    screens.showOverlay('tally', { stage, columns });
  },

  onGameOver(state): void {
    if (session === null) {
      return;
    }
    absorbStage(session, state);
    const scores = runScores(session);
    screens.show('gameOver', {
      scores,
      stage: levelStageOf(session.stageNumber),
      baseLost: !state.eagleAlive,
    });
  },
});
screens.register('play', play);

/**
 * Where `back` from the high-score table returns to.
 *
 * **GDD §5 does not say.** Its diagram hangs "High scores" off the main menu and
 * routes the post-run table "→ Title" (fidelity §13), and those are two
 * different answers for one screen — a table opened from the menu that dumped
 * the player onto the title would read as the game restarting itself. So the
 * caller sets the return, exactly as it does for Settings.
 */
let hiScoreReturn: () => void = () => {
  toTitle();
};

/** Where `back` from the settings screen returns to. Set before showing it. */
let settingsReturn: () => void = () => {
  toMenu('settings');
};

screens.register(
  'title',
  createTitleScreen({
    audio,
    topScore: () => loadTable()[0] ?? null,
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
        screens.show('stageSelect');
        return;
      }
      if (choice === 'scores') {
        hiScoreReturn = (): void => {
          toMenu('scores');
        };
        screens.show('hiScore', { table: loadTable() });
        return;
      }
      if (choice === 'settings') {
        settingsReturn = (): void => {
          toMenu('settings');
        };
        screens.show('settings');
        return;
      }
      // The three Phase 8 entries are disabled rows and never reach here.
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
      if (session === null) {
        return;
      }
      // A restart replays the CURRENT stage with the run's carryover intact —
      // the session is untouched, so lives and score are whatever they were
      // when the stage began. A fresh run is what the title screen is for.
      screens.hideOverlay();
      startStage(session);
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

screens.register(
  'stageSelect',
  createStageSelectScreen({
    audio,
    highest: () => loadProgress().highestStage,
    onBack: () => {
      toMenu('campaign');
    },
    onPick: (stage: number) => {
      startStage(
        createSession({ players: 1, stageNumber: stage, seed: debug.seed }),
      );
    },
  }),
);

screens.register(
  'intro',
  createIntroScreen({
    onDone: () => {
      // Only if it is still the thing on stage: pausing during the intro
      // replaces this overlay with the pause menu, and the timer is still
      // running when it does.
      if (screens.currentOverlay() === 'intro') {
        screens.hideOverlay();
      }
    },
  }),
);

screens.register(
  'tally',
  createTallyScreen({
    audio,
    onDone: () => {
      if (session === null) {
        toTitle();
        return;
      }
      // Fidelity §11.5: the counter rises, the campaign loops. `startStage`
      // reads `levelStageOf` for the label and hands core the raw number.
      advanceStage(session);
      startStage(session);
    },
  }),
);

screens.register(
  'gameOver',
  createGameOverScreen({
    audio,
    onDone: () => {
      toHiScore();
    },
  }),
);

screens.register(
  'hiScore',
  createHiScoreScreen({
    audio,
    commit: (initials: string) => {
      const pending = pendingEntry;
      pendingEntry = null;
      if (pending === null) {
        const table = loadTable();
        return { table, highlight: -1 };
      }
      const entry = {
        score: pending.score,
        initials,
        // The LOOPED stage, 1…35: `bc.scores.v1`'s validator rejects anything
        // outside that range, so a run that reached the internal stage 41 would
        // otherwise have its row silently dropped on the next load.
        stage: pending.stage,
      };
      const table = commitScore(entry);
      return { table, highlight: table.indexOf(entry) };
    },
    onDone: () => {
      hiScoreReturn();
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
  session = null;
  // GDD §5's "subtle attract camera drift over a diorama": the title mounts
  // over a real, running stage with no controls attached. Stage 1, always —
  // the title is the one board the player has not chosen, so a layout that
  // changed between visits would read as a bug rather than as variety.
  startBoard({
    session: createSession({ players: 1 }),
    level: stageLevel(1),
    attract: true,
  });
  screens.showOverlay('title');
  audio.playMusic('title');
}

function toMenu(focus?: string): void {
  session = null;
  screens.show('menu', focus === undefined ? undefined : { focus });
  audio.stopMusic();
}

/**
 * Put a run's current stage on the board and announce it.
 *
 * One number does both jobs and they are not the same number: `levelStageOf`
 * folds the run's rising counter onto 1…35 — which is the layout to load and
 * the label to show — while `run.stageNumber` itself goes to core untouched, so
 * the spawn cadence and the AI's base-rush weight keep tightening past stage 35
 * (fidelity §11.5).
 */
function startStage(run: Session): void {
  session = run;
  const stage = levelStageOf(run.stageNumber);
  const level = stageLevel(stage);
  if (import.meta.env.DEV) {
    // Which LAYOUT is on the board, not just which number is on the curtain.
    // The two were the same thing for the whole of Phase 6 — every stage played
    // stage 1 — and nothing on screen said so. A run that quietly serves the
    // wrong file is invisible from any single stage, so it gets a line.
    console.log('stage', stage, level.id, `(counter ${run.stageNumber})`);
  }
  startBoard({ session: run, level });
  screens.showOverlay('intro', { stage });
}

/**
 * Fidelity §13's fork: "if score beats table's 10th entry, arcade initials
 * entry → high-score table display → title".
 *
 * The 2P case takes the **higher** qualifying score, because the table is one
 * table and a cabinet asks for one set of initials at a time. GDD §8 keeps the
 * two scores separate through the run and this is the only place they meet;
 * offering two consecutive entry screens is a Phase 9 decision, not a §13 rule.
 */
function toHiScore(): void {
  // Fidelity §13's own answer for the post-run path.
  hiScoreReturn = (): void => {
    toTitle();
  };
  const table = loadTable();
  const best = session === null ? [] : runScores(session);
  const top = best.reduce<{ playerIndex: 0 | 1; score: number } | null>(
    (a, b) => (a === null || b.score > a.score ? b : a),
    null,
  );
  const stage = session === null ? 1 : levelStageOf(session.stageNumber);
  pendingEntry =
    top !== null && qualifies(table, top.score)
      ? { score: top.score, stage, playerIndex: top.playerIndex }
      : null;
  session = null;
  screens.show(
    'hiScore',
    pendingEntry === null ? { table } : { table, entry: pendingEntry },
  );
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
  startStage(
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
