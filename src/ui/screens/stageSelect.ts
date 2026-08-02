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
import { STAGE_LOOP } from '../../app/session';

/** Cells per row. 35 = 5 × 7 exactly, so the grid has no ragged last row. */
export const STAGE_COLUMNS = 7;

export interface StageSelectOptions {
  /** Highest stage reached, 1…35 (`bc.save.v1`). */
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
      const highest = Math.min(STAGE_LOOP, Math.max(1, opts.highest()));
      // Start on the furthest stage reached: the player who opened this screen
      // almost always wants to continue, not to replay stage 1.
      let index = highest - 1;

      const view = mountChrome(root, {
        screen: 'stageSelect',
        title: 'Stage select',
        subtitle:
          highest === 1
            ? 'Only stage 1 is unlocked. Clearing a stage unlocks the next one.'
            : `Stages 1 to ${highest} are unlocked. Progress saves as you clear them.`,
      });
      chrome = view;

      const grid = el('div', 'bc-stage-grid');
      const cells: HTMLElement[] = [];
      for (let i = 0; i < STAGE_LOOP; i++) {
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
        const next = moveInGrid(index, ev, STAGE_LOOP, STAGE_COLUMNS);
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
