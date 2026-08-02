// src/ui/screens/tally.ts — fidelity §11.2 / §12's stage tally.
//
// "per-player destroyed-tank counts by type × points, totals, then advance."
//
// The numbers are entirely core's: `stageTally` (session.ts) reads
// `PlayerMeta.destroyedByType` and the `SCORE` table and does no arithmetic this
// screen could get wrong. What lives here is the *reveal* — one row at a time
// with audio §5's `tallyTick`, whose pitch rises with the running total, which
// is the NES beat and the reason a tally is satisfying rather than a table.

import { el, legend, mountChrome, attachNav } from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import type { TallyColumn } from '../../app/session';

/** Milliseconds between revealed rows. Four rows + a total ≈ 1.4 s. */
export const TALLY_ROW_MS = 280;

const TYPE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  basic: 'Basic',
  fast: 'Fast',
  power: 'Power',
  armor: 'Armor',
});

export interface TallyParams {
  /** The 1…35 label for the stage just finished. */
  stage: number;
  columns: TallyColumn[];
  /** True when the run ended here rather than continuing. */
  final?: boolean;
}

export interface TallyScreenOptions {
  /** Advance to the next stage (or to the game-over sequence). */
  onDone(): void;
  audio?: AudioSystem | null;
}

export function createTallyScreen(opts: TallyScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    enter(root: HTMLElement, params?: unknown): void {
      const p = (params as TallyParams | undefined) ?? {
        stage: 1,
        columns: [],
      };
      const view = mountChrome(root, {
        screen: 'tally',
        title: `Stage ${p.stage} clear`,
        subtitle: 'Enemies destroyed',
        modal: true,
      });
      chrome = view;

      const wrap = el('div', 'bc-tally');
      /** Every `<tr>` in reveal order, across all columns. */
      const revealOrder: HTMLElement[][] = [];

      for (const column of p.columns) {
        const col = el('div', 'bc-tally-col');
        const head = el(
          'div',
          `bc-tally-head p${column.playerIndex + 1}`,
          `Player ${column.playerIndex + 1}`,
        );
        const table = el('table', 'bc-tally-table');
        const body = el('tbody');

        column.rows.forEach((row, i) => {
          const tr = el('tr');
          tr.dataset.revealed = '0';
          tr.dataset.row = row.type;
          tr.append(
            el('td', undefined, TYPE_LABEL[row.type] ?? row.type),
            el('td', 'count', `${row.count} ×`),
            el('td', 'pts', String(row.points)),
            el('td', 'sub', String(row.subtotal)),
          );
          body.append(tr);
          (revealOrder[i] ??= []).push(tr);
        });

        const total = el('tr', 'total');
        total.dataset.revealed = '0';
        total.dataset.row = 'total';
        total.append(
          el('td', undefined, 'Total'),
          el('td', 'count', `${column.tanks} ×`),
          el('td', 'pts', ''),
          el('td', 'sub', String(column.killPoints)),
        );
        body.append(total);
        (revealOrder[column.rows.length] ??= []).push(total);

        const score = el('tr');
        score.dataset.revealed = '0';
        score.dataset.row = 'score';
        score.append(
          el('td', undefined, 'Score'),
          el('td', 'count', ''),
          el('td', 'pts', ''),
          el('td', 'sub', column.score.toLocaleString('en-US')),
        );
        body.append(score);
        (revealOrder[column.rows.length + 1] ??= []).push(score);

        table.append(body);
        col.append(head, table);
        wrap.append(col);
      }
      view.body.append(wrap);
      legend(view.footer, [
        'Enter',
        p.final === true ? 'Continue' : 'Next stage',
      ]);

      let step = 0;
      const revealAll = (): void => {
        for (const group of revealOrder) {
          for (const tr of group) {
            tr.dataset.revealed = '1';
          }
        }
        step = revealOrder.length;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      timer = setInterval(() => {
        if (step >= revealOrder.length) {
          revealAll();
          return;
        }
        for (const tr of revealOrder[step]) {
          tr.dataset.revealed = '1';
        }
        // Audio §5: "per-line counting blips, **pitch rising with total**".
        // `intensity` is the pitch lever (`sfx.ts` adds up to an octave), so it
        // is the fraction of the way through the reveal.
        opts.audio?.play(
          'tallyTick',
          0,
          revealOrder.length <= 1 ? 1 : step / (revealOrder.length - 1),
        );
        step++;
      }, TALLY_ROW_MS);

      detach = attachNav(window, (ev) => {
        if (ev !== 'confirm' && ev !== 'back') {
          return;
        }
        // First press skips the reveal, second advances. A tally that could be
        // dismissed before it had shown its numbers would be a tally nobody
        // ever read.
        if (step < revealOrder.length) {
          revealAll();
          opts.audio?.play('uiSelect');
          return;
        }
        opts.audio?.play('uiSelect');
        opts.onDone();
      });
    },

    leave(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      detach?.();
      detach = null;
      chrome?.dispose();
      chrome = null;
    },
  };
}
