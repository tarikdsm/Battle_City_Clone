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
  /** How many players the next run starts with. Read on every `enter`. */
  players(): 1 | 2;
  /** The player count changed on the `players` row. */
  onPlayers(n: 1 | 2): void;
  audio?: AudioSystem | null;
}

export function menuItems(players: 1 | 2 = 1): MenuItem[] {
  return [
    // GDD §1 ships a two-player mode and the whole stack has carried it since
    // T1.7 — separate scores, separate lives, a `players` term in the spawn
    // cadence, p2 key bindings, a P2 HUD column. Until T10 the ONLY way to
    // reach it was `?players=2`, a dev-only URL flag that a production bundle
    // makes inert (`debug.ts`), so a shipped build had no two-player mode at
    // all. This row is that missing entry point, and nothing below it changed.
    {
      kind: 'choice',
      id: 'players',
      label: 'Players',
      value: String(players),
      options: [
        { value: '1', label: '1 player' },
        { value: '2', label: '2 players' },
      ],
    },
    { kind: 'action', id: 'campaign', label: 'Campaign' },
    {
      kind: 'action',
      id: 'neo',
      label: 'Neo campaign',
      disabled: true,
      // Accurate as of T10: the twelve stages exist (`src/levels/neo/`,
      // authored in T8.3) and are validated and completability-checked, but
      // nothing routes a run through them — the campaign chain, the progress
      // store and the tally all assume the original 35. Reaching them needs a
      // campaign selector threaded through `Session`, which 1.0 does not have.
      hint: 'Twelve new stages. Built, but not reachable in 1.0.',
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
      hint: 'Play a stage you built or imported.',
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
      const items = menuItems(opts.players());
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

      function act(
        ev: 'confirm' | 'up' | 'down' | 'back' | 'left' | 'right',
      ): void {
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
        if (res.changed !== null && res.changed.id === 'players') {
          opts.audio?.play('uiMove');
          const item = res.changed;
          if (item.kind === 'choice') {
            opts.onPlayers(item.value === '2' ? 2 : 1);
          }
        }
        if (res.activated !== null) {
          opts.audio?.play('uiSelect');
          opts.onChoose(res.activated.id as MenuChoice);
        }
        menu.sync();
      }

      detach = attachNav(window, (ev) => {
        // Left/right mean nothing on an ACTION row; folding them into up/down
        // would make a stray press move the cursor unexpectedly. They do mean
        // something on the `players` choice, so they are forwarded when that is
        // the focused row and swallowed everywhere else.
        if (ev === 'left' || ev === 'right') {
          if (model.focused()?.kind !== 'choice') {
            return;
          }
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
