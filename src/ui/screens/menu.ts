// src/ui/screens/menu.ts — GDD §5's main menu.
//
// Six entries, three of which Phase 8 builds. They ship **disabled and
// explained** rather than hidden: a menu that grows new rows between releases
// teaches a player nothing, while a row that says what it is and when it
// arrives reads as a plan. `createMenu` keeps a disabled row focusable for
// exactly this reason.

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

/** The stable ids the flow switches on. */
export type MenuChoice =
  'campaign' | 'neo' | 'construction' | 'custom' | 'scores' | 'settings';

export interface MenuScreenOptions {
  onChoose(choice: MenuChoice): void;
  onBack(): void;
  audio?: AudioSystem | null;
}

export function menuItems(): MenuItem[] {
  return [
    { kind: 'action', id: 'campaign', label: 'Campaign' },
    {
      kind: 'action',
      id: 'neo',
      label: 'Neo campaign',
      disabled: true,
      hint: 'Twelve new stages. Not built yet.',
    },
    {
      kind: 'action',
      id: 'construction',
      label: 'Construction',
      hint: 'Build a stage of your own.',
    },
    {
      kind: 'action',
      id: 'custom',
      label: 'Custom stage',
      disabled: true,
      hint: 'Arrives with saving and sharing.',
    },
    { kind: 'action', id: 'scores', label: 'High scores' },
    { kind: 'action', id: 'settings', label: 'Settings' },
  ];
}

export function createMenuScreen(opts: MenuScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement, params?: unknown): void {
      const items = menuItems();
      const model = createMenu(items);
      // Coming back from a sub-screen restores the row you left from, so the
      // cursor does not reset to the top every time you glance at Settings.
      const returnTo = (params as { focus?: string } | undefined)?.focus;
      if (returnTo !== undefined) {
        model.focusId(returnTo);
      }

      const view = mountChrome(root, { screen: 'menu', title: 'Battle City' });
      chrome = view;
      const menu = mountMenu(view.body, model, () => {
        act('confirm');
      });
      legend(
        view.footer,
        ['↑ ↓', 'Choose'],
        ['Enter', 'Select'],
        ['Esc', 'Back'],
      );

      function act(ev: 'confirm' | 'up' | 'down' | 'back'): void {
        const res = model.handle(ev);
        if (res.moved) {
          opts.audio?.play('uiMove');
        }
        if (res.rejected) {
          opts.audio?.play('uiBack');
        }
        if (res.back) {
          opts.audio?.play('uiBack');
          opts.onBack();
          return;
        }
        if (res.activated !== null) {
          opts.audio?.play('uiSelect');
          opts.onChoose(res.activated.id as MenuChoice);
        }
        menu.sync();
      }

      detach = attachNav(window, (ev) => {
        // Left/right mean nothing on a list of actions; folding them into
        // up/down would make a stray press move the cursor unexpectedly.
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
