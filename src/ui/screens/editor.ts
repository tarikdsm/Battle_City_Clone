// src/ui/screens/editor.ts — the construction mode's surface (arch §9).
//
// This module is the head of the **editor chunk**: `main.ts` reaches it through
// `createLazyScreen(() => import(...))` and nothing on the boot path imports it
// statically, so the whole editor — this file and `src/editor/*` — is fetched
// the first time somebody opens `#editor`.
//
// It is a *view*. Every decision about what a stroke does, what a wave is and
// what is wrong with a draft lives in `src/editor/`, which is why all of that is
// tested in Vitest's node environment while this file only draws the answer.
//
// ## The board is drawn at subcell resolution, after the stamp
//
// The field is 13×13 tiles of 2×2 subcells, rendered from `levels/analysis.ts`'s
// `subcellRows` — the same function the content contact sheet uses. That matters
// twice: half-tiles are visible while they are being painted (they are what the
// originals are built from), and the eagle and its brick ring appear *stamped*,
// exactly as the engine will build them, so the author is never looking at a
// field the game will not produce.

import { createEditor } from '../../editor/editor';
import {
  BRUSHES,
  createDraft,
  reservedTile,
  type Brush,
  type Subcell,
} from '../../editor/tools';
import {
  ENEMY_LABELS,
  ENEMY_TYPES,
  waveCounts,
  waveSlots,
} from '../../editor/waveEditor';
import { subcellRows } from '../../levels/analysis';
import type { LevelData } from '../../core/types';
import type { Screen } from '../../app/screens';
import type { AudioSystem } from '../../audio/audio';
import { el, legend, mountChrome } from '../menus';

const FIELD_TILES = 13;
const SUBCELLS = FIELD_TILES * 2;

/** `subcellRows`' glyphs → the class the stylesheet colours. */
const GLYPH_CLASS: Readonly<Record<string, string>> = Object.freeze({
  '.': '',
  '#': 'is-brick',
  '@': 'is-steel',
  '~': 'is-water',
  '%': 'is-trees',
  '-': 'is-ice',
  A: 'is-eagle',
});

/** The glyph `subcellRows` draws for a brush, so a palette swatch matches. */
const BRUSH_GLYPH: Readonly<Record<Brush, string>> = Object.freeze({
  '.': '.',
  B: '#',
  S: '@',
  W: '~',
  T: '%',
  I: '-',
});

export interface EditorScreenOptions {
  audio?: AudioSystem | null;
  /** The draft to resume. `null`/absent starts a fresh one. */
  draft?: LevelData | null;
  /** Fired on every change, so the composition root can hold the draft. */
  onDraftChanged?(level: LevelData): void;
  /** Leave the editor (Esc, or the Back button). */
  onExit(): void;
}

interface Cursor {
  tx: number;
  ty: number;
  sub: Subcell;
}

