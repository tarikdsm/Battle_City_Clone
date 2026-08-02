import { expect, test, type Page } from '@playwright/test';

/** Collects every console/page error for the life of the page. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

const hud = (page: Page, name: string) => page.locator(`[data-hud="${name}"]`);
const screen = (page: Page, name: string) =>
  page.locator(`[data-screen="${name}"]`);

/**
 * Since T6.1 the game opens on GDD §5's title screen. `?stage=` is the dev-only
 * flag that boots straight onto the board (`main.ts`), which is what the tests
 * about the *board* want; the flow tests walk the real path instead.
 */
const AUTOSTART = '&stage=1';

/**
 * A key press aimed at the **simulation**, held for a realistic 90 ms.
 *
 * Menus listen to `keydown`, so an instantaneous `press()` reaches them. The
 * input layer does not: `keyboard.poll()` samples the held set once per 60 Hz
 * tick, so a synthetic down+up that lands inside one 16.7 ms tick is never
 * observed. A human cannot press that fast; Playwright can.
 */
async function gameKey(page: Page, code: string, holdMs = 90): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(code);
}

test('boots: title, canvas, "boot ok", no console errors', async ({ page }) => {
  const consoleErrors = watchErrors(page);
  let sawBootOk = false;
  page.on('console', (msg) => {
    if (msg.text().includes('boot ok')) {
      sawBootOk = true;
    }
  });

  await page.goto('/');

  await expect(page).toHaveTitle('Battle City');
  await expect(page.locator('canvas#game')).toHaveCount(1);
  // Screens really mount on #ui: if main.ts silently fell back to <body>
  // (missing or renamed #ui), this element would still be empty after boot.
  await expect(page.locator('#ui')).not.toBeEmpty();
  // GDD §5: boot lands on the title, over a live attract board.
  await expect(screen(page, 'title')).toBeVisible();
  expect(sawBootOk, 'expected "boot ok" in the console').toBe(true);
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('reframes: a resize re-fits the board area and keeps the HUD docked', async ({
  page,
}) => {
  // The guard for a class of bug that cost a Gate G2 round: a board that frames
  // correctly on a fresh load but not after a resize. The reported instance
  // turned out to be an artifact of the reviewer's viewer rather than a defect
  // — the same sequence in real Chromium renders correctly — but the failure
  // mode is real enough to be worth a permanent test, and a fresh-load-only
  // suite structurally cannot see it.
  //
  // Scope note: this asserts the LAYOUT contract, which is all a Playwright
  // test can reach — the canvas has no `preserveDrawingBuffer`, so pixels are
  // not readable after presentation. The pixel-level assertion (board fill
  // fraction after a resize must match a fresh load at the same size, ±0.01)
  // lives in `npm run capture:play`, rows 6–8, which reads back inside the
  // frame and is mutation-checked.
  test.setTimeout(60_000);
  const consoleErrors = watchErrors(page);

  const box = async (): Promise<{
    canvas: { x: number; y: number; w: number; h: number };
    hud: { x: number; y: number; w: number; h: number };
    overlap: number;
    viewport: { w: number; h: number };
  }> =>
    page.evaluate(() => {
      const c = (
        document.querySelector('canvas#game') as HTMLCanvasElement
      ).getBoundingClientRect();
      const h = (
        document.querySelector('[data-hud="root"]') as HTMLElement
      ).getBoundingClientRect();
      return {
        canvas: { x: c.left, y: c.top, w: c.width, h: c.height },
        hud: { x: h.left, y: h.top, w: h.width, h: h.height },
        overlap:
          Math.max(0, Math.min(c.right, h.right) - Math.max(c.left, h.left)) *
          Math.max(0, Math.min(c.bottom, h.bottom) - Math.max(c.top, h.top)),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    });

  await page.setViewportSize({ width: 640, height: 460 });
  await page.goto(`/?quality=low&seed=20260802${AUTOSTART}`);
  await expect(hud(page, 'root')).toBeVisible();
  await page.waitForTimeout(1200);

  const small = await box();
  expect(small.overlap, 'HUD overlaps the board at 640x460').toBe(0);
  // The canvas takes the viewport minus whatever the HUD docks — landscape here,
  // so the dock is on the right and the canvas keeps the full height.
  expect(Math.round(small.canvas.w + small.hud.w)).toBe(small.viewport.w);
  expect(Math.round(small.canvas.h)).toBe(small.viewport.h);

  // …and again after a resize, which is the path a fresh load never exercises.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1200);

  const large = await box();
  expect(large.overlap, 'HUD overlaps the board after the resize').toBe(0);
  expect(Math.round(large.canvas.w + large.hud.w)).toBe(large.viewport.w);
  expect(Math.round(large.canvas.h)).toBe(large.viewport.h);
  // The canvas really did grow — a stale fit would leave it at the old size
  // while the HUD moved to the new right edge, which is how the phantom looked.
  expect(large.canvas.w).toBeGreaterThan(small.canvas.w);
  expect(large.canvas.h).toBeGreaterThan(small.canvas.h);

  // Still drawing after the reframe.
  const canvas = page.locator('canvas#game');
  const before = await canvas.screenshot();
  await page.waitForTimeout(600);
  expect(
    Buffer.compare(before, await canvas.screenshot()),
    'canvas stopped drawing after the resize',
  ).not.toBe(0);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('plays: scripted keys drive a live stage with a live HUD', async ({
  page,
}) => {
  // ~13 s of real playing, plus boot, plus five canvas screenshots that each
  // cost seconds on a shared GPU. The default 30 s is nowhere near enough.
  test.setTimeout(150_000);

  const consoleErrors = watchErrors(page);

  // `?quality=high` pins the preset so the run does not change chains a second
  // in (the auto probe now samples a DRAWING frame — see main.ts), and `?seed=`
  // makes the enemy AI and the power-up rolls the same run every time.
  await page.goto(`/?quality=high&seed=20260802${AUTOSTART}`);

  // The play screen is up when its HUD is: the boot screen has no [data-hud].
  await expect(hud(page, 'root')).toBeVisible();
  await expect(hud(page, 'stage')).toHaveText('1');
  await expect(hud(page, 'p1-lives')).toHaveText('3');
  // Not 20: fidelity §11.1 puts the first enemy spawn at t = 0, so by the time
  // the page has painted the counter is already 19. Anything below that means
  // the spawner ran away before the intro curtain even lifted.
  const enemiesAtStart = Number(await hud(page, 'enemies-left').textContent());
  expect(enemiesAtStart).toBeGreaterThanOrEqual(19);
  expect(enemiesAtStart).toBeLessThanOrEqual(20);
  // 1P: the second player's block is hidden, not shown with zero lives.
  await expect(hud(page, 'p2')).toBeHidden();

  const canvas = page.locator('canvas#game');
  const before = await canvas.screenshot();

  // Fidelity §11.1: a 2 s "STAGE N" curtain runs before control is handed over,
  // and the core feeds the systems NULL_INTENT until it lifts. Keys pressed now
  // would be swallowed, so the script waits it out first.
  await page.waitForTimeout(2500);

  // A scripted run: drive around the base, shoot, and hold fire so the input
  // layer's turbo pulse is exercised against the core's press-edge detector.
  const script: [string, number][] = [
    ['KeyW', 900],
    ['KeyJ', 700],
    ['KeyA', 600],
    ['KeyJ', 500],
    ['KeyD', 900],
    ['KeyJ', 800],
    ['KeyW', 700],
    ['KeyJ', 900],
    ['KeyS', 600],
    ['KeyD', 700],
    ['KeyJ', 1200],
    ['KeyA', 800],
    ['KeyW', 600],
    ['KeyJ', 1000],
  ];
  for (const [code, ms] of script) {
    await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
  }

  // The canvas is drawing: two shots of the same element differ. This is the
  // compositor's copy, so it works without `preserveDrawingBuffer`.
  const after = await canvas.screenshot();
  expect(Buffer.compare(before, after), 'canvas pixels never changed').not.toBe(
    0,
  );

  // The HUD moved with the simulation: the spawner has started at least a few
  // of the 20 enemies over ~13 s (stage 1, 1P: one start every 186 ticks).
  const enemiesLeft = Number(await hud(page, 'enemies-left').textContent());
  expect(enemiesLeft).toBeLessThan(enemiesAtStart);
  expect(enemiesLeft).toBeGreaterThanOrEqual(0);
  // The icon grid tracks the same number.
  await expect(page.locator('[data-hud="enemy-icons"] .spent')).toHaveCount(
    20 - enemiesLeft,
  );

  // Pause round-trip, in two halves — and BOTH halves are asserted on pixels,
  // which they could not be before T3.3.
  //
  // Half one: a paused frame is a **still** frame. The loop still hands the
  // renderer a real `dtMs` while paused (T2.1's contract, so overlays outside
  // the board can animate), but everything on the board zeroes it, so two
  // screenshots a second apart are byte-identical. Until T3.3 the tracks kept
  // scrolling and this was simply not true.
  await gameKey(page, 'Escape');
  await page.waitForTimeout(400);
  const frozenA = await canvas.screenshot();
  await page.waitForTimeout(700);
  expect(
    Buffer.compare(frozenA, await canvas.screenshot()),
    'the board kept animating while the simulation was paused',
  ).toBe(0);

  // Half two: the toggle does not wedge the loop. This is the assertion the old
  // version *meant* to make and could not: while the picture kept moving
  // through a pause, a loop that had stopped polling the pad — which is what it
  // did, so the pause was a one-way door — still looked alive.
  await gameKey(page, 'Escape');
  const resumed = await canvas.screenshot();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(800);
  await page.keyboard.up('KeyD');
  expect(
    Buffer.compare(resumed, await canvas.screenshot()),
    'the game did not resume after a pause round-trip',
  ).not.toBe(0);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('loops: title → play → death → game over → high scores → title', async ({
  page,
}) => {
  // GDD §5's whole flow, walked with the keyboard alone. This is the test that
  // makes the project a *game* rather than a stage: every transition below is a
  // real key press against the real screens, and the run really ends.
  test.setTimeout(150_000);
  const consoleErrors = watchErrors(page);

  await page.goto('/?quality=low&seed=20260802');

  // --- title ---------------------------------------------------------------
  await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Enter');

  // --- menu → stage select -------------------------------------------------
  await expect(screen(page, 'menu')).toBeVisible();
  // The Phase 8 placeholders are focusable and refuse to activate — they must
  // read as deliberate, and a broken one would strand the cursor here.
  await expect(page.locator('[data-item="neo"]')).toHaveClass(/is-disabled/);
  await page.keyboard.press('Enter'); // Campaign
  await expect(screen(page, 'stageSelect')).toBeVisible();
  await page.keyboard.press('Enter'); // the furthest unlocked stage (1)

  // --- intro → play --------------------------------------------------------
  // Generous: entering the play screen builds a WebGL context and the whole
  // post chain, which is seconds on a contended GPU — and the intro overlay is
  // only mounted once that has returned.
  await expect(screen(page, 'intro')).toBeVisible({ timeout: 30_000 });
  await expect(hud(page, 'root')).toBeVisible();
  await expect(hud(page, 'stage')).toHaveText('1');
  // Fidelity §11.1: a 2 s curtain runs before control is handed over.
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 10_000 });

  // --- pause round-trip, over a live run -----------------------------------
  await gameKey(page, 'Escape');
  await expect(screen(page, 'pause')).toBeVisible();
  await gameKey(page, 'Escape'); // core unpauses; the overlay follows
  await expect(screen(page, 'pause')).toHaveCount(0);

  // --- death ---------------------------------------------------------------
  // Deterministic, and it uses a rule rather than luck: fidelity §5.2 says a
  // PLAYER's bullet destroys the eagle. P1 spawns at tile (4,12) and the eagle
  // sits at (6,12) on the same row, behind two brick subcell-pairs — so facing
  // right and holding fire ends the run in a few seconds, every time.
  await gameKey(page, 'KeyD', 200);
  await page.keyboard.down('KeyJ');
  await expect(screen(page, 'gameOver')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.up('KeyJ');

  // --- game over → high scores → title -------------------------------------
  await page.keyboard.press('Enter');
  // Either mode is correct here: a run that scored gets the initials entry
  // (fidelity §13's "if score qualifies"), one that scored nothing goes
  // straight to the table. The loop closes the same way from both.
  const entry = screen(page, 'hiScoreEntry');
  const table = screen(page, 'hiScore');
  await expect(entry.or(table).first()).toBeVisible({ timeout: 10_000 });
  if ((await entry.count()) > 0) {
    // Three columns, then the table.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(table).toBeVisible();
  }
  await expect(page.locator('[data-role="scores"] tr')).not.toHaveCount(0);
  await page.keyboard.press('Enter');

  await expect(screen(page, 'title')).toBeVisible();
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});
