// src/ui/screens/settings.ts — GDD §10's settings, and the three derivations
// that make each one actually *reach* something.
//
// The file is in two halves and the split is the point:
//
// - **The model** (top): pure functions over `SettingsV1`. A menu item list is
//   built from a settings object and folded back into one; three more functions
//   turn a settings object into the shapes the audio, render and input layers
//   take. All of it is `tests/ui/settings.test.ts`, in the node environment.
// - **The screen** (bottom): the DOM. Verified by screenshot.
//
// A setting that has no derivation below is a setting that does nothing, which
// is the failure mode this arrangement exists to make visible: every field of
// `SettingsV1` appears in exactly one of `volumesFor`, `fxFlagsFor`,
// `qualityFor` or `bindingsFor`.

import type { FxFlags } from '../../render/fx/fxSystem';
import type { SettingsV1 } from '../../app/storage';
import { saveSettings } from '../../app/storage';
import {
  DEFAULT_BINDINGS,
  type Bindings,
  type InputAction,
} from '../../input/keyboard';
import type { AudioSystem } from '../../audio/audio';
import {
  attachNav,
  createMenu,
  keyLabel,
  legend,
  mountChrome,
  mountMenu,
  type MenuItem,
  type NavEvent,
} from '../menus';
import type { Screen } from '../../app/screens';

// ---------------------------------------------------------------------------
// --- The model -------------------------------------------------------------
// ---------------------------------------------------------------------------

/** Volume sliders move in 5% steps — fine enough to mix, coarse enough to hit. */
export const VOLUME_STEP = 0.05;

/**
 * The actions a player may remap, per player, in the order the screen lists
 * them. `fireAlt` is deliberately absent: it is P2's *second* fire key (GDD §7),
 * not a second action, and offering to rebind it would let a player strand
 * themselves with two bindings for one button and no way to tell them apart.
 */
export const REBINDABLE: readonly InputAction[] = Object.freeze([
  'up',
  'down',
  'left',
  'right',
  'fire',
  'pause',
]);

export type Pad = 1 | 2;

/**
 * The storage key for one binding. `SettingsV1.bindings` is one flat
 * `Record<string, string>` (arch §4.2, settled), so per-player bindings are
 * namespaced into it rather than nested — which keeps the storage validator,
 * whose whole contract is "drop the corrupt entry, keep the rest", working
 * unchanged.
 */
export function bindingKey(pad: Pad, action: InputAction): string {
  return `p${pad}.${action}`;
}

const QUALITY_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]);

/** GDD §10, in the order the screen shows them. */
export function buildSettingsItems(s: SettingsV1): MenuItem[] {
  const items: MenuItem[] = [
    { kind: 'label', id: 'audio', label: 'Audio' },
    {
      kind: 'slider',
      id: 'music',
      label: 'Music volume',
      value: s.music,
      min: 0,
      max: 1,
      step: VOLUME_STEP,
    },
    {
      kind: 'slider',
      id: 'sfx',
      label: 'Sound volume',
      value: s.sfx,
      min: 0,
      max: 1,
      step: VOLUME_STEP,
    },
    { kind: 'label', id: 'video', label: 'Video' },
    {
      kind: 'choice',
      id: 'quality',
      label: 'Quality',
      value: s.quality,
      options: QUALITY_OPTIONS,
    },
    {
      kind: 'toggle',
      id: 'screenShake',
      label: 'Screen shake',
      value: s.screenShake,
    },
    {
      kind: 'toggle',
      id: 'reducedFlash',
      label: 'Reduce flashing',
      value: s.reducedFlash,
    },
    {
      kind: 'toggle',
      id: 'highContrast',
      label: 'High contrast',
      value: s.highContrast,
      hint: 'Brightens your tank and darkens enemies so they differ in value, not only in colour.',
    },
  ];

  for (const pad of [1, 2] as const) {
    items.push({
      kind: 'label',
      id: `controls${pad}`,
      label: `Player ${pad} controls`,
    });
    for (const action of REBINDABLE) {
      items.push({
        kind: 'binding',
        id: bindingKey(pad, action),
        label: actionLabel(action),
        code: bindingsFor(s)[pad === 1 ? 'p1' : 'p2'][action] ?? '',
        listening: false,
      });
    }
  }

  return items;
}