export function createEditorScreen(opts: EditorScreenOptions): Screen {
  let chrome: { dispose(): void } | null = null;
  let teardown: (() => void)[] = [];

  return {
    enter(root: HTMLElement, params?: unknown): void {
      // `params` wins over the option, so `screens.show('editor', draft)` can
      // hand a draft back after a test-play without rebuilding the screen.
      const resume = (params as LevelData | undefined) ?? opts.draft ?? null;
      const ed = createEditor(resume ?? createDraft());
      let cursor: Cursor = { tx: 6, ty: 6, sub: 0 };
      let painting = false;

      const view = mountChrome(root, {
        screen: 'editor',
        title: 'Construction',
        subtitle:
          'Paint the field, order the wave, then test-play it. Brick and ' +
          'steel can be painted a half-tile at a time.',
      });
      chrome = view;

      const layout = el('div', 'bc-editor');
      const field = buildField();
      const side = el('div', 'bc-editor-side');
      layout.append(field.node, side);

      const status = el('p', 'bc-editor-status');
      status.dataset.role = 'status';
      const errors = el('ul', 'bc-editor-errors');
      errors.dataset.role = 'errors';

      view.body.append(layout, status, errors);
      legend(
        view.footer,
        ['Drag', 'Paint'],
        ['1 – 6', 'Material'],
        ['M', 'Tile / half-tile'],
        ['Ctrl+Z', 'Undo'],
        ['Esc', 'Back'],
      );

      /** Fill the validation list. An empty result says so out loud. */
      function showErrors(messages: string[]): void {
        errors.replaceChildren();
        errors.classList.toggle('is-ok', messages.length === 0);
        if (messages.length === 0) {
          errors.append(
            el('li', 'bc-editor-error', 'This stage is ready to play.'),
          );
          return;
        }
        for (const message of messages) {
          errors.append(el('li', 'bc-editor-error', message));
        }
      }

      function changed(): void {
        opts.onDraftChanged?.(ed.draft());
        // Stale errors are worse than none: they describe a draft that no
        // longer exists. Validation is a button, and it re-runs on demand.
        errors.replaceChildren();
        errors.classList.remove('is-ok');
        sync();
      }

      // --- tool box ---------------------------------------------------------

      const toolbox = section(side, 'Tool');
      const modeRow = el('div', 'bc-editor-modes');
      const modeButtons = new Map<string, HTMLElement>();
      for (const [mode, label] of [
        ['tile', 'Tile'],
        ['subcell', 'Half-tile'],
      ] as const) {
        const button = el('button', 'bc-editor-mode', label);
        button.dataset.mode = mode;
        button.addEventListener('click', () => {
          ed.setMode(mode);
          opts.audio?.play('uiMove');
          sync();
        });
        modeButtons.set(mode, button);
        modeRow.append(button);
      }
      toolbox.append(modeRow);

      const palette = el('div', 'bc-editor-palette');
      const brushButtons = new Map<Brush, HTMLElement>();
      BRUSHES.forEach((brush, i) => {
        const button = el('button', 'bc-editor-brush');
        button.dataset.brush = brush.char;
        button.append(
          el(
            'span',
            `bc-editor-swatch ${GLYPH_CLASS[BRUSH_GLYPH[brush.char]]}`,
          ),
          el('span', 'bc-editor-brush-label', brush.label),
          el('kbd', undefined, String(i + 1)),
        );
        button.addEventListener('click', () => {
          ed.setBrush(brush.char);
          opts.audio?.play('uiMove');
          sync();
        });
        brushButtons.set(brush.char, button);
        palette.append(button);
      });
      toolbox.append(palette);

      // --- metadata ---------------------------------------------------------

      const meta = section(side, 'Stage');
      const nameInput = textField(meta, 'Name', ed.draft().name, (value) => {
        ed.setName(value);
        changed();
      });
      const authorInput = textField(
        meta,
        'Author',
        ed.draft().author ?? '',
        (value) => {
          ed.setAuthor(value);
          changed();
        },
      );

      // --- the wave ---------------------------------------------------------

      const wave = section(side, 'Enemy wave');
      wave.append(
        el(
          'p',
          'bc-editor-note',
          'Twenty tanks, in spawn order. The 4th, 11th and 18th always arrive ' +
            'carrying a power-up — that is a rule of the game rather than part ' +
            'of the stage, so those positions are fixed. Click a slot to change ' +
            'its type, right-click to go back, shift-click to fill to the end.',
        ),
      );
      const waveGrid = el('div', 'bc-editor-wave');
      const slotButtons: HTMLElement[] = [];
      for (const slot of waveSlots(ed.draft().enemies)) {
        const button = el('button', 'bc-editor-slot');
        button.dataset.slot = String(slot.index);
        button.append(
          el('span', 'bc-editor-slot-n', String(slot.ordinal)),
          el('span', 'bc-editor-slot-type'),
        );
        if (slot.carrier) {
          button.classList.add('is-carrier');
          // Read by the capture script: the marker is derived from the spawn
          // ordinal, and nothing in the UI can move it.
          button.dataset.carrier = 'fixed';
          button.append(el('span', 'bc-editor-slot-carrier', 'Carrier'));
          button.title = `Spawn ${slot.ordinal} always carries a power-up. Fixed.`;
        }
        button.addEventListener('click', (event) => {
          if ((event as MouseEvent).shiftKey) {
            ed.fillEnemiesFrom(slot.index, ed.draft().enemies[slot.index]);
          } else {
            ed.cycleEnemy(slot.index, 1);
          }
          opts.audio?.play('uiSelect');
          changed();
        });
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          ed.cycleEnemy(slot.index, -1);
          opts.audio?.play('uiSelect');
          changed();
        });
        slotButtons.push(button);
        waveGrid.append(button);
      }
      wave.append(waveGrid);
      const waveSummary = el('p', 'bc-editor-note');
      waveSummary.dataset.role = 'wave-counts';
      wave.append(waveSummary);

      // --- actions ----------------------------------------------------------

      const actions = section(side, 'Actions');
      const actionRow = el('div', 'bc-editor-actions');
      const buttons: [id: string, label: string, run: () => void][] = [
        [
          'validate',
          'Validate',
          (): void => {
            showErrors(ed.validate());
          },
        ],
        [
          'undo',
          'Undo',
          (): void => {
            if (ed.undo()) {
              changed();
            }
          },
        ],
        [
          'redo',
          'Redo',
          (): void => {
            if (ed.redo()) {
              changed();
            }
          },
        ],
        [
          'clear',
          'Clear field',
          (): void => {
            const blank = createDraft({
              id: ed.draft().id,
              name: ed.draft().name,
              author: ed.draft().author,
            });
            ed.load({ ...blank, enemies: [...ed.draft().enemies] });
            ed.setStatus('Field cleared.');
            changed();
          },
        ],
        [
          'back',
          'Back',
          (): void => {
            opts.onExit();
          },
        ],
      ];
      for (const [id, label, run] of buttons) {
        const button = el('button', 'bc-editor-action', label);
        button.dataset.action = id;
        button.addEventListener('click', () => {
          opts.audio?.play('uiSelect');
          run();
        });
        actionRow.append(button);
      }
      actions.append(actionRow);

      // --- painting ---------------------------------------------------------

      /**
       * The subcell under a client point, or `null` off the field.
       *
       * Hit-tested from the field's own box rather than from `event.target`,
       * because the stroke below has to fill the cells *between* two events and
       * an event only ever names the one it landed on.
       */
      function subAt(
        clientX: number,
        clientY: number,
      ): { sx: number; sy: number } | null {
        const box = field.node.getBoundingClientRect();
        const sx = Math.floor(((clientX - box.left) / box.width) * SUBCELLS);
        const sy = Math.floor(((clientY - box.top) / box.height) * SUBCELLS);
        if (sx < 0 || sy < 0 || sx >= SUBCELLS || sy >= SUBCELLS) {
          return null;
        }
        return { sx, sy };
      }

      function applyAt(sx: number, sy: number): boolean {
        cursor = {
          tx: sx >> 1,
          ty: sy >> 1,
          sub: ((sy & 1) * 2 + (sx & 1)) as Subcell satisfies Subcell,
        };
        return ed.paintAt(cursor.tx, cursor.ty, cursor.sub);
      }

      function paintAtCursor(): void {
        if (ed.paintAt(cursor.tx, cursor.ty, cursor.sub)) {
          changed();
        } else {
          // Still a redraw: the status line has the refusal on it now.
          sync();
        }
      }

      /** The last subcell this stroke painted, for interpolation. */
      let lastCell: { sx: number; sy: number } | null = null;

      /**
       * Paint every cell on the segment from the last one to this one.
       *
       * A pointer at 60 Hz moving across a 30 px field cell reports one event
       * every three cells, and painting only where the events land leaves a
       * dotted line with holes in it — which is exactly what the first capture
       * of this screen produced. Interpolating is what makes a drag draw a
       * *line*; it is also what makes the brush usable at all on a trackpad.
       */
      function paintTo(sx: number, sy: number): void {
        let any = false;
        if (lastCell === null) {
          any = applyAt(sx, sy);
        } else {
          const dx = sx - lastCell.sx;
          const dy = sy - lastCell.sy;
          const steps = Math.max(Math.abs(dx), Math.abs(dy));
          if (steps === 0) {
            any = applyAt(sx, sy);
          }
          for (let i = 1; i <= steps; i++) {
            const px = lastCell.sx + Math.round((dx * i) / steps);
            const py = lastCell.sy + Math.round((dy * i) / steps);
            any = applyAt(px, py) || any;
          }
        }
        lastCell = { sx, sy };
        if (any) {
          changed();
        } else {
          // The status line may carry a refusal now even though nothing moved.
          sync();
        }
      }

      const onPointerDown = (event: PointerEvent): void => {
        // Without this a drag selects the panel's text instead of painting.
        event.preventDefault();
        const at = subAt(event.clientX, event.clientY);
        if (at === null) {
          return;
        }
        painting = true;
        lastCell = null;
        ed.beginStroke();
        paintTo(at.sx, at.sy);
      };
      const onPointerMove = (event: PointerEvent): void => {
        if (!painting) {
          return;
        }
        const at = subAt(event.clientX, event.clientY);
        if (at === null) {
          // Left the field. Forgetting the last cell is what stops a stroke
          // that re-enters somewhere else from drawing a line across the gap.
          lastCell = null;
          return;
        }
        paintTo(at.sx, at.sy);
      };
      const endStroke = (): void => {
        if (!painting) {
          return;
        }
        painting = false;
        lastCell = null;
        ed.endStroke();
        sync();
      };
      field.node.addEventListener('pointerdown', onPointerDown);
      // On `window`, not the field: a drag that wanders off the board keeps
      // painting when it comes back, and one that ends out there still ends.
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endStroke);
      window.addEventListener('pointercancel', endStroke);
      teardown.push(() => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endStroke);
        window.removeEventListener('pointercancel', endStroke);
      });

      // --- keyboard ---------------------------------------------------------

      const onKey = (event: KeyboardEvent): void => {
        // The metadata fields are real text inputs, so the editor's own
        // shortcuts have to stay out of them — otherwise typing "Ice bridge"
        // would change the brush twice and toggle the paint mode.
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          if (event.code === 'Escape') {
            event.preventDefault();
            target.blur();
          }
          return;
        }

        if (event.ctrlKey || event.metaKey) {
          if (event.code === 'KeyZ' || event.code === 'KeyY') {
            event.preventDefault();
            const redo = event.code === 'KeyY' || event.shiftKey;
            if (redo ? ed.redo() : ed.undo()) {
              changed();
            }
          }
          return;
        }

        const digit = /^Digit([1-6])$/.exec(event.code);
        if (digit !== null) {
          event.preventDefault();
          ed.setBrush(BRUSHES[Number(digit[1]) - 1].char);
          opts.audio?.play('uiMove');
          sync();
          return;
        }

        switch (event.code) {
          case 'KeyM':
            event.preventDefault();
            ed.setMode(ed.mode() === 'tile' ? 'subcell' : 'tile');
            opts.audio?.play('uiMove');
            sync();
            return;
          case 'Escape':
            event.preventDefault();
            opts.audio?.play('uiBack');
            opts.onExit();
            return;
          case 'Enter':
          case 'Space':
            event.preventDefault();
            ed.beginStroke();
            paintAtCursor();
            ed.endStroke();
            return;
          default:
            break;
        }

        const step = navStep(event.code);
        if (step === null) {
          return;
        }
        event.preventDefault();
        cursor = moveCursor(cursor, step, ed.mode() === 'subcell');
        opts.audio?.play('uiMove');
        sync();
      };
      window.addEventListener('keydown', onKey);
      teardown.push(() => {
        window.removeEventListener('keydown', onKey);
      });

      // --- rendering --------------------------------------------------------

      /** Previous glyph per subcell, so a stroke rewrites only what moved. */
      const painted = new Array<string>(SUBCELLS * SUBCELLS).fill('?');

      function sync(): void {
        const rows = subcellRows(ed.draft());
        for (let sy = 0; sy < SUBCELLS; sy++) {
          for (let sx = 0; sx < SUBCELLS; sx++) {
            const i = sy * SUBCELLS + sx;
            const glyph = rows[sy][sx];
            if (painted[i] !== glyph) {
              painted[i] = glyph;
              field.cells[i].className = `bc-sub ${GLYPH_CLASS[glyph] ?? ''}`;
            }
          }
        }

        const subMode = ed.mode() === 'subcell';
        field.node.classList.toggle('is-subcell', subMode);
        const cursorAt = cursorIndex(cursor);
        for (let i = 0; i < field.tiles.length; i++) {
          field.tiles[i].classList.toggle(
            'is-cursor',
            !subMode && i === cursor.ty * FIELD_TILES + cursor.tx,
          );
        }
        for (let i = 0; i < field.cells.length; i++) {
          field.cells[i].classList.toggle(
            'is-cursor',
            subMode && i === cursorAt,
          );
        }

        for (const [mode, button] of modeButtons) {
          button.classList.toggle('is-active', ed.mode() === mode);
        }
        for (const [char, button] of brushButtons) {
          button.classList.toggle('is-active', ed.brush() === char);
          // Water, trees and ice have no half-tiles (content §1). Greyed rather
          // than removed: the rule is easier to learn from a disabled control
          // than from a refusal after the fact.
          button.classList.toggle(
            'is-whole-only',
            subMode && BRUSHES.find((b) => b.char === char)?.half !== true,
          );
        }

        const enemies = ed.draft().enemies;
        for (let i = 0; i < slotButtons.length; i++) {
          const label = slotButtons[i].querySelector<HTMLElement>(
            '.bc-editor-slot-type',
          );
          if (label !== null) {
            label.textContent = ENEMY_LABELS[enemies[i]] ?? String(enemies[i]);
          }
          slotButtons[i].dataset.type = enemies[i];
        }
        const counts = waveCounts(enemies);
        waveSummary.textContent = ENEMY_TYPES.map(
          (t) => `${ENEMY_LABELS[t]} ${counts[t]}`,
        ).join(' · ');

        status.textContent = ed.status();
        status.classList.toggle('is-warning', ed.status() !== '');
        if (nameInput.value !== ed.draft().name) {
          nameInput.value = ed.draft().name;
        }
        const author = ed.draft().author ?? '';
        if (authorInput.value !== author) {
          authorInput.value = author;
        }
      }

      sync();
    },

    leave(): void {
      for (const off of teardown) {
        off();
      }
      teardown = [];
      chrome?.dispose();
      chrome = null;
    },
  };
}

