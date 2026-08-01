// src/app/errorScreen.ts — the crash screen and the global error rail (arch §12).
//
// Split out of main.ts so the parts with real logic — the latch, the params
// guard, the report builder and the resource-error filter — are importable and
// testable without a DOM. Only `enter()` touches `document`, and nothing here
// runs at module load.

import type { Screen } from './screens';

/** What the player sees. The technical part goes in the copyable details. */
export const FRIENDLY_MESSAGE =
  'The game hit an unexpected error and had to stop.';

export interface ErrorParams {
  message: string;
  details: string;
}

export function isErrorParams(v: unknown): v is ErrorParams {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const rec = v as Record<string, unknown>;
  return typeof rec.message === 'string' && typeof rec.details === 'string';
}

/** Everything a bug report needs, and nothing the player has to type. */
export function describeFailure(what: string, err: unknown): string {
  const lines = [
    `Battle City — ${what}`,
    new Date().toISOString(),
    // Optional chaining, not a bare global: this function is called from tests
    // and could be called from a worker, where neither exists.
    globalThis.location?.href ?? '(no location)',
    globalThis.navigator?.userAgent ?? '(no user agent)',
    '',
  ];
  lines.push(
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The rail: turns raw error/rejection events into at most one call to `show`.
// ---------------------------------------------------------------------------

export type ErrorSink = (message: string, details: string) => void;

/** The fields we read off an `ErrorEvent`; `ErrorEvent` satisfies it. */
export interface ErrorEventLike {
  message?: unknown;
  error?: unknown;
  target?: unknown;
}

/** The field we read off a `PromiseRejectionEvent`. */
export interface RejectionEventLike {
  reason?: unknown;
}

export interface ErrorRail {
  onError(event: ErrorEventLike): void;
  onRejection(event: RejectionEventLike): void;
}

/**
 * @param show    called with (friendly message, copyable details) at most once
 * @param selfTarget the object that is the event target for *code* faults
 *                (the window). Events aimed at anything else are resource
 *                load failures, not crashes, and are ignored.
 */
export function createErrorRail(
  show: ErrorSink,
  selfTarget?: unknown,
): ErrorRail {
  let latched = false;

  function fail(what: string, err: unknown): void {
    if (latched) {
      return; // first failure wins; a cascade must not rebuild the screen forever
    }
    latched = true;
    try {
      show(FRIENDLY_MESSAGE, describeFailure(what, err));
    } catch {
      // The error screen itself failed. There is nothing left to fall back to.
    }
  }

  return {
    onError(event: ErrorEventLike): void {
      const target = event.target;
      if (target != null && target !== selfTarget) {
        return; // a resource (image/script) failed to load, not a code fault
      }
      fail(
        typeof event.message === 'string' && event.message.length > 0
          ? event.message
          : 'uncaught error',
        event.error,
      );
    },

    onRejection(event: RejectionEventLike): void {
      fail('unhandled promise rejection', event.reason);
    },
  };
}

// ---------------------------------------------------------------------------
// The screen itself.
// ---------------------------------------------------------------------------

export const OVERLAY_STYLE =
  'position:fixed;inset:0;display:flex;flex-direction:column;' +
  'align-items:center;justify-content:center;gap:0.75rem;padding:1.5rem;' +
  'font:16px/1.5 system-ui,sans-serif;color:#e8e8e8;text-align:center;';

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
export function createErrorScreen(): Screen {
  let node: HTMLElement | null = null;
  return {
    enter(root: HTMLElement, params?: unknown): void {
      const p: ErrorParams = isErrorParams(params)
        ? params
        : { message: FRIENDLY_MESSAGE, details: '' };

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
