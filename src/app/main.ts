// Boot / composition root.
//
// Brings up the screen machine, installs the global error rails (arch §12),
// mounts the game canvas and starts the play screen — in that order, and the
// order is deliberate: the rails go up before the first lookup that can throw.
//
// There is no title or menu yet (Phase 6), so this boots straight into a
// playable stage 1. The screen machine, the session and the debug flags are
// already the shapes those screens will slot into.

import { createSession } from './session';
import { parseDebugFlags } from './debug';
import { createErrorRail, createErrorScreen } from './errorScreen';
import { loadSettings } from './storage';
import { createScreenMachine, OVERLAY_STYLE, type Screen } from './screens';
import { validateLevel } from '../levels/schema';
import type { LevelData } from '../core/types';
import {
  concreteQuality,
  decideAutoQuality,
  sampleDevice,
} from '../render/post';
import type { Quality } from '../render/renderer';
import { createPlayScreen } from '../ui/screens/play';
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
  // Today every screen is position:fixed/inset:0, so <body> renders the same
  // and the fallback is invisible. That stops being true the moment a screen
  // relies on #ui's own stacking context or CSS, so say so out loud. A warning,
  // not an error: the e2e smoke asserts zero console ERRORS on a clean boot.
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

// --- the run ---------------------------------------------------------------

const session = createSession({
  // 2P and the player-count choice arrive with the menu (T6.2). Until then a
  // run is 1P, which is also what the spawn-cadence formula is tuned against.
  players: 1,
  // `?stage=` moves the stage NUMBER (spawn cadence and AI aggression scale
  // with it, fidelity §7/§9), not the layout — there is exactly one level until
  // Phase 7 transcribes the other 34.
  stageNumber: debug.stage ?? 1,
  seed: debug.seed,
});

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

// Resolution order (arch §5): `?quality=` debug flag → stored setting → probe.
// `null` here means "the player asked for Auto", which is the only case that
// pays for a sample.
const settled = concreteQuality(loadSettings().quality, debug.quality);

const play = createPlayScreen({
  canvas,
  level,
  session,
  quality: settled ?? PROBE_QUALITY,
});
screens.register('play', play);
screens.show('play');

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

/** Placeholder until the title screen lands (T6.1). */
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
