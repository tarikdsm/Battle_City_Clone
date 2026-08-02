// src/ui/screens/hiScore.ts — fidelity §12/§13's arcade table, in its two modes.
//
// - **entry**: three characters, one column at a time. The model is
//   `session.ts`'s `applyInitials`, which knows nothing about keys: this screen
//   maps the six {@link NavEvent}s onto its five inputs, so a gamepad or a touch
//   pad drives the identical model in Phase 9.
// - **table**: the local top ten, seeded with the NES's 20,000 `HI` default.
//
// **One screen, and it switches modes itself.** Fidelity §13 makes them one
// moment — "initials entry → high-score table display → title" — and the screen
// machine deliberately ignores a self-transition, so routing the second half
// through `show('hiScore')` again would be a no-op. `commit` is therefore a
// *query* (`initials → the new table`) rather than a notification: the app
// stays the only thing that writes to storage, and the screen stays the only
// thing that owns its own DOM.

import {
  attachNav,
  el,
  legend,
  mountChrome,
  type NavEvent,
  type ScreenChrome,
} from '../menus';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import type { ScoreEntry } from '../../app/storage';
import {
  INITIALS_LENGTH,
  applyInitials,
  createInitials,
  initialsText,
  type InitialsInput,
} from '../../app/session';

export interface HiScoreParams {
  table: ScoreEntry[];
  /** Present when the run qualified: the score and stage about to be recorded. */
  entry?: { score: number; stage: number; playerIndex: 0 | 1 };
}

export interface CommittedTable {
  table: ScoreEntry[];
  /** Row index of the entry just added, for the highlight. */
  highlight: number;
}

export interface HiScoreScreenOptions {
  /** Record the initials and hand back the table to display. */
  commit(initials: string): CommittedTable;
  /** The player is done looking at the table. */
  onDone(): void;
  audio?: AudioSystem | null;
}

/** The six-event vocabulary, mapped onto the five things an entry can do. */
export function initialsInputFor(ev: NavEvent): InitialsInput | null {
  switch (ev) {
    case 'up':
      return 'next';
    case 'down':
      return 'prev';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'confirm':
      return 'commit';
    case 'back':
      return 'cancel';
    default:
      return null;
  }
}

export function createHiScoreScreen(opts: HiScoreScreenOptions): Screen {
  let chrome: ScreenChrome | null = null;
  let detach: (() => void) | null = null;
  let mount: HTMLElement | null = null;

  function teardown(): void {
    detach?.();
    detach = null;
    chrome?.dispose();
    chrome = null;
  }

  function showTable(table: ScoreEntry[], highlight: number): void {
    teardown();
    const root = mount;
    if (root === null) {
      return;
    }
    const view = mountChrome(root, {
      screen: 'hiScore',
      title: 'High scores',
    });
    chrome = view;

    const node = el('table', 'bc-scores');
    node.dataset.role = 'scores';
    const body = el('tbody');
    table.forEach((row, i) => {
      const tr = el('tr');
      if (i === highlight) {
        tr.classList.add('is-new');
      }
      tr.dataset.rank = String(i + 1);
      tr.append(
        el('td', 'rank', `${i + 1}.`),
        el('td', 'initials', row.initials),
        el('td', undefined, `Stage ${row.stage}`),
        el('td', 'score', row.score.toLocaleString('en-US')),
      );
      body.append(tr);
    });
    node.append(body);
    view.body.append(node);
    legend(view.footer, ['Enter', 'Continue'], ['Esc', 'Back']);

    opts.audio?.playMusic('hiscore');

    detach = attachNav(window, (ev) => {
      if (ev === 'confirm' || ev === 'back') {
        opts.audio?.play('uiSelect');
        opts.onDone();
      }
    });
  }

  function showEntry(entry: NonNullable<HiScoreParams['entry']>): void {
    teardown();
    const root = mount;
    if (root === null) {
      return;
    }
    const view = mountChrome(root, {
      screen: 'hiScoreEntry',
      title: 'New high score',
      subtitle: `${entry.score.toLocaleString('en-US')} on stage ${entry.stage}. Enter your initials.`,
      modal: true,
    });
    chrome = view;

    const model = createInitials();
    const row = el('div', 'bc-initials');
    row.dataset.role = 'initials';
    const boxes: HTMLElement[] = [];
    for (let i = 0; i < INITIALS_LENGTH; i++) {
      const box = el('div', 'bc-initial');
      box.dataset.slot = String(i);
      boxes.push(box);
      row.append(box);
    }
    view.body.append(row);
    legend(
      view.footer,
      ['↑ ↓', 'Letter'],
      ['← →', 'Column'],
      ['Enter', 'Confirm'],
      ['Esc', 'Back'],
    );

    const sync = (): void => {
      const text = initialsText(model);
      for (let i = 0; i < boxes.length; i++) {
        boxes[i].textContent = text[i];
        boxes[i].classList.toggle('is-focused', i === model.cursor);
      }
    };
    sync();

    detach = attachNav(window, (ev) => {
      const input = initialsInputFor(ev);
      if (input === null) {
        return;
      }
      const res = applyInitials(model, input);
      sync();
      if (res.done || res.cancelled) {
        // Backing all the way out still records the score — the run happened.
        // It just wears whatever was on the wheel, exactly like a cabinet whose
        // entry timer ran out.
        opts.audio?.play(res.done ? 'uiSelect' : 'uiBack');
        const committed = opts.commit(initialsText(model));
        showTable(committed.table, committed.highlight);
        return;
      }
      opts.audio?.play('uiMove');
    });
  }

  return {
    enter(root: HTMLElement, params?: unknown): void {
      mount = root;
      const p = (params as HiScoreParams | undefined) ?? { table: [] };
      if (p.entry !== undefined) {
        showEntry(p.entry);
      } else {
        showTable(p.table, -1);
      }
    },

    leave(): void {
      teardown();
      mount = null;
    },
  };
}
