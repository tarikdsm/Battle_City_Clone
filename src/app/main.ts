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
import {
  concreteQuality,
  decideAutoQuality,
  sampleDevice,
} from '../render/post';
import { createRenderer, type Quality } from '../render/renderer';
import { parseDebugFlags } from './debug';
import { createErrorRail, createErrorScreen } from './errorScreen';
import { createLoop } from './loop';
import { createSession } from './session';
import { loadSettings } from './storage';
import { createScreenMachine, OVERLAY_STYLE, type Screen } from './screens';

/**
 * Resolves the settings vocabulary (`'auto' | 'low' | 'medium' | 'high'`) to the
 * three concrete levels the renderer accepts — arch §5's Auto probe.
 *
 * Order is the whole point: the `?quality=` debug flag beats the stored setting,
 * the stored setting beats the probe, and the probe's answer is **never written
 * back** (see `concreteQuality`). Sampling is skipped entirely when either
 * override is present, so an explicit choice does not pay a second of boot for
 * a number nobody will read.
 *
 * The probe belongs on the title screen (arch §5) — it lands here because the
 * title screen is T3.x and this preview is the only thing that owns a renderer.
 */
async function resolveQuality(override?: Quality): Promise<Quality> {
  const settled = concreteQuality(loadSettings().quality, override);
  if (settled !== null) {
    return settled;
  }
  return decideAutoQuality(await sampleDevice(window));
}

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
function createPreviewCaption(quality: Quality): Screen {
  let node: HTMLElement | null = null;
  return {
    enter(root: HTMLElement): void {
      const tag = document.createElement('p');
      tag.style.cssText =
        'position:fixed;left:12px;bottom:10px;margin:0;pointer-events:none;' +
        'font:12px/1 system-ui,sans-serif;color:#7fc4ff;opacity:0.65;';
      // The resolved preset is on screen because an Auto decision is otherwise
      // invisible: "why does this machine look softer than that one" has to be
      // answerable without a debugger.
      tag.textContent = `scene preview — T2.5 · quality ${quality}`;
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
 * The fixture the preview runs. Its **terrain rows and partials are transcribed
 * verbatim** from `tests/fixtures/level-mixed.json` — the layout the T2.3 brief
 * names for visual verification, chosen because it carries all six terrain kinds
 * plus partial brick and steel tiles. The rest of the level (`id`, `name` and
 * the 20-strong enemy queue) is the preview's own, so the four tank colours all
 * appear early; only the board is shared.
 *
 * It is transcribed rather than imported: `tsconfig.json` scopes the app program
 * to `src`, and reaching into `tests/` would pull the whole test tree into the
 * production typecheck. The duplication is dev-only and dies with this preview
 * when T3.2 lands the real play screen.
 */
const PREVIEW_TERRAIN: readonly string[] = [
  '...B.....B...',
  '..SS.....SS..',
  '.BBB.....BBB.',
  '.B.........B.',
  '.B..WWWWW..B.',
  '....W...W....',
  'TTT.WW.WW.TTT',
  '....W...W....',
  'IIII.....IIII',
  '.S.........S.',
  '.S...BBB...S.',
  '.....B.B.....',
  '.............',
];

const PREVIEW_PARTIALS: readonly { tx: number; ty: number; mask: number }[] = [
  { tx: 2, ty: 2, mask: 9 },
  { tx: 10, ty: 2, mask: 6 },
  { tx: 3, ty: 1, mask: 12 },
  { tx: 9, ty: 1, mask: 3 },
  { tx: 6, ty: 10, mask: 3 },
];

function previewLevel(): LevelData {
  const types: readonly EnemyType[] = ['basic', 'fast', 'power', 'armor'];
  const enemies: EnemyType[] = [];
  for (let i = 0; i < ENEMY_TOTAL; i++) {
    enemies.push(types[i % types.length]);
  }
  if (PREVIEW_TERRAIN.length !== FIELD_TILES) {
    throw new Error('preview terrain must be 13 rows');
  }
  return {
    version: 1,
    id: 'dev-scene-preview',
    name: 'Scene preview',
    terrain: [...PREVIEW_TERRAIN],
    partials: PREVIEW_PARTIALS.map((p) => ({ ...p })),
    enemies,
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
  // `void` + async IIFE rather than a top-level await: this module is the entry
  // chunk, and a top-level await there makes the whole bundle async. The 1 s
  // probe runs while the boot screen is up, so nothing is waiting on it but the
  // first frame — and a rejection lands on the `unhandledrejection` rail armed
  // above, which is where a boot failure belongs.
  void (async (): Promise<void> => {
    const quality = await resolveQuality(debug.quality);
    startPreview(quality);
  })();
} else {
  // Unchanged pre-T2.2 path: no GL context, so nothing owns the drawing buffer.
  const resizeCanvas = (): void => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function startPreview(quality: Quality): void {
  const renderer = createRenderer(canvas, quality);
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
      // The event pump (arch §3.1). `stepGame` clears `state.events` at the top
      // of the NEXT tick, so a consumer that defers to render time would miss a
      // brick hit whenever the loop catches up two steps in one frame — which is
      // exactly when things are being shot.
      for (let i = 0; i < state.events.length; i++) {
        renderer.onEvent(state.events[i]);
      }
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

  screens.register('play', createPreviewCaption(quality));
  screens.show('play');

  // `start()` re-baselines the clock; calling `tickOnce` by hand here would
  // measure dt from the epoch and burn a 10-step catch-up (T2.1 report §6).
  loop.start();
}
