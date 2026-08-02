// src/ui/screens/intro.ts — fidelity §11.1's "STAGE N".
//
// It is deliberately almost nothing: two lines of text over a board that is
// already doing the work. T4.3 built the beat — `cameraFx` runs art §2's 600 ms
// fly-in and art §10's twin steel shutters off `state.phase === 'intro'`, and
// core holds that phase for `STAGE_INTRO_S` — so this overlay only names the
// stage on top of it.
//
// **An overlay, not a screen**: it sits over the live play screen (`showOverlay`)
// because the simulation it is announcing is already running underneath. The
// first enemy spawns at t = 0, during this (fidelity §11.1).

import { el, mountChrome } from '../menus';
import type { Screen } from '../../app/screens';
import { STAGE_INTRO_S } from '../../core/constants';

export interface IntroParams {
  /** The 1…35 stage the player is told about (fidelity §11.5's looped label). */
  stage: number;
  /** For a 2P run, or a continued run. Optional second line. */
  note?: string;
}

export interface IntroScreenOptions {
  /** Called once the curtain beat is over, so the flow can drop the overlay. */
  onDone(): void;
}

export function createIntroScreen(opts: IntroScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    enter(root: HTMLElement, params?: unknown): void {
      const p = (params as IntroParams | undefined) ?? { stage: 1 };
      const view = mountChrome(root, { screen: 'intro' });
      chrome = view;

      const heading = el('h1', 'bc-stage-number', `Stage ${p.stage}`);
      heading.dataset.role = 'stage';
      view.body.append(heading);
      if (p.note !== undefined) {
        view.body.append(el('p', 'bc-subtitle', p.note));
      }

      // Wall-clock rather than the simulation's `phaseT`, and the difference is
      // visible only in one case: pausing during the intro. Core's phase clock
      // would freeze with the pause, but the pause overlay has already replaced
      // this one in the overlay slot by then, so there is nothing left to hold.
      // The flow ignores a `done` that arrives for an overlay no longer up.
      timer = setTimeout(() => {
        timer = null;
        opts.onDone();
      }, STAGE_INTRO_S * 1000);
    },

    leave(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      chrome?.dispose();
      chrome = null;
    },
  };
}
