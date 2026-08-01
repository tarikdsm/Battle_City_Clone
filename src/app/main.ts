// Boot / composition root.
// Brings up the screen machine, installs the global error rails (arch §12) and
// mounts the game canvas — in that order, deliberately. No Three.js yet: the
// renderer lands in T2.2 and the real screens in T3.x, so `boot` is a placeholder.

import { ENEMY_TOTAL, FIELD_TILES } from '../core/constants';
import { createGame, stepGame } from '../core/game';
import {
  NULL_INTENT,
  type EnemyType,
  type LevelData,
  type PlayerIntent,
} from '../core/types';
import { createRenderer, type Quality } from '../render/renderer';
import { parseDebugFlags } from './debug';
import { createErrorRail, createErrorScreen } from './errorScreen';
import { createLoop } from './loop';
import { createSession } from './session';
import { createScreenMachine, OVERLAY_STYLE, type Screen } from './screens';

/**
 * Settings carry a fourth `'auto'` quality that the renderer does not accept
 * (T2.1 report §6). The real Auto probe — DPR, `hardwareConcurrency`, a 1 s FPS
 * sample — is T2.5; until then anything unresolved starts at High, which is what
 * the preview wants anyway.
 */
const DEFAULT_QUALITY: Quality = 'high';

/** Placeholder until the title screen lands (T3.x). */
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

/**
 * A corner caption for the dev preview. It also keeps `#ui` non-empty, which the
 * e2e smoke asserts — the boot screen it replaces was the only thing in there.
 */
function createPreviewCaption(): Screen {
  let node: HTMLElement | null = null;
  return {
    enter(root: HTMLElement): void {
      const tag = document.createElement('p');
      tag.style.cssText =
        'position:fixed;left:12px;bottom:10px;margin:0;pointer-events:none;' +
        'font:12px/1 system-ui,sans-serif;color:#7fc4ff;opacity:0.65;';
      tag.textContent = 'scene preview — T2.2';
      root.append(tag);
      node = tag;
    },
    leave(): void {
      node?.remove();
      node = null;
    },
  };
}

/**
 * The fixture the preview runs: an empty board (terrain rendering is T2.3, so
 * anything painted here would be an invisible wall the tanks bump into) with the
 * four enemy types up front, so the first wave shows all four palette colours.
 * `noAutoBase` for the same reason — the brick ring around the eagle would be
 * invisible collision.
 */
function previewLevel(): LevelData {
  const types: readonly EnemyType[] = ['basic', 'fast', 'power', 'armor'];
  const enemies: EnemyType[] = [];
  for (let i = 0; i < ENEMY_TOTAL; i++) {
    enemies.push(types[i % types.length]);
  }
  return {
    version: 1,
    id: 'dev-scene-preview',
    name: 'Scene preview',
    terrain: Array.from({ length: FIELD_TILES }, () => '.'.repeat(FIELD_TILES)),
    enemies,
    noAutoBase: true,
  };
}

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
  // relies on #ui's own stacking context or CSS (e.g. the usual
  // `#ui { pointer-events: none }` with children re-enabling it), so say so
  // out loud. A warning, not an error: the e2e smoke asserts zero console
  // ERRORS on a clean boot.
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
const canvas = found; // non-null; narrowed type holds inside the resize closure.

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

// --- Dev-only scene preview (T2.2) ------------------------------------------
// The real play screen is T3.2; this exists so the board, camera rig and
// lighting are *visible* the moment they land, driven by the actual simulation
// rather than a mock. Gated on DEV, so a production bundle keeps exactly the
// pre-T2.2 behaviour (canvas sized to the window, boot screen, nothing drawn).
if (import.meta.env.DEV) {
  const renderer = createRenderer(canvas, debug.quality ?? DEFAULT_QUALITY);
  const state = createGame(previewLevel(), {
    players: 2, // both player colours on the board
    seed: debug.seed ?? createSession().seed,
    stageNumber: debug.stage ?? 1,
  });
  // No input layer yet (T3.1): the players sit still at their spawn tiles while
  // the enemy AI drives everything that moves, which is enough to see that the
  // interpolation is smooth and that spawns land on the right tiles.
  const intents: [PlayerIntent, PlayerIntent] = [NULL_INTENT, NULL_INTENT];

  const loop = createLoop({
    step(): void {
      stepGame(state, intents);
    },
    render(alpha, dtMs): void {
      renderer.render(state, alpha, dtMs);
    },
    isPaused(): boolean {
      return state.paused;
    },
  });

  const fitToWindow = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight);
  };
  fitToWindow();
  window.addEventListener('resize', fitToWindow);

  screens.register('play', createPreviewCaption());
  screens.show('play');

  // `start()` re-baselines the clock; calling `tickOnce` by hand here would
  // measure dt from the epoch and burn a 10-step catch-up (T2.1 report §6).
  loop.start();
} else {
  // Unchanged pre-T2.2 path: no GL context, so nothing owns the drawing buffer.
  const resizeCanvas = (): void => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}