// ---------------------------------------------------------------------------
// --- DOM helpers -----------------------------------------------------------
// ---------------------------------------------------------------------------

interface FieldView {
  node: HTMLElement;
  /** 26×26 subcell nodes, row-major. */
  cells: HTMLElement[];
  /** 13×13 tile nodes, row-major. */
  tiles: HTMLElement[];
}

function buildField(): FieldView {
  const node = el('div', 'bc-editor-field');
  node.dataset.role = 'field';
  const cells = new Array<HTMLElement>(SUBCELLS * SUBCELLS);
  const tiles: HTMLElement[] = [];
  for (let ty = 0; ty < FIELD_TILES; ty++) {
    for (let tx = 0; tx < FIELD_TILES; tx++) {
      const tile = el('div', 'bc-tile');
      tile.dataset.tx = String(tx);
      tile.dataset.ty = String(ty);
      const reserved = reservedTile(tx, ty);
      if (reserved !== null) {
        tile.classList.add('is-reserved');
        tile.title = reserved;
      }
      for (const sub of [0, 1, 2, 3] as const) {
        const cell = el('span', 'bc-sub');
        cell.dataset.tx = String(tx);
        cell.dataset.ty = String(ty);
        cell.dataset.sub = String(sub);
        cells[(ty * 2 + (sub < 2 ? 0 : 1)) * SUBCELLS + tx * 2 + (sub % 2)] =
          cell;
        tile.append(cell);
      }
      tiles.push(tile);
      node.append(tile);
    }
  }
  return { node, cells, tiles };
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const box = el('section', 'bc-editor-section');
  box.append(el('h2', 'bc-editor-heading', title));
  parent.append(box);
  return box;
}

