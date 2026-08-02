// tests/ui/settings.test.ts — T6.1's two models, both DOM-free.
//
// 1. The abstract navigation model (`src/ui/menus.ts`). It is the whole reason
//    keyboard today and gamepad/touch in Phase 9 cost the same: every screen
//    drives `MenuModel.handle(NavEvent)`, and nothing above it knows what
//    produced the event. Vitest runs in the node environment (no jsdom), so
//    this is exactly the layer that CAN be tested — the pixels are screenshot.
//
// 2. The settings model (`src/ui/screens/settings.ts`): menu items ⇄ a
//    `SettingsV1`, plus the three derivations that make a toggle actually
//    *reach* the thing it controls (volumes → audio, fx flags → renderer,
//    bindings → input).

import { describe, expect, it } from 'vitest';
import {
  createMenu,
  navFromKey,
  type ChoiceItem,
  type MenuItem,
  type SliderItem,
  type ToggleItem,
} from '../../src/ui/menus';
import {
  bindingKey,
  bindingsFor,
  buildSettingsItems,
  fxFlagsFor,
  readSettings,
  rebind,
  volumesFor,
} from '../../src/ui/screens/settings';
import {
  loadSettings,
  saveSettings,
  type SettingsV1,
} from '../../src/app/storage';
import { DEFAULT_BINDINGS } from '../../src/input/keyboard';

// --- a localStorage stand-in ----------------------------------------------
// `storage.ts` reads `globalThis.localStorage` through optional chaining, so a
// plain object with the two methods it uses is enough — and it lets a test put
// a deliberately corrupt payload in place, which a real one would not.
function installStorage(
  seed: Record<string, string> = {},
): Map<string, string> {
  const map = new Map<string, string>(Object.entries(seed));
  const fake = {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      map.set(k, v);
    },
    removeItem: (k: string): void => {
      map.delete(k);
    },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = fake;
  return map;
}

function items(): MenuItem[] {
  return [
    { kind: 'action', id: 'a', label: 'A' },
    { kind: 'action', id: 'b', label: 'B' },
    { kind: 'action', id: 'c', label: 'C', disabled: true },
  ];
}

describe('navFromKey (GDD §7: one vocabulary, every device)', () => {
  it('maps both movement layouts onto the same four directions', () => {
    expect(navFromKey('ArrowUp')).toBe('up');
    expect(navFromKey('KeyW')).toBe('up');
    expect(navFromKey('ArrowDown')).toBe('down');
    expect(navFromKey('KeyS')).toBe('down');
    expect(navFromKey('ArrowLeft')).toBe('left');
    expect(navFromKey('KeyA')).toBe('left');
    expect(navFromKey('ArrowRight')).toBe('right');
    expect(navFromKey('KeyD')).toBe('right');
  });

  it('maps confirm and back, and ignores everything else', () => {
    expect(navFromKey('Enter')).toBe('confirm');
    expect(navFromKey('Space')).toBe('confirm');
    expect(navFromKey('KeyJ')).toBe('confirm'); // GDD §7's P1 fire key
    expect(navFromKey('Escape')).toBe('back');
    expect(navFromKey('Backspace')).toBe('back');
    expect(navFromKey('F5')).toBe(null);
    expect(navFromKey('Tab')).toBe(null);
  });
});

describe('createMenu — focus movement', () => {
  it('wraps in both directions', () => {
    const menu = createMenu(items());
    expect(menu.index()).toBe(0);
    expect(menu.handle('down').moved).toBe(true);
    expect(menu.index()).toBe(1);
    menu.handle('down');
    expect(menu.index()).toBe(2);
    menu.handle('down');
    expect(menu.index()).toBe(0); // wrapped
    menu.handle('up');
    expect(menu.index()).toBe(2); // wrapped the other way
  });

  it('keeps a disabled item focusable but refuses to activate it', () => {
    // Placeholders (Neo, Construction, Custom until Phase 8) have to read as
    // deliberate rather than missing, so they take focus and say why.
    const menu = createMenu(items());
    menu.setIndex(2);
    const res = menu.handle('confirm');
    expect(res.activated).toBe(null);
    expect(res.rejected).toBe(true);
  });

  it('skips label rows entirely — they are text, not controls', () => {
    const menu = createMenu([
      { kind: 'label', id: 'head', label: 'Video' },
      { kind: 'action', id: 'a', label: 'A' },
      { kind: 'label', id: 'foot', label: 'note' },
      { kind: 'action', id: 'b', label: 'B' },
    ]);
    expect(menu.index()).toBe(1); // first FOCUSABLE row, not row 0
    menu.handle('down');
    expect(menu.index()).toBe(3);
    menu.handle('down');
    expect(menu.index()).toBe(1);
  });

  it('reports no movement when there is only one focusable row', () => {
    const menu = createMenu([{ kind: 'action', id: 'a', label: 'A' }]);
    expect(menu.handle('down').moved).toBe(false);
  });

  it('returns `back` without moving focus', () => {
    const menu = createMenu(items());
    const res = menu.handle('back');
    expect(res.back).toBe(true);
    expect(menu.index()).toBe(0);
  });
});

