// Boot / composition root.
// Brings up the screen machine, installs the global error rails (arch §12) and
// mounts the game canvas — in that order, deliberately. No Three.js yet: the
// renderer lands in T2.2 and the real screens in T3.x, so `boot` is a placeholder.

import { parseDebugFlags } from './debug';
import {
  createErrorRail,
  createErrorScreen,
  OVERLAY_STYLE,
} from './errorScreen';
import { createScreenMachine, type Screen } from './screens';

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

// The overlay root is resolved first and deliberately CANNOT fail: the error
// screen has to have somewhere to render, so a missing #ui falls back to <body>
// rather than throwing before the rails below are armed.
const uiRoot = document.querySelector<HTMLElement>('#ui') ?? document.body;

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

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

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
