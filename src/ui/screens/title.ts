// src/ui/screens/title.ts — GDD §5's title: "logo, press any key/tap, subtle
// attract camera drift over a diorama".
//
// The diorama is real. The title screen does not draw a board of its own: it
// mounts over the *play screen's* live renderer, which is running a stage-1
// simulation with no controls attached (see `main.ts`'s attract run). So the
// "camera drift" is the stage fly-in and the board's own animation, and this
// file is only the logo and the prompt on top of it — DOM, never canvas.

import { el, legend, mountChrome } from '../menus';
import { sharedGamepads } from '../../input/gamepad';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import type { ScoreEntry } from '../../app/storage';

export interface TitleScreenOptions {
  onStart(): void;
  /** The table's top row, shown as the NES `HI` line (GDD §8). */
  topScore(): ScoreEntry | null;
  audio?: AudioSystem | null;
}

export function createTitleScreen(opts: TitleScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement): void {
      const view = mountChrome(root, { screen: 'title', bare: true });
      chrome = view;

      const logo = el('h1', 'bc-logo');
      logo.append(
        document.createTextNode('Battle'),
        el('em', undefined, 'City'),
      );
      const press = el('p', 'bc-press', 'Press any key to start');
      press.dataset.role = 'press';
      view.body.append(logo, press);

      const top = opts.topScore();
      if (top !== null) {
        view.body.append(
          el(
            'p',
            'bc-hi',
            `HI ${top.score.toLocaleString('en-US')} · ${top.initials}`,
          ),
        );
      }
      legend(view.footer, ['Any key', 'Start']);

      // "Press any key" means any key — so this screen does NOT go through
      // `navFromKey`. It is the one place in the app where the abstract nav
      // model would be wrong: filtering to six events would make F5 and Tab
      // silently do nothing on a screen that promised otherwise.
      const listener = (e: KeyboardEvent): void => {
        if (e.repeat) {
          return;
        }
        // Let the browser keep its own chords — a player reaching for devtools
        // or a refresh has not asked to start a game.
        if (e.ctrlKey || e.metaKey || e.altKey) {
          return;
        }
        e.preventDefault();
        opts.audio?.play('uiSelect');
        opts.onStart();
      };
      const click = (): void => {
        opts.audio?.play('uiSelect');
        opts.onStart();
      };
      window.addEventListener('keydown', listener);
      view.node.addEventListener('pointerdown', click);
      // Pointer events are off on `.bc-screen` so the board stays clickable;
      // the title is the one screen that wants the whole viewport as a button.
      view.node.style.pointerEvents = 'auto';

      // …and any BUTTON, on any pad (T9.1). This screen does not use
      // `attachNav` — "press any key" is the one place the six-event model
      // would be wrong — so it pumps the hub itself. Every nav event counts,
      // including a direction: the prompt says any, and a player reaching for a
      // controller should not have to find the right button first.
      const pads = sharedGamepads();
      const releaseNav = pads.retainNav();
      let frame: number | null = null;
      const pump = (): void => {
        pads.sample();
        if (pads.drainNav().length > 0) {
          click();
          return; // started: stop pumping, `leave` is about to run
        }
        frame = window.requestAnimationFrame(pump);
      };
      frame = window.requestAnimationFrame(pump);

      detach = (): void => {
        window.removeEventListener('keydown', listener);
        view.node.removeEventListener('pointerdown', click);
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
          frame = null;
        }
        releaseNav();
      };
    },

    leave(): void {
      detach?.();
      detach = null;
      chrome?.dispose();
      chrome = null;
    },
  };
}
