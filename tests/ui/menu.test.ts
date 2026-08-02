// tests/ui/menu.test.ts — the main menu's rows (GDD §5, T10).
//
// The whole file exists because of one row. GDD §1 ships a two-player mode and
// every layer has carried it since T1.7 — separate scores and lives, a
// `players` term in the spawn cadence (fidelity §7), p2 key bindings, a P2 HUD
// column — but until T10 the only way to REACH it was `?players=2`, a dev-only
// URL flag that a production build makes inert. A shipped 1.0 would have had no
// two-player mode at all, and nothing would have failed.
//
// So this pins the entry point rather than the mode: the row exists, it offers
// exactly two values, and it is focusable. The mode itself is covered by the
// core's own 2P parity tests (P-21) and by the e2e flow.
import { describe, expect, it } from 'vitest';
import { menuItems } from '../../src/ui/screens/menu';
import { createMenu } from '../../src/ui/menus';

describe('main menu rows', () => {
  it('offers a player-count row with exactly 1P and 2P', () => {
    const row = menuItems().find((i) => i.id === 'players');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('choice');
    if (row?.kind !== 'choice') return;
    expect(row.options.map((o) => o.value)).toEqual(['1', '2']);
    expect(row.disabled ?? false).toBe(false);
  });

  it('reflects the count it is given rather than a default', () => {
    const one = menuItems(1).find((i) => i.id === 'players');
    const two = menuItems(2).find((i) => i.id === 'players');
    expect(one?.kind === 'choice' ? one.value : null).toBe('1');
    expect(two?.kind === 'choice' ? two.value : null).toBe('2');
  });

  it('left/right on the row changes the value and reports it', () => {
    const model = createMenu(menuItems(1));
    expect(model.focusId('players')).toBe(true);
    const right = model.handle('right');
    expect(right.changed?.id).toBe('players');
    expect(right.changed?.kind === 'choice' ? right.changed.value : null).toBe(
      '2',
    );
  });

  it('still leads with the campaign and keeps every other row', () => {
    const ids = menuItems().map((i) => i.id);
    expect(ids).toEqual([
      'players',
      'campaign',
      'neo',
      'construction',
      'custom',
      'scores',
      'settings',
    ]);
  });

  // T8.3 authored twelve Neo stages and they are committed, validated and
  // completability-checked — but nothing routes a run through them, because the
  // campaign chain, the progress store and the tally all assume the original 35.
  // The row therefore stays disabled in 1.0 and its hint must say why: "not
  // built yet" was true in Phase 6 and is false now, and a hint that lies about
  // shipped content is worse than a disabled row.
  it('marks the Neo campaign unreachable rather than unbuilt', () => {
    const neo = menuItems().find((i) => i.id === 'neo');
    expect(neo?.disabled).toBe(true);
    expect(neo?.hint ?? '').toMatch(/not reachable/i);
    expect(neo?.hint ?? '').not.toMatch(/not built/i);
  });
});
