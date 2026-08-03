// src/ui/screens/customLevels.ts — GDD §5's "Custom stage" entry.
//
// The other half of saving: `bc.customLevels.v1` is only worth writing if
// something reads it back and plays it. A list, one row per saved stage, over
// the same nav model every other menu uses (`createMenu`), so the keyboard, a
// gamepad in Phase 9 and a tap all drive it without this file knowing.
//
// Lazy, like the editor, and in a chunk of its own — Rollup gives each dynamic
// import its own, and measured this one is about 1 kB. A player who never
// builds or imports a stage downloads neither.

import {
  attachNav,
  createMenu,
  legend,
  mountChrome,
  mountMenu,
} from '../menus';
import type { MenuItem } from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import type { LevelData } from '../../core/types';

export interface CustomLevelsOptions {
  audio?: AudioSystem | null;
  levels(): LevelData[];
  onPlay(level: LevelData): void;
  onBack(): void;
}

export function createCustomLevelsScreen(opts: CustomLevelsOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement): void {
      const levels = opts.levels();
      const view = mountChrome(root, {
        screen: 'customLevels',
        title: 'Custom stage',
        subtitle:
          levels.length === 0
            ? 'Nothing saved yet. Build one in construction mode.'
            : 'Stages you have saved on this device.',
      });
      chrome = view;

      const items: MenuItem[] = levels.map((level) => ({
        kind: 'action',
        id: level.id,
        label: level.name,
        hint:
          level.author !== undefined && level.author !== ''
            ? `by ${level.author}`
            : undefined,
      }));
      if (items.length === 0) {
        items.push({
          kind: 'action',
          id: 'none',
          label: 'No stages yet',
          disabled: true,
          hint: 'Save one in construction mode and it appears here.',
        });
      }

      const model = createMenu(items);
      const menu = mountMenu(view.body, model, () => {
        act('confirm');
      });
      legend(
        view.footer,
        ['↑ ↓', 'Choose'],
        ['Enter', 'Play'],
        ['Esc', 'Back'],
      );

      function act(ev: 'confirm' | 'up' | 'down' | 'back'): void {
        const res = model.handle(ev);
        if (res.moved) {
          opts.audio?.play('uiMove');
        }
        if (res.rejected || res.back) {
          opts.audio?.play('uiBack');
        }
        if (res.back) {
          opts.onBack();
          return;
        }
        if (res.activated !== null) {
          const picked = levels.find((l) => l.id === res.activated?.id);
          if (picked !== undefined) {
            opts.audio?.play('uiSelect');
            opts.onPlay(picked);
            return;
          }
        }
        menu.sync();
      }

      detach = attachNav(window, (ev) => {
        if (ev === 'left' || ev === 'right') {
          return;
        }
        act(ev);
      });
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