function actionLabel(action: InputAction): string {
  switch (action) {
    case 'up':
      return 'Move up';
    case 'down':
      return 'Move down';
    case 'left':
      return 'Move left';
    case 'right':
      return 'Move right';
    case 'fire':
      return 'Fire';
    case 'fireAlt':
      return 'Fire (alternate)';
    default:
      return 'Pause';
  }
}

/**
 * Folds an edited item list back into a settings object.
 *
 * `base` supplies everything the form does not present, so this is a *patch*
 * rather than a reconstruction — a field added to `SettingsV1` without a
 * control survives a visit to this screen instead of being reset to its default.
 */
export function readSettings(
  items: readonly MenuItem[],
  base: SettingsV1,
): SettingsV1 {
  const next: SettingsV1 = { ...base, bindings: { ...base.bindings } };
  for (const item of items) {
    switch (item.kind) {
      case 'slider':
        if (item.id === 'music') next.music = item.value;
        if (item.id === 'sfx') next.sfx = item.value;
        break;
      case 'choice':
        if (item.id === 'quality') {
          next.quality = item.value as SettingsV1['quality'];
        }
        break;
      case 'toggle':
        if (item.id === 'screenShake') next.screenShake = item.value;
        if (item.id === 'reducedFlash') next.reducedFlash = item.value;
        if (item.id === 'highContrast') next.highContrast = item.value;
        break;
      case 'binding':
        // Only a *departure* from the default is stored. Storing every binding
        // would freeze a player's map against any future change to GDD §7's
        // defaults, and it would also make `bindings` unreadable in devtools.
        if (item.code === defaultCodeFor(item.id)) {
          delete next.bindings[item.id];
        } else if (item.code !== '') {
          next.bindings[item.id] = item.code;
        }
        break;
      default:
        break;
    }
  }
  return next;
}

function defaultCodeFor(id: string): string {
  const [pad, action] = id.split('.');
  const side = pad === 'p2' ? DEFAULT_BINDINGS.p2 : DEFAULT_BINDINGS.p1;
  return side[action] ?? '';
}

// --- the four derivations --------------------------------------------------

/** → `AudioSystem.setVolumes` (audio §2). */
export function volumesFor(s: SettingsV1): { music: number; sfx: number } {
  return { music: s.music, sfx: s.sfx };
}

/** → the concrete preset the renderer takes, or `null` for "probe it" (arch §5). */
export function qualityFor(s: SettingsV1): SettingsV1['quality'] {
  return s.quality;
}

/**
 * → `Renderer.setFxFlags`.
 *
 * `osReducedMotion` is `prefers-reduced-motion`, and it is an **override, not a
 * vote**: art §11 makes the OS preference and the in-game toggle two sources
 * for one behaviour, and a player who has asked their whole system for less
 * motion must not have that undone by a stale `screenShake: true` in storage.
 * So reduced motion also forces the shake off, while the shake toggle on its
 * own leaves the slow-mo beat and the fly-in alone.
 */
export function fxFlagsFor(s: SettingsV1, osReducedMotion: boolean): FxFlags {
  return {
    reducedMotion: osReducedMotion,
    reducedFlash: s.reducedFlash,
    screenShake: osReducedMotion ? false : s.screenShake,
    highContrast: s.highContrast,
  };
}

/** → `createInput` (arch §7). Defaults fill every action the player left alone. */
export function bindingsFor(s: SettingsV1): Bindings {
  const side = (pad: Pad): Record<string, string> => {
    const base = pad === 1 ? DEFAULT_BINDINGS.p1 : DEFAULT_BINDINGS.p2;
    const out: Record<string, string> = { ...base };
    for (const action of Object.keys(base)) {
      const override = s.bindings[bindingKey(pad, action as InputAction)];
      if (typeof override === 'string' && override !== '') {
        out[action] = override;
      }
    }
    return out;
  };
  return { p1: side(1), p2: side(2) };
}