describe('createMenu — value editing', () => {
  it('left/right adjusts a slider and clamps at both ends', () => {
    const slider: SliderItem = {
      kind: 'slider',
      id: 'music',
      label: 'Music',
      value: 0.7,
      min: 0,
      max: 1,
      step: 0.05,
    };
    const menu = createMenu([slider]);
    expect(menu.handle('right').changed?.id).toBe('music');
    expect(slider.value).toBeCloseTo(0.75, 6);
    menu.handle('left');
    menu.handle('left');
    expect(slider.value).toBeCloseTo(0.65, 6);

    slider.value = 1;
    // At the ceiling there is nothing to change, so nothing is reported —
    // otherwise a held key would save and re-save settings forever.
    expect(menu.handle('right').changed).toBe(null);
    expect(slider.value).toBe(1);

    slider.value = 0;
    expect(menu.handle('left').changed).toBe(null);
    expect(slider.value).toBe(0);
  });

  it('keeps a slider on its step grid rather than accumulating float error', () => {
    const slider: SliderItem = {
      kind: 'slider',
      id: 'sfx',
      label: 'SFX',
      value: 0.8,
      min: 0,
      max: 1,
      step: 0.05,
    };
    const menu = createMenu([slider]);
    for (let i = 0; i < 4; i++) {
      menu.handle('left');
    }
    expect(slider.value).toBe(0.6); // exactly, not 0.6000000000000001
  });

  it('cycles a choice with wrap, in both directions', () => {
    const choice: ChoiceItem = {
      kind: 'choice',
      id: 'quality',
      label: 'Quality',
      value: 'auto',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    };
    const menu = createMenu([choice]);
    menu.handle('left');
    expect(choice.value).toBe('high'); // wrapped backwards off the first
    menu.handle('right');
    expect(choice.value).toBe('auto');
    menu.handle('right');
    expect(choice.value).toBe('low');
  });

  it('flips a toggle on confirm and sets it explicitly on left/right', () => {
    const toggle: ToggleItem = {
      kind: 'toggle',
      id: 'highContrast',
      label: 'High contrast',
      value: false,
    };
    const menu = createMenu([toggle]);
    expect(menu.handle('confirm').changed?.id).toBe('highContrast');
    expect(toggle.value).toBe(true);
    expect(menu.handle('right').changed).toBe(null); // already on
    menu.handle('left');
    expect(toggle.value).toBe(false);
  });

  it('never edits a disabled control', () => {
    const slider: SliderItem = {
      kind: 'slider',
      id: 'music',
      label: 'Music',
      value: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      disabled: true,
    };
    const menu = createMenu([slider]);
    expect(menu.handle('right').changed).toBe(null);
    expect(slider.value).toBe(0.5);
  });
});

