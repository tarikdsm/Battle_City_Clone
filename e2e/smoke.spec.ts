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
  expect(sawBootOk, 'expected "boot ok" in the console').toBe(true);
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('plays: scripted keys drive a live stage with a live HUD', async ({
  page,
}) => {
  // ~13 s of real playing, plus boot. The default 30 s is not enough headroom.
  test.setTimeout(90_000);

  const consoleErrors = watchErrors(page);

  // `?quality=high` pins the preset so the run does not change chains a second
  // in (the auto probe now samples a DRAWING frame — see main.ts), and `?seed=`
  // makes the enemy AI and the power-up rolls the same run every time.
  await page.goto('/?quality=high&seed=20260802');

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
  await page.keyboard.press('Escape');
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
  await page.keyboard.press('Escape');
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