/** A copy with one binding changed. The input is never mutated. */
export function rebind(
  s: SettingsV1,
  pad: Pad,
  action: InputAction,
  code: string,
): SettingsV1 {
  const bindings = { ...s.bindings };
  const key = bindingKey(pad, action);
  if (code === defaultCodeFor(key)) {
    delete bindings[key];
  } else {
    bindings[key] = code;
  }
  return { ...s, bindings };
}

// ---------------------------------------------------------------------------
// --- The screen ------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface SettingsScreenOptions {
  /** The live settings. Edits are applied and persisted immediately. */
  read(): SettingsV1;
  /** Called on every change: persist, and push the value at what it controls. */
  apply(next: SettingsV1): void;
  onBack(): void;
  audio?: AudioSystem | null;
}

/**
 * GDD §10's screen.
 *
 * Every edit applies **immediately** and persists immediately — there is no OK
 * button. That is deliberate for a settings screen whose controls are all
 * previewable: moving the SFX slider should make a sound at the new volume, and
 * turning high contrast on should be visible on the board behind the panel.
 */
export function createSettingsScreen(opts: SettingsScreenOptions): Screen {
  let detach: (() => void) | null = null;
  let chrome: { dispose(): void } | null = null;

  return {
    enter(root: HTMLElement): void {
      let settings = opts.read();
      const items = buildSettingsItems(settings);
      const model = createMenu(items);
      const view = mountChrome(root, {
        screen: 'settings',
        title: 'Settings',
        subtitle: 'Changes save as you make them.',
      });
      chrome = view;
      const menu = mountMenu(view.body, model, () => {
        onNav('confirm');
      });
      legend(
        view.footer,
        ['↑ ↓', 'Choose'],
        ['← →', 'Adjust'],
        ['Enter', 'Rebind'],
        ['Esc', 'Back'],
      );

      const commit = (): void => {
        settings = readSettings(items, settings);
        opts.apply(settings);
        saveSettings(settings);
        menu.sync();
      };

      /** The row waiting for a key press, or `null`. */
      let listening: { id: string } | null = null;

      function onNav(ev: NavEvent): void {
        const res = model.handle(ev);
        if (res.back) {
          opts.audio?.play('uiBack');
          opts.onBack();
          return;
        }
        if (res.moved) {
          opts.audio?.play('uiMove');
        }
        if (res.rejected) {
          opts.audio?.play('uiBack');
        }
        if (res.changed !== null) {
          commit();
          // The SFX slider previews itself; the music slider is already audible
          // through the bed, so it does not need a second cue.
          opts.audio?.play(res.changed.id === 'music' ? 'uiMove' : 'uiSelect');
        }
        if (res.activated !== null && res.activated.kind === 'binding') {
          opts.audio?.play('uiSelect');
          res.activated.listening = true;
          listening = { id: res.activated.id };
        }
        menu.sync();
      }

      /**
       * While a binding row is listening, EVERY key belongs to it — including
       * the nav keys, which is the whole point: a player must be able to bind
       * Enter, or the arrows, without the menu eating the press first. Escape
       * is the one reserved key, because a rebind with no way out is a trap.
       */
      function onRawKey(code: string): boolean {
        if (listening === null) {
          return false;
        }
        const row = items.find((i) => i.id === listening?.id);
        listening = null;
        if (row !== undefined && row.kind === 'binding') {
          row.listening = false;
          if (code !== 'Escape') {
            row.code = code;
            commit();
            opts.audio?.play('uiSelect');
          } else {
            opts.audio?.play('uiBack');
          }
        }
        menu.sync();
        return true;
      }

      detach = attachNav(window, onNav, onRawKey);
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

/** Exported for the capture script's legend. */
export { keyLabel };