describe('settings model (GDD §10)', () => {
  it('round-trips every field through storage', () => {
    installStorage();
    const written: SettingsV1 = {
      music: 0.35,
      sfx: 0.15,
      quality: 'medium',
      screenShake: false,
      reducedFlash: true,
      highContrast: true,
      bindings: { [bindingKey(1, 'fire')]: 'KeyK' },
    };
    saveSettings(written);
    expect(loadSettings()).toEqual(written);
  });

  it('still yields a usable UI from a corrupt blob', () => {
    installStorage({ 'bc.settings.v1': '{"music":"loud",' });
    const s = loadSettings();
    // Field-wise defaults, never a half-typed object (arch §4.2).
    expect(s.music).toBeGreaterThanOrEqual(0);
    expect(s.highContrast).toBe(false);
    const built = buildSettingsItems(s);
    expect(built.length).toBeGreaterThan(0);
    expect(readSettings(built, s)).toEqual(s);
  });

  it('drops only the corrupt field, keeping the rest', () => {
    installStorage({
      'bc.settings.v1': JSON.stringify({
        music: 5, // out of range → default
        sfx: 0.25, // fine → kept
        quality: 'ultra', // not a preset → default
        screenShake: 'no', // wrong type → default
        highContrast: true,
      }),
    });
    const s = loadSettings();
    expect(s.sfx).toBe(0.25);
    expect(s.music).toBe(0.7);
    expect(s.quality).toBe('auto');
    expect(s.screenShake).toBe(true);
    expect(s.highContrast).toBe(true);
  });

  it('builds one control per GDD §10 setting and folds them back unchanged', () => {
    installStorage();
    const s = loadSettings();
    const built = buildSettingsItems(s);
    const ids = built.map((i) => i.id);
    for (const id of [
      'music',
      'sfx',
      'quality',
      'screenShake',
      'reducedFlash',
      'highContrast',
    ]) {
      expect(ids, `missing control: ${id}`).toContain(id);
    }
    // Rebinding, per player (GDD §10 "remap keyboard bindings per player").
    expect(ids).toContain(bindingKey(1, 'up'));
    expect(ids).toContain(bindingKey(2, 'fire'));
    // An untouched form is a no-op: read(build(s)) === s.
    expect(readSettings(built, s)).toEqual(s);
  });

  it('folds an edited control back into the settings object', () => {
    installStorage();
    const s = loadSettings();
    const built = buildSettingsItems(s);
    const menu = createMenu(built);
    menu.setIndex(built.findIndex((i) => i.id === 'highContrast'));
    menu.handle('confirm');
    menu.setIndex(built.findIndex((i) => i.id === 'quality'));
    menu.handle('right');
    const next = readSettings(built, s);
    expect(next.highContrast).toBe(true);
    expect(next.quality).not.toBe(s.quality);
  });
});

describe('every toggle reaches the thing it controls', () => {
  const base: SettingsV1 = {
    music: 0.25,
    sfx: 0.5,
    quality: 'low',
    screenShake: false,
    reducedFlash: true,
    highContrast: true,
    bindings: {},
  };

  it('volumes reach the audio graph', () => {
    expect(volumesFor(base)).toEqual({ music: 0.25, sfx: 0.5 });
  });

  it('the three video toggles reach the renderer as one flag object', () => {
    const flags = fxFlagsFor(base, false);
    expect(flags.screenShake).toBe(false);
    expect(flags.reducedFlash).toBe(true);
    expect(flags.highContrast).toBe(true);
    expect(flags.reducedMotion).toBe(false);
  });

  it('honours the OS reduced-motion preference on top of the setting', () => {
    // Art §11: the preference and the toggle are two sources for one behaviour,
    // and the OS one must not be overridable by a stale stored `true`.
    expect(fxFlagsFor({ ...base, screenShake: true }, true).reducedMotion).toBe(
      true,
    );
    expect(fxFlagsFor({ ...base, screenShake: true }, true).screenShake).toBe(
      false,
    );
  });

  it('bindings reach the input layer, defaults filling every unbound action', () => {
    const s: SettingsV1 = {
      ...base,
      bindings: { [bindingKey(1, 'fire')]: 'KeyK' },
    };
    const b = bindingsFor(s);
    expect(b.p1.fire).toBe('KeyK');
    expect(b.p1.up).toBe(DEFAULT_BINDINGS.p1.up);
    expect(b.p2.fire).toBe(DEFAULT_BINDINGS.p2.fire);
  });

  it('rebinding writes one key and leaves the others alone', () => {
    const s = rebind(rebind(base, 1, 'up', 'KeyI'), 2, 'left', 'KeyH');
    expect(bindingsFor(s).p1.up).toBe('KeyI');
    expect(bindingsFor(s).p2.left).toBe('KeyH');
    expect(bindingsFor(s).p1.left).toBe(DEFAULT_BINDINGS.p1.left);
    // The original is untouched — a settings screen edits a copy, so an
    // abandoned edit cannot leak into a live game's controls.
    expect(base.bindings).toEqual({});
  });
});
