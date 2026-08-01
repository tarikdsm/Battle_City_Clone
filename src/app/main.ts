// Boot / composition root.
// Mounts and sizes the game canvas, brings up the screen machine and installs
// the global error rails (arch §12). No Three.js yet — the renderer lands in
// T2.2, and the real screens in T3.x; `boot` is a placeholder.

import { parseDebugFlags } from './debug';
import { createScreenMachine, type Screen } from './screens';

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

const uiRoot = document.querySelector<HTMLElement>('#ui');
if (!uiRoot) {
  throw new Error('#ui not found');
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const OVERLAY_STYLE =
  'position:fixed;inset:0;display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;gap:0.75rem;padding:1.5rem;' +
  'font:16px/1.5 system-ui,sans-serif;color:#e8e8e8;text-align:center;';

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

interface ErrorParams {
  message: string;
  details: string;
}

function isErrorParams(v: unknown): v is ErrorParams {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  return typeof rec.message === 'string' && typeof rec.details === 'string';
}

async function copyDetails(details: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(details);
    return true;
  } catch {
    return false; // clipboard denied or insecure context — the text stays on screen
  }
}

function button(label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.style.cssText =
    'font:inherit;padding:0.5rem 1rem;border:1px solid #666;border-radius:4px;' +
    'background:#1c1c1c;color:inherit;cursor:pointer;';
  return el;
}

/** Friendly, dependency-free crash screen: what happened, copy details, reload. */
function createErrorScreen(): Screen {
  let node: HTMLElement | null = null;
  return {
    enter(root: HTMLElement, params?: unknown): void {
      const p: ErrorParams = isErrorParams(params)
        ? params
        : { message: 'Unexpected error.', details: '' };

      const panel = document.createElement('section');
      panel.setAttribute('role', 'alert');
      panel.style.cssText = `${OVERLAY_STYLE}background:rgba(10,10,10,0.94);`;

      const heading = document.createElement('h1');
      heading.textContent = 'Something went wrong';
      heading.style.cssText = 'margin:0;font-size:1.5rem;';

      const message = document.createElement('p');
      message.textContent = p.message;
      message.style.cssText = 'margin:0;max-width:40rem;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:0.75rem;';

      const copy = button('Copy details');
      copy.addEventListener('click', () => {
        void copyDetails(p.details).then((ok) => {
          copy.textContent = ok ? 'Copied' : 'Copy failed';
        });
      });

      const reload = button('Reload');
      reload.addEventListener('click', () => {
        window.location.reload();
      });

      actions.append(copy, reload);
      panel.append(heading, message, actions);
      root.append(panel);
      node = panel;
    },
    leave(): void {
      node?.remove();
      node = null;
    },
  };
}

const screens = createScreenMachine(uiRoot);
screens.register('boot', createBootScreen());
screens.register('error', createErrorScreen());

// ---------------------------------------------------------------------------
// Error rails (arch §12)
// ---------------------------------------------------------------------------

const FRIENDLY = 'The game hit an unexpected error and had to stop.';

/** Everything a bug report needs, and nothing the player has to type. */
function describeFailure(what: string, err: unknown): string {
  const lines = [
    `Battle City — ${what}`,
    new Date().toISOString(),
    window.location.href,
    navigator.userAgent,
    '',
  ];
  lines.push(
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err),
  );
  return lines.join('\n');
}

let errorLatched = false;

function fail(what: string, err: unknown): void {
  if (errorLatched) {
    return; // first failure wins; a cascade must not rebuild the screen forever
  }
  errorLatched = true;
  try {
    screens.show('error', {
      message: FRIENDLY,
      details: describeFailure(what, err),
    });
  } catch {
    // The error screen itself failed. There is nothing left to fall back to.
  }
}

window.addEventListener('error', (event) => {
  if (event.target !== null && event.target !== window) {
    return; // a resource (image/script) failed to load, not a code fault
  }
  fail(event.message, event.error);
});

window.addEventListener('unhandledrejection', (event) => {
  fail('unhandled promise rejection', event.reason);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

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
