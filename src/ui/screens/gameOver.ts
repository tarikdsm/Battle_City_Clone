// src/ui/screens/gameOver.ts — fidelity §13's treatment.
//
// "Game over → if score beats table's 10th entry, arcade initials entry → high
// score table display → title."
//
// The *decision* is not made here: `qualifies` (session.ts) owns it, and the
// flow in `main.ts` routes to the right next screen. This screen is the beat,
// and it waits for a key rather than a timer — a run that ended badly deserves
// a moment the player controls.

import { attachNav, el, legend, mountChrome } from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';

export interface GameOverParams {
  /** One line per active player (GDD §8: scores are per player in 2P). */
  scores: { playerIndex: 0 | 1; score: number }[];
  /** The 1…35 stage the run ended on. */
  stage: number;
  /** True when the eagle fell rather than the lives running out. */
  baseLost?: boolean;
}

export interface GameOverScreenOptions {
  onDone(): void;
  audio?: AudioSystem | null;
}

export function createGameOverScreen(opts: GameOverScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement, params?: unknown): void {
      const p = (params as GameOverParams | undefined) ?? {
        scores: [],
        stage: 1,
      };
      const view = mountChrome(root, { screen: 'gameOver', modal: true });
      chrome = view;

      const heading = el('h1', 'bc-gameover', 'Game over');
      heading.dataset.role = 'gameOver';
      view.body.append(heading);
      view.body.append(
        el(
          'p',
          'bc-subtitle',
          p.baseLost === true
            ? `The base fell on stage ${p.stage}.`
            : `Out of lives on stage ${p.stage}.`,
        ),
      );
      for (const row of p.scores) {
        const line = el(
          'p',
          'bc-final',
          `Player ${row.playerIndex + 1} — ${row.score.toLocaleString('en-US')}`,
        );
        line.dataset.role = `final-p${row.playerIndex + 1}`;
        view.body.append(line);
      }
      legend(view.footer, ['Enter', 'Continue']);

      opts.audio?.playMusic('gameover');

      detach = attachNav(window, (ev) => {
        if (ev === 'confirm' || ev === 'back') {
          opts.audio?.play('uiSelect');
          opts.onDone();
        }
      });
    },

    leave(): void {
      detach?.();
      detach = null;
      chrome?.dispose();
      chrome = null;
    },
  };
}
