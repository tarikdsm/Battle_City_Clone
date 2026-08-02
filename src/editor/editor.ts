// src/editor/editor.ts — the construction mode's model (arch §9).
//
// Everything the editor *is*, minus everything it looks like: the draft, the
// current tool, the undo history, the metadata and the two validation gates.
// `src/ui/screens/editor.ts` renders this and sends it events; it makes no
// decisions of its own. That split is what lets the whole editor be tested in
// Vitest's node environment, where there is no DOM at all.
//
// ## Undo is per stroke, not per subcell
//
// A subcell brush dragged across a tile fires four paints. If each were an undo
// step, one Ctrl-Z would take back a quarter of a tile and getting back to
// where you were would take fifty. So the screen wraps a drag in
// `beginStroke()` / `endStroke()` and the history records the state the stroke
// started from — once, and only if the stroke actually changed something.

import type { EnemyType, LevelData } from '../core/types';
import { completabilityErrors } from '../levels/analysis';
import { validateLevel } from '../levels/schema';
import {
  createDraft,
  paintSubcell,
  paintTile,
  type Brush,
  type PaintMode,
  type Subcell,
} from './tools';
import { cycleSlotType, fillFrom, setSlotType } from './waveEditor';

/** How deep Ctrl-Z goes. A draft is ~1 KB, so this costs well under 100 KB. */
const HISTORY_LIMIT = 64;

export interface EditorModel {
  draft(): LevelData;
  mode(): PaintMode;
  brush(): Brush;
  /** The last thing that happened, for the status line. `''` when nothing has. */
  status(): string;
  setStatus(message: string): void;
  setMode(mode: PaintMode): void;
  setBrush(brush: Brush): void;
  /** Paint through the current tool. `sub` is required in subcell mode. */
  paintAt(tx: number, ty: number, sub?: Subcell): boolean;
  beginStroke(): void;
  endStroke(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  setName(name: string): void;
  setAuthor(author: string): void;
  setEnemy(index: number, type: EnemyType): void;
  cycleEnemy(index: number, delta: number): void;
  fillEnemiesFrom(index: number, type: EnemyType): void;
  /** Replace the draft wholesale — a load, an import, a new stage. */
  load(level: LevelData): void;
  /**
   * Everything wrong with the draft, in the words the author should read.
   *
   * `validateLevel`'s messages come through **verbatim** (arch §9: "invalid
   * custom levels fail with a user-readable reason"), and the completability
   * walk runs only once the schema passes, because it indexes rows that a
   * structurally broken level does not have.
   */
  validate(): string[];
}

export function createEditor(initial?: LevelData): EditorModel {
  let draft: LevelData = initial ?? createDraft();
  let mode: PaintMode = 'tile';
  let brush: Brush = 'B';
  let status = '';
  const undoStack: LevelData[] = [];
  const redoStack: LevelData[] = [];
  /** The draft as it was when the current stroke began, or `null` between. */
  let strokeStart: LevelData | null = null;
  /**
   * What the previous edit was, for coalescing (see {@link edit}). `null` after
   * anything that must not be merged into — a paint, an undo, a redo, a load.
   */
  let lastTag: string | null = null;

  /** Record a step. Outside a stroke every edit is its own step. */
  function commit(before: LevelData): void {
    if (before === draft) {
      return;
    }
    undoStack.push(before);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack.shift();
    }
    // A new edit on an undone state forks the timeline; keeping the old redo
    // entries would let a Ctrl-Y jump to a draft that never followed this one.
    redoStack.length = 0;
  }

  /**
   * Apply an edit that is not part of a stroke.
   *
   * `tag` coalesces: consecutive edits carrying the same tag share one history
   * step. Typing a nine-character stage name is one edit an author would want
   * back, not nine — and the alternative (metadata outside the history) is
   * worse, because then an undo of a later paint would restore a snapshot with
   * the old name in it and silently retype the field.
   */
  function edit(next: LevelData, tag: string | null = null): void {
    if (next === draft) {
      return;
    }
    if (tag === null || tag !== lastTag) {
      commit(draft);
    }
    lastTag = tag;
    draft = next;
  }

  return {
    draft: () => draft,
    mode: () => mode,
    brush: () => brush,
    status: () => status,

    setStatus(message: string): void {
      status = message;
    },

    setMode(next: PaintMode): void {
      mode = next;
    },

    setBrush(next: Brush): void {
      brush = next;
    },

    paintAt(tx: number, ty: number, sub?: Subcell): boolean {
      const result =
        mode === 'subcell' && sub !== undefined
          ? paintSubcell(draft, tx, ty, sub, brush)
          : paintTile(draft, tx, ty, brush);
      status = result.refused ?? '';
      if (!result.changed) {
        return false;
      }
      if (strokeStart === null) {
        commit(draft);
      }
      lastTag = null;
      draft = result.level;
      return true;
    },

    beginStroke(): void {
      strokeStart = draft;
    },

    endStroke(): void {
      const start = strokeStart;
      strokeStart = null;
      if (start !== null) {
        commit(start);
      }
    },

    undo(): boolean {
      const previous = undoStack.pop();
      if (previous === undefined) {
        return false;
      }
      redoStack.push(draft);
      draft = previous;
      lastTag = null;
      return true;
    },

    redo(): boolean {
      const next = redoStack.pop();
      if (next === undefined) {
        return false;
      }
      // Pushed directly rather than through `commit`, which would clear the
      // very stack we are walking.
      undoStack.push(draft);
      draft = next;
      lastTag = null;
      return true;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    setName(name: string): void {
      edit({ ...draft, name }, 'name');
    },

    setAuthor(author: string): void {
      edit({ ...draft, author }, 'author');
    },

    setEnemy(index: number, type: EnemyType): void {
      edit({ ...draft, enemies: setSlotType(draft.enemies, index, type) });
    },

    cycleEnemy(index: number, delta: number): void {
      edit({ ...draft, enemies: cycleSlotType(draft.enemies, index, delta) });
    },

    fillEnemiesFrom(index: number, type: EnemyType): void {
      edit({ ...draft, enemies: fillFrom(draft.enemies, index, type) });
    },

    load(level: LevelData): void {
      edit(level);
      lastTag = null;
      status = '';
    },

    validate(): string[] {
      const result = validateLevel(draft);
      if (!result.ok) {
        return result.errors;
      }
      return completabilityErrors(result.level);
    },
  };
}
