// src/ui/screens/stageSelect.ts — GDD §4: "Stage select allows starting from
// any previously reached stage (progress persisted)."
//
// A 5×7 grid rather than a list, because 35 rows is not a menu. It is the one
// place the abstract nav model is not enough on its own: `createMenu` is
// one-dimensional by design (up/down move, left/right *edit*), and a grid needs
// left/right to move too. So this screen keeps its own two-axis cursor over the
// same six {@link NavEvent}s — the vocabulary is shared, the traversal is not,
// which is exactly the seam a gamepad's D-pad and a tap will reuse in Phase 9.

import { attachNav, el, legend, mountChrome, type NavEvent } from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import { campaignLength, type CampaignId } from '../../app/session';

/** Cells per row. 35 = 5 × 7 exactly, so the grid has no ragged last row. */
export const STAGE_COLUMNS = 7;

/**
 * Cells per row for the Neo campaign. 12 = 2 × 6, so that grid is also exact —
 * a ragged last row is the one thing `moveInGrid`'s wrapping cannot make feel
 * right, because the wrapped cell would land under a gap.
 */
export const NEO_COLUMNS = 6;

/** How wide the grid is for a campaign, chosen so no row is ragged. */
export function columnsFor(campaign: CampaignId): number {
  return campaign === 'neo' ? NEO_COLUMNS : STAGE_COLUMNS;
}

export interface StageSelectOptions {
  /**
   * Which campaign this screen is selecting from. Read on every `enter`, not
   * captured at construction: one screen instance serves both, and the flow
   * switches between them without rebuilding anything.
   */
  campaign(): CampaignId;
  /** Highest stage reached in that campaign (`bc.save.v1`). */
  highest(): number;
  onPick(stage: number): void;
  onBack(): void;
  audio?: AudioSystem | null;
}

/**
 * Move a cursor over a `columns`-wide grid of `count` cells.
 *
 * Horizontal movement wraps **within the row** and vertical movement wraps
 * within the column, which is what keeps every cell two presses from its
 * neighbour and stops a player falling off the bottom into nothing.
 */
export function moveInGrid(
  index: number,
  ev: NavEvent,
  count: number,
  columns: number,
): number {
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rows = Math.ceil(count / columns);
  switch (ev) {
    case 'left':
      return row * columns + ((col + columns - 1) % columns);
    case 'right':
      return row * columns + ((col + 1) % columns);
    case 'up':
      return (((row + rows - 1) % rows) * columns + col) % count;
    case 'down':
      return (((row + 1) % rows) * columns + col) % count;
    default:
      return index;
  }
}

export function createStageSelectScreen(opts: StageSelectOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;

  return {
    enter(root: HTMLElement): void {
      const campaign = opts.campaign();
      const count = campaignLength(campaign);
      const columns = columnsFor(campaign);
      const highest = Math.min(count, Math.max(1, opts.highest()));
      // Start on the furthest stage reached: the player who opened this screen
      // almost always wants to continue, not to replay stage 1.
      let index = highest - 1;

      const view = mountChrome(root, {
        screen: 'stageSelect',
        title: campaign === 'neo' ? 'Neo campaign' : 'Stage select',
        subtitle:
          highest === 1
            ? 'Only stage 1 is unlocked. Clearing a stage unlocks the next one.'
            : `Stages 1 to ${highest} are unlocked. Progress saves as you clear them.`,
      });
      chrome = view;
      // So a test — and a player coming back to it — can tell which of the two
      // grids is on screen without counting cells.
      view.node.dataset.campaign = campaign;

      const grid = el('div', 'bc-stage-grid');
      grid.style.setProperty('--bc-stage-columns', String(columns));
      const cells: HTMLElement[] = [];
      for (let i = 0; i < count; i++) {
        const cell = el('div', 'bc-stage-cell', String(i + 1));
        cell.dataset.stage = String(i + 1);
        cell.addEventListener('click', () => {
          index = i;
          confirm();
        });
        cells.push(cell);
        grid.append(cell);
      }
      view.body.append(grid);
      legend(
        view.footer,
        ['↑ ↓ ← →', 'Choose'],
        ['Enter', 'Start'],
        ['Esc', 'Back'],
      );

      function sync(): void {
        for (let i = 0; i < cells.length; i++) {
          cells[i].classList.toggle('is-focused', i === index);
          cells[i].classList.toggle('is-locked', i + 1 > highest);
        }
      }

      function confirm(): void {
        if (index + 1 > highest) {
          opts.audio?.play('uiBack');
          sync();
          return;
        }
        opts.audio?.play('uiSelect');
        opts.onPick(index + 1);
      }

      detach = attachNav(window, (ev: NavEvent) => {
        if (ev === 'back') {
          opts.audio?.play('uiBack');
          opts.onBack();
          return;
        }
        if (ev === 'confirm') {
          confirm();
          return;
        }
        const next = moveInGrid(index, ev, count, columns);
        if (next !== index) {
          index = next;
          opts.audio?.play('uiMove');
        }
        sync();
      });
      sync();
    },

    leave(): void {
      detach?.();
      detach = null;
      chrome?.dispose();
      chrome = null;
    },
  };
}
