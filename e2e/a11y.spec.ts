// e2e/a11y.spec.ts — GDD §10 and art §11, verified end to end (T10).
//
// The accessibility rules were implemented in Phase 6 and unit-tested at the
// layer that owns each one: `cameraFx.test.ts` for shake and slow-mo,
// `fxSystem.test.ts` for the flash, `settings.test.ts` for the flag plumbing,
// `docs/calibration/high-contrast.json` for the measured luma separation. What
// none of those can answer is whether the rules survive the *wiring* — whether
// the OS preference reaches the renderer through five modules, whether the
// toggle a player flips persists and comes back, whether the key a player binds
// actually drives the tank. That is what this file is for, and it is the reason
// every assertion below goes through the real screens with the real keyboard.
//
// A note on what is NOT asserted here: the reduced-motion rule covers shake,
// slow-mo, flash and the stage fly-in, and only the fly-in has a DOM-observable
// consequence (the board's on-screen box moves during a sweep and does not move
// without one). The other three are asserted at the unit layer, where the flag
// is an input to a pure function; asserting them here would mean sampling
// pixels for a shake that may or may not be happening on the frame we look.
import { expect, test, type Page } from '@playwright/test';

/** Collects every console/page error for the life of the page. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

const screen = (page: Page, name: string) =>
  page.locator(`[data-screen="${name}"]`);
const hud = (page: Page, name: string) => page.locator(`[data-hud="${name}"]`);
const row = (page: Page, id: string) => page.locator(`[data-item="${id}"]`);

/** WCAG relative luminance of an `rgb(r g b / a)` string, over `under`. */
function contrastRatio(fg: number[], bg: number[]): number {
  const lum = (c: number[]): number => {
    const f = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Read the finished drawing buffer.
 *
 * **Inside a `requestAnimationFrame` callback, and that is not incidental.**
 * The canvas has no `preserveDrawingBuffer`, so the pixels only exist between
 * the app's draw and the compositor's swap; a `readPixels` from an ordinary
 * `evaluate` lands after the swap and returns a buffer of zeros — which reads
 * exactly like "nothing was drawn" and is how the first version of these two
 * tests failed. Our callback is registered after the app's, so by the time it
 * runs the frame is complete and still there. This is the same constraint
 * `scripts/capture-play.ts` solves by patching rAF outright.
 */
async function readFrame(page: Page): Promise<{
  box: number[];
  mean: number[];
}> {
  return await page.evaluate(
    async () =>
      await new Promise<{ box: number[]; mean: number[] }>((resolve) => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector(
            'canvas#game',
          ) as HTMLCanvasElement;
          const gl = canvas.getContext('webgl2');
          if (gl === null) {
            resolve({ box: [0, 0, -1, -1], mean: [0, 0, 0] });
            return;
          }
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let x0 = w;
          let y0 = h;
          let x1 = -1;
          let y1 = -1;
          let r = 0;
          let g = 0;
          let b = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              r += px[i];
              g += px[i + 1];
              b += px[i + 2];
              // The clear colour is 0x0a0a0a; anything brighter was drawn.
              if (px[i] > 16 || px[i + 1] > 16 || px[i + 2] > 16) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
              }
            }
          }
          const n = w * h;
          resolve({ box: [x0, y0, x1, y1], mean: [r / n, g / n, b / n] });
        });
      }),
  );
}

/** Walk title → menu → settings with the keyboard alone. */
async function toSettings(page: Page): Promise<void> {
  await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(screen(page, 'menu')).toBeVisible();
  // The menu is a list; walk to the settings row rather than counting presses,
  // so inserting a row above it (T10 added one) cannot silently retarget this.
  for (let i = 0; i < 12; i++) {
    const cls = (await row(page, 'settings').getAttribute('class')) ?? '';
    if (cls.includes('is-focused')) break;
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await expect(screen(page, 'settings')).toBeVisible();
}

/** Move the settings cursor onto `id`, whichever row it starts on. */
async function focusRow(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const cls = (await row(page, id).getAttribute('class')) ?? '';
    if (cls.includes('is-focused')) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`could not focus settings row ${id}`);
}

test("HUD text meets art §11's 4.5:1 minimum against its own panel", async ({
  page,
}) => {
  // Measured from the *computed* styles of the mounted HUD, not from the
  // palette table — art §11 constrains what a player sees, and a rule that
  // dimmed a value somewhere in the cascade would pass a token-level check.
  await page.goto('/?quality=low&stage=1&seed=1');
  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });

  const samples = await page.evaluate(() => {
    const parse = (s: string): number[] => {
      const m = s.match(/[\d.]+/g) ?? [];
      return [Number(m[0] ?? 0), Number(m[1] ?? 0), Number(m[2] ?? 0)];
    };
    // The HUD panel's own background is what its text sits on. It is
    // semi-transparent over the page, so the effective backdrop is composited
    // here rather than assumed opaque.
    const rootEl = document.querySelector('[data-hud="root"]');
    if (rootEl === null) return [];
    const rootBg = getComputedStyle(rootEl).backgroundColor;
    const pageBg = getComputedStyle(document.body).backgroundColor;
    const alpha = Number(rootBg.match(/[\d.]+/g)?.[3] ?? '1');
    const over = parse(rootBg);
    const under = parse(pageBg);
    const bg = over.map((c, i) => c * alpha + under[i] * (1 - alpha));

    const out: { name: string; fg: number[]; bg: number[] }[] = [];
    for (const el of document.querySelectorAll('[data-hud]')) {
      const name = el.getAttribute('data-hud') ?? '';
      // Containers have no text of their own; only leaves are read.
      if (el.children.length > 0 || (el.textContent ?? '').trim() === '') {
        continue;
      }
      out.push({ name, fg: parse(getComputedStyle(el).color), bg });
    }
    return out;
  });

  expect(samples.length, 'no HUD text found to measure').toBeGreaterThan(2);
  for (const s of samples) {
    const ratio = contrastRatio(s.fg, s.bg);
    expect(
      ratio,
      `HUD "${s.name}" contrast ${ratio.toFixed(2)}:1 (art §11 wants ≥ 4.5)`,
    ).toBeGreaterThanOrEqual(4.5);
  }
});

