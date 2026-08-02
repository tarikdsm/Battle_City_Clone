// src/ui/screens/pause.ts — GDD §5's pause: "freezes simulation, dims scene,
// shows resume/restart/quit + quick volume".
//
// **It does not freeze anything.** The core already owns pause (fidelity §11.6,
// P-26) and owns it correctly: `stepGame` resolves a press edge from the real
// intents before any system runs, and a paused tick advances nothing at all.
// This screen is what the player sees while that is true, and the one thing it
// *does* to the simulation it does the same way a player does — by asking the
// play screen to inject one tick of pause intent, so the toggle goes through
// core's edge detector rather than around it.
//
// Consequences worth stating, because both are easy to get wrong:
//
// - **Escape is handled here, and only here.** Escape is also P1's pause binding
//   (GDD §7), so while this overlay is up the play screen's pad is suspended
//   (`PlayScreen.setInputSuspended`) and every key belongs to the menu. Before
//   T6.2 both layers saw it, and which one won depended on whether a 60 Hz tick
//   landed inside the press — found by `npm run capture:ui`, not by a test.
// - The overlay mounts *over* the play screen (`ScreenMachine.showOverlay`), so
//   the renderer, the audio context and the simulation all survive it.

import {
  attachNav,
  createMenu,
  legend,
  mountChrome,
  mountMenu,
  type MenuItem,
} from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import type { SettingsV1 } from '../../app/storage';
import { VOLUME_STEP } from './settings';

export interface PauseScreenOptions {
  onResume(): void;
  onRestart(): void;
  onSettings(): void;
  onQuit(): void;
  read(): SettingsV1;
  /** Persist and push the new volumes at the audio graph. */
  apply(next: SettingsV1): void;
  audio?: AudioSystem | null;
}

export function pauseItems(s: SettingsV1): MenuItem[] {
  return [
    { kind: 'action', id: 'resume', label: 'Resume' },
    { kind: 'action', id: 'restart', label: 'Restart stage' },
    { kind: 'label', id: 'volume', label: 'Volume' },
    {
      kind: 'slider',
      id: 'music',
      label: 'Music',
      value: s.music,
      min: 0,
      max: 1,
      step: VOLUME_STEP,
    },
    {
      kind: 'slider',
      id: 'sfx',
      label: 'Sound',
      value: s.sfx,
      min: 0,
      max: 1,
      step: VOLUME_STEP,
    },
    { kind: 'label', id: 'more', label: 'More' },
    { kind: 'action', id: 'settings', label: 'All settings' },
    { kind: 'action', id: 'quit', label: 'Quit to title' },
  ];
}

export function createPauseScreen(opts: PauseScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement): void {
      const settings = opts.read();
      const items = pauseItems(settings);
      const model = createMenu(items);
      const view = mountChrome(root, {
        screen: 'pause',
        title: 'Paused',
        modal: true,
      });
      chrome = view;
      const menu = mountMenu(view.body, model, () => {
        onNav('confirm');
      });
      legend(
        view.footer,
        ['↑ ↓', 'Choose'],
        ['← →', 'Volume'],
        ['Enter', 'Select'],
        ['Esc', 'Resume'],
      );

      function onNav(ev: Parameters<typeof model.handle>[0]): void {
        if (ev === 'back') {
          // Escape resumes, and it does so from HERE — the play screen's pad is
          // suspended for as long as this overlay is up (see
          // `PlayScreen.setInputSuspended`), so exactly one layer owns the key.
          // Until T6.2 both did, and which one you got depended on whether a
          // 60 Hz tick landed inside the press.
          opts.audio?.play('uiBack');
          opts.onResume();
          return;
        }
        const res = model.handle(ev);
        if (res.moved) {
          opts.audio?.play('uiMove');
        }
        if (res.rejected) {
          opts.audio?.play('uiBack');
        }
        if (res.changed !== null && res.changed.kind === 'slider') {
          const next: SettingsV1 = { ...settings };
          if (res.changed.id === 'music') next.music = res.changed.value;
          if (res.changed.id === 'sfx') next.sfx = res.changed.value;
          opts.apply(next);
          settings.music = next.music;
          settings.sfx = next.sfx;
          opts.audio?.play('uiMove');
        }
        if (res.activated !== null) {
          opts.audio?.play(res.activated.id === 'quit' ? 'uiBack' : 'uiSelect');
          switch (res.activated.id) {
            case 'resume':
              opts.onResume();
              break;
            case 'restart':
              opts.onRestart();
              break;
            case 'settings':
              opts.onSettings();
              break;
            case 'quit':
              opts.onQuit();
              break;
            default:
              break;
          }
        }
        menu.sync();
      }

      detach = attachNav(window, onNav);
      menu.sync();
    },

    leave(): void {
      detach?.();
      detach = null;
      chrome?.dispose();
      chrome = null;
    },
  };
}