function textField(
  parent: HTMLElement,
  label: string,
  value: string,
  onInput: (value: string) => void,
): HTMLInputElement {
  const row = el('label', 'bc-editor-textrow');
  row.append(el('span', 'bc-editor-textlabel', label));
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bc-editor-text';
  input.value = value;
  input.dataset.field = label.toLowerCase();
  input.addEventListener('input', () => {
    onInput(input.value);
  });
  row.append(input);
  parent.append(row);
  return input;
}

function navStep(code: string): [number, number] | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return [0, -1];
    case 'ArrowDown':
    case 'KeyS':
      return [0, 1];
    case 'ArrowLeft':
    case 'KeyA':
      return [-1, 0];
    case 'ArrowRight':
    case 'KeyD':
      return [1, 0];
    default:
      return null;
  }
}

function cursorIndex(cursor: Cursor): number {
  return (
    (cursor.ty * 2 + (cursor.sub < 2 ? 0 : 1)) * SUBCELLS +
    cursor.tx * 2 +
    (cursor.sub % 2)
  );
}

/**
 * Move the cursor a tile at a time, or a subcell at a time in half-tile mode.
 *
 * The subcell walk happens on the 26×26 grid and is folded back into
 * tile+subcell afterwards, which is what makes one arrow press cross a tile
 * boundary instead of cycling inside the tile it started in. Clamped rather
 * than wrapped: a field has edges, and a cursor that reappeared on the far side
 * would be a worse surprise than one that stops.
 */
function moveCursor(
  cursor: Cursor,
  [dx, dy]: [number, number],
  subcellMode: boolean,
): Cursor {
  if (!subcellMode) {
    return {
      tx: clamp(cursor.tx + dx, FIELD_TILES - 1),
      ty: clamp(cursor.ty + dy, FIELD_TILES - 1),
      sub: cursor.sub,
    };
  }
  const sx = clamp(cursor.tx * 2 + (cursor.sub % 2) + dx, SUBCELLS - 1);
  const sy = clamp(cursor.ty * 2 + (cursor.sub < 2 ? 0 : 1) + dy, SUBCELLS - 1);
  return {
    tx: Math.floor(sx / 2),
    ty: Math.floor(sy / 2),
    sub: ((sy % 2) * 2 + (sx % 2)) as Subcell,
  };
}

function clamp(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
