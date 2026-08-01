// tests/render/materials.test.ts — data-only. Runs in the Vitest **node**
// environment: there is no DOM and no WebGL here, so nothing in this file may
// construct a renderer, a canvas or a GL context. It asserts the two frozen
// tables `materials.ts` publishes — the palette (art §3, the hex values are
// binding) and the quality presets (art §7) — and nothing else. Scene-graph
// structure, camera math and lighting are verified visually + by the e2e smoke.

import { describe, expect, it } from 'vitest';

import {
  ICE_ALPHA,
  PALETTE,
  QUALITY_PRESETS,
  type PaletteKey,
} from '../../src/render/materials';
import type { Quality } from '../../src/render/renderer';

// Transcribed from docs/03-art-direction.md §3, top to bottom. This table is the
// spec: if the doc changes, change it here first and let the test go red.
const ART_PALETTE: readonly (readonly [PaletteKey, number])[] = [
  ['board', 0x10121b],
  ['gridLine', 0x191d2b],
  ['boardFrame', 0x262b3d],

  ['brickTop', 0xbf5a33],
  ['brickSide', 0x6f3118],
  ['brickMortar', 0x8f3f20],
  ['brickTopLip', 0xd9744c],

  ['steelTop', 0xb7c0cd],
  ['steelSide', 0x5c6474],
  ['steelRivet', 0xdde3ec],

  ['waterDeep', 0x173f75],
  ['waterWave', 0x4285d8],
  ['waterHighlight', 0x7db1ea],

  ['treesCanopy', 0x2e7d3a],
  ['treesDepth', 0x1c5527],
  ['treesHighlight', 0x46a04f],

  ['ice', 0xcadeed],
  ['iceSheen', 0xe8f4fb],

  ['player1', 0xd99c2b],
  ['player1Accent', 0xf2c14e],
  ['player2', 0x3aa655],
  ['player2Accent', 0x7fd695],

  ['enemyBasic', 0x8a8f9c],
  ['enemyBasicTrim', 0xcf4b4b],
  ['enemyFast', 0xc8a05a],
  ['enemyPower', 0x8f6bd0],
  ['enemyArmor', 0xc3cad6],

  ['powerupGold', 0xffd76b],
  ['spawnAccent', 0x7fc4ff],
  ['danger', 0xe24b4a],
];

/** `0x10121b` → `#10121b` — the form the art doc and the future CSS mirror use. */
function hex(v: number): string {
  return `#${v.toString(16).padStart(6, '0')}`;
}

describe('PALETTE (art §3)', () => {
  it.each(ART_PALETTE)('%s is %d', (key, value) => {
    // Compared as `#rrggbb` strings so a mismatch prints the two colours the
    // way the art doc writes them, not as two seven-digit decimals.
    expect(hex(PALETTE[key])).toBe(hex(value));
  });

  it('has exactly the tokens art §3 defines — no more, no less', () => {
    expect(Object.keys(PALETTE).sort()).toEqual(
      ART_PALETTE.map(([k]) => k).sort(),
    );
  });

  it('stores every token as a 24-bit integer', () => {
    for (const [key, value] of Object.entries(PALETTE)) {
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0x000000);
      expect(value, key).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('is frozen — a stray write cannot repaint the game', () => {
    const before = PALETTE.board;
    // The cast is the point: without it this line is a compile error, which is
    // the first line of defence. The freeze is the second, for JS callers and
    // for anything that reaches the object through a widened type.
    const mutable = PALETTE as unknown as Record<string, number>;
    expect(() => {
      mutable.board = 0xff00ff;
    }).toThrow(TypeError); // ES modules are strict mode: the write throws.
    expect(PALETTE.board).toBe(before);
    expect(Object.isFrozen(PALETTE)).toBe(true);
  });

  it('exports the ice alpha separately (art §3: ice @ 25%)', () => {
    expect(ICE_ALPHA).toBe(0.25);
  });
});

describe('QUALITY_PRESETS (art §7)', () => {
  const EXPECTED: readonly (readonly [
    Quality,
    { dprCap: number; shadows: boolean; shadowMapSize: number },
  ])[] = [
    ['high', { dprCap: 2, shadows: true, shadowMapSize: 2048 }],
    ['medium', { dprCap: 1.5, shadows: true, shadowMapSize: 1024 }],
    ['low', { dprCap: 1, shadows: false, shadowMapSize: 0 }],
  ];

  it.each(EXPECTED)('%s', (quality, expected) => {
    expect(QUALITY_PRESETS[quality]).toEqual(expected);
  });

  it('covers exactly the three concrete levels ("auto" is resolved upstream)', () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([
      'high',
      'low',
      'medium',
    ]);
  });

  it('is frozen, table and rows alike', () => {
    expect(Object.isFrozen(QUALITY_PRESETS)).toBe(true);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(Object.isFrozen(preset)).toBe(true);
    }
    const mutable = QUALITY_PRESETS as unknown as Record<
      string,
      { dprCap: number }
    >;
    expect(() => {
      mutable.high = { dprCap: 4 };
    }).toThrow(TypeError);
    expect(QUALITY_PRESETS.high.dprCap).toBe(2);
  });

  it('degrades monotonically — every step down costs resolution', () => {
    expect(QUALITY_PRESETS.high.dprCap).toBeGreaterThan(
      QUALITY_PRESETS.medium.dprCap,
    );
    expect(QUALITY_PRESETS.medium.dprCap).toBeGreaterThan(
      QUALITY_PRESETS.low.dprCap,
    );
    expect(QUALITY_PRESETS.high.shadowMapSize).toBeGreaterThan(
      QUALITY_PRESETS.medium.shadowMapSize,
    );
    // Shadows off is encoded as size 0, so "no shadow map" cannot be confused
    // with "a shadow map of some default size".
    expect(QUALITY_PRESETS.low.shadows).toBe(false);
    expect(QUALITY_PRESETS.low.shadowMapSize).toBe(0);
  });
});