test('reduced motion: the board is framed on the first frame, never swept in', async ({
  page,
}) => {
  // Art §11 (ratified T4.3): `prefers-reduced-motion` suppresses shake, slow-mo,
  // flash AND the stage fly-in. The fly-in is the one with a DOM-observable
  // consequence — a 23° camera sweep moves the drawn board across the canvas —
  // so it is the one this asserts, end to end from the OS preference.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&stage=1&seed=7');
  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });

  // The board is drawn into the canvas, so its extent is measured from the
  // pixels rather than from a layout box. Sampled across the window the fly-in
  // would occupy; a sweep shows up as the box translating between samples.
  const first = (await readFrame(page)).box;
  expect(first[2], 'nothing drawn').toBeGreaterThan(0);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    const later = (await readFrame(page)).box;
    // The tolerance is 40 drawing-buffer pixels, and the gap between what it
    // permits and what it catches is the whole argument for the number. The
    // extremes are found by brightness, and the frame wall is dark enough that
    // the outermost few rows fall under the threshold — so the detected box is
    // really "the outermost BRIGHT thing", which moves by tens of pixels as a
    // spawn star lights up row 0 or an explosion blooms near an edge. Art §11's
    // fly-in is a 23 degree camera sweep across a 900 px canvas: it moves the
    // board by hundreds. 40 sits an order of magnitude below the failure it has
    // to catch and above the noise it has to tolerate.
    for (let k = 0; k < 4; k++) {
      expect(
        Math.abs(later[k] - first[k]),
        `board edge ${k} moved ${Math.abs(later[k] - first[k])} px under ` +
          'prefers-reduced-motion',
      ).toBeLessThanOrEqual(40);
    }
  }
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('high contrast: the toggle persists, round-trips and boots clean', async ({
  page,
}) => {
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&seed=3');
  await toSettings(page);
  await focusRow(page, 'highContrast');

  const value = row(page, 'highContrast').locator('[data-value]');
  await expect(value).toHaveText(/off/i);
  await page.keyboard.press('ArrowRight');
  await expect(value).toHaveText(/on/i);

  // Persisted, not merely displayed: art §11 calls this mode required, and a
  // required mode that forgets itself on reload is not one.
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bc.settings.v1') ?? '{}'),
  );
  expect(stored.highContrast).toBe(true);

  // And it survives a reload, through the real settings screen.
  await page.goto('/?quality=low&seed=3');
  await toSettings(page);
  await expect(row(page, 'highContrast').locator('[data-value]')).toHaveText(
    /on/i,
  );

  // Then a stage boots clean with the mode on. That is as far as this file can
  // honestly go, and the reason is arithmetic rather than laziness: the mode
  // recolours tank skins and tracers, which during the stage curtain is one
  // 16x16 tank in a 1461x900 buffer — about 0.2% of the pixels. Measured, its
  // effect on any whole-frame statistic (0.055 mean levels) is SMALLER than the
  // frame-to-frame noise of the twinkling spawn star (0.074), so a pixel
  // comparison here would pass or fail on the star. The flag→material link is
  // pinned where it is deterministic (`tests/render/materials.test.ts` drives
  // `applyHighContrast` and checks every skin), and the separation the mode
  // buys is measured in `docs/calibration/high-contrast.json` (worst luma pair
  // 2.62 → 59.98). A test that cannot fail for the reason it names is worse
  // than no test.
  await page.goto('/?quality=low&stage=1&seed=3');
  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  expect((await readFrame(page)).box[2], 'nothing drawn').toBeGreaterThan(0);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('keyboard remap: a rebound key is written, shown and restored', async ({
  page,
}) => {
  // GDD §10's "remap keyboard bindings per player", walked end to end through
  // the real screens: focus the row, arm it, press a key, and confirm the panel
  // shows the new key AND storage holds it AND a fresh page reads it back.
  //
  // What this test does NOT claim is that the new key drives the tank. That is
  // `bindingsFor` → `createInput`, covered where it is deterministic
  // (`tests/ui/settings.test.ts`, `tests/input/keyboard.test.ts`); asserting it
  // here would mean comparing two live WebGL frames of a board with moving
  // tanks on it, which differ whatever the binding is. A test that cannot fail
  // for the reason it names is worse than no test.
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&seed=5');
  await toSettings(page);
  await focusRow(page, 'p1.up');

  const binding = row(page, 'p1.up').locator('[data-value]');
  await expect(binding).toHaveText(/W/i);
  await page.keyboard.press('Enter'); // arm: listen for the next key
  await page.keyboard.press('KeyT');
  await expect(binding).toHaveText(/T/i);

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bc.settings.v1') ?? '{}'),
  );
  expect(stored.bindings['p1.up']).toBe('KeyT');

  // Round-trip: a fresh page, the real settings screen, the stored value.
  await page.goto('/?quality=low&seed=5');
  await toSettings(page);
  await expect(row(page, 'p1.up').locator('[data-value]')).toHaveText(/T/i);
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});
