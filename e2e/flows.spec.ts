// e2e/flows.spec.ts — the player-facing journeys T10 was asked to prove (GDD §5).
//
// `smoke.spec.ts` already walks title → play → death → game over → title. These
// are the four it does not: starting a two-player run, pausing one, taking a
// stage from the editor out through a share code and back in to play it, and
// the high-score fork at the end of a run.
//
// The two-player test is the reason this file exists at all. GDD §1 ships a 2P
// mode and every layer has carried it since T1.7, but until T10 the only way to
// reach one was a dev-only URL flag that a production build makes inert — so
// there was nothing to write this test against, and its absence is exactly what
// let that go unnoticed for four phases.
import { expect, test, type Page } from '@playwright/test';

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

/** Move the menu cursor onto `id`. Robust to rows being added above it. */
async function focusMenuRow(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 16; i++) {
    const cls = (await row(page, id).getAttribute('class')) ?? '';
    if (cls.includes('is-focused')) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`could not focus menu row ${id}`);
}

test('2P: the menu starts a two-player run with two live HUD columns', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&seed=11');

  await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(screen(page, 'menu')).toBeVisible();

  // The player-count row (T10). One press right is the whole 2P entry point.
  await focusMenuRow(page, 'players');
  const players = row(page, 'players').locator('[data-value]');
  await expect(players).toHaveText(/1 player/i);
  await page.keyboard.press('ArrowRight');
  await expect(players).toHaveText(/2 players/i);

  await focusMenuRow(page, 'campaign');
  await page.keyboard.press('Enter');
  await expect(screen(page, 'stageSelect')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });
  // GDD §8: separate scores and separate lives. Both columns must be MOUNTED —
  // a 1P run shows only P1 — and both must show the starting three lives.
  await expect(hud(page, 'p1')).toBeVisible();
  await expect(hud(page, 'p2')).toBeVisible();
  await expect(hud(page, 'p1-lives')).toHaveText('3');
  await expect(hud(page, 'p2-lives')).toHaveText('3');
  await expect(hud(page, 'p1-score')).toHaveText('0');
  await expect(hud(page, 'p2-score')).toHaveText('0');

  // And the run is live for both: play a beat and make sure nothing throws.
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ArrowUp');

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('pause freezes the simulation and resume lets it go again (P-26)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&stage=1&seed=13');
  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });

  // Let the board fill so there is something that would move if it could.
  await page.waitForTimeout(2500);
  const before = await hud(page, 'enemies-left').textContent();

  await page.keyboard.press('Escape');
  await expect(screen(page, 'pause')).toBeVisible();

  // Fidelity §15's P-26 is "pause freezes ALL simulation timers", so the strong
  // check is not that the HUD is unchanged — it is that the drawn frame is
  // unchanged, which covers the spawn animation, the carrier flash and the
  // twinkling star as well as the tank positions.
  const first = await page.locator('canvas#game').screenshot();
  await page.waitForTimeout(2000);
  const second = await page.locator('canvas#game').screenshot();
  expect(Buffer.compare(first, second), 'the board changed while paused').toBe(
    0,
  );
  expect(await hud(page, 'enemies-left').textContent()).toBe(before);

  await page.keyboard.press('Escape');
  await expect(screen(page, 'pause')).toHaveCount(0);

  // Resumed: the same comparison must now FAIL to be equal. Without this half
  // the test would pass just as happily on a game that had stopped for good.
  const resumedA = await page.locator('canvas#game').screenshot();
  await page.waitForTimeout(1200);
  const resumedB = await page.locator('canvas#game').screenshot();
  expect(
    Buffer.compare(resumedA, resumedB),
    'the board did not move after resuming',
  ).not.toBe(0);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('editor: build → share code → import it back → play it', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&seed=17#editor');
  await expect(screen(page, 'editor')).toBeVisible({ timeout: 45_000 });

  // Paint something, so the code carries a stage that is this run's and not the
  // blank default: four brick strokes on the field grid.
  const field = page.locator('[data-role="field"]');
  await expect(field).toBeVisible();
  const box = await field.boundingBox();
  if (box === null) throw new Error('editor field has no box');
  for (const [fx, fy] of [
    [0.3, 0.3],
    [0.4, 0.3],
    [0.3, 0.4],
    [0.6, 0.6],
  ] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  }

  await page.locator('[data-action="sharecode"]').click();
  const code = await page.locator('[data-field="share-code"]').inputValue();
  expect(code, 'no share code produced').toMatch(/^BC1\./);

  // Round-trip it through the import field of a FRESH editor, which is the
  // path a second player takes when a code arrives in a chat window.
  await page.goto('/?quality=low&seed=17');
  await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
  await page.goto('/?quality=low&seed=17#editor');
  await expect(screen(page, 'editor')).toBeVisible({ timeout: 45_000 });

  await page.locator('[data-field="import"]').fill(code);
  await page.locator('[data-action="import"]').click();
  await expect(page.locator('[data-role="status"]')).toContainText(/imported/i);
  await expect(page.locator('[data-role="errors"]')).toBeEmpty();

  // Re-encoding the imported stage must give the same code back. That is what
  // makes this a round-trip rather than "an import happened".
  await page.locator('[data-action="sharecode"]').click();
  expect(await page.locator('[data-field="share-code"]').inputValue()).toBe(
    code,
  );

  // And it plays.
  await page.locator('[data-action="testplay"]').click();
  await expect(hud(page, 'root')).toBeVisible({ timeout: 45_000 });
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.down('KeyJ');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyJ');

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('game over takes the high-score fork the score earned (fidelity §13)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors = watchErrors(page);
  await page.goto('/?quality=low&stage=1&seed=19');
  await expect(hud(page, 'root')).toBeVisible({ timeout: 30_000 });
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });

  // The table starts empty, so §13's rule reduces to "score > 0 qualifies"
  // (`session.ts: qualifies` — a zero never does, even into an empty table).
  await page.evaluate(() => localStorage.removeItem('bc.scores.v1'));

  // Same deterministic ending as the smoke test: P1 and the eagle share row 12,
  // so facing right and holding fire brings the run down on the player's shot.
  // The score has to be sampled WHILE the board is up: the game-over screen
  // unmounts the HUD, so reading it afterwards reads nothing. Polled on the
  // same beat as the input, which costs nothing and is the only moment it is
  // observable.
  const gameOver = screen(page, 'gameOver');
  let scored = 0;
  await page.keyboard.down('KeyJ');
  for (let beat = 0; beat < 70 && (await gameOver.count()) === 0; beat++) {
    await page.keyboard.press('KeyD');
    await page.waitForTimeout(500);
    const text = await hud(page, 'p1-score')
      .textContent({ timeout: 1000 })
      .catch(() => null);
    if (text !== null) scored = Number(text);
  }
  await page.keyboard.up('KeyJ');
  await expect(gameOver).toBeVisible({ timeout: 30_000 });

  // The branch below is asserted against what the run actually earned rather
  // than against whichever screen turned up. That is the half the smoke test's
  // `entry.or(table)` cannot do.
  await page.keyboard.press('Enter');

  const entry = screen(page, 'hiScoreEntry');
  const table = screen(page, 'hiScore');
  if (scored > 0) {
    await expect(entry, `scored ${scored} — §13 wants initials`).toBeVisible({
      timeout: 15_000,
    });
    // Three columns of initials, then the table, then the name is in it.
    await page.keyboard.press('ArrowUp'); // A → B, so the entry is identifiable
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(table).toBeVisible();
    await expect(page.locator('[data-rank="1"]')).toContainText(String(scored));
  } else {
    await expect(
      table,
      'scored nothing — §13 goes straight to the table',
    ).toBeVisible({ timeout: 15_000 });
  }

  await expect(page.locator('[data-role="scores"] tr')).not.toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(screen(page, 'title')).toBeVisible();
  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});
