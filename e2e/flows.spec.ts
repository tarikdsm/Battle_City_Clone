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

test('2P: a scripted two-player run — both spawn, both score, it ends', async ({
  page,
}) => {
  test.setTimeout(400_000);
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

  // And the run is live for BOTH of them. Both fire keys held, both stationary
  // — the same reasoning as the Neo tests: fidelity §9 weights enemies toward
  // the base, and P1 and P2 spawn either side of it on row 12, so each has a
  // lane of its own. Scoring separately is the thing that proves two players
  // rather than one player with a second HUD column (GDD §8).
  await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.down('KeyJ'); // P1 fire
  await page.keyboard.down('Numpad0'); // P2 fire
  const gameOver = screen(page, 'gameOver');
  let p1 = 0;
  let p2 = 0;
  const until = Date.now() + 120_000;
  while (Date.now() < until && (p1 === 0 || p2 === 0)) {
    if ((await gameOver.count()) > 0) break;
    p1 = Number(
      (await hud(page, 'p1-score')
        .textContent()
        .catch(() => '0')) ?? 0,
    );
    p2 = Number(
      (await hud(page, 'p2-score')
        .textContent()
        .catch(() => '0')) ?? 0,
    );
    await page.waitForTimeout(500);
  }
  await page.keyboard.up('KeyJ');
  await page.keyboard.up('Numpad0');
  expect(p1, 'P1 never scored').toBeGreaterThan(0);
  expect(p2, 'P2 never scored').toBeGreaterThan(0);

  // And it ENDS — one shared enemy pool eventually takes the base or the lives,
  // and a 2P run that could not reach game over would strand the player.
  await expect(gameOver).toBeVisible({ timeout: 180_000 });
  await page.keyboard.press('Enter');
  await expect(
    screen(page, 'hiScoreEntry').or(screen(page, 'hiScore')).first(),
  ).toBeVisible({ timeout: 20_000 });

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

// --- the Neo campaign ------------------------------------------------------
//
// These two exist because the campaign was authored in T8.3 and reachable by
// nobody until T10's follow-up: twelve validated, completability-checked stages
// that no player could open, and a full unit suite that never noticed because
// nothing asked. So both tests below are about REACHABILITY, walked with the
// keyboard through the real menu.
//
// `?enemies=1` (dev-only) shortens the wave to one tank. It is a CONTENT knob,
// not a rules knob — `withDebugEnemies` truncates `LevelData.enemies` before
// `createGame` sees it, so the cadence, the cap, the carrier ordinals and the
// stage-clear rule are all untouched. Without it a stage clear is twenty kills
// away, which is not a thing an e2e suite can walk to.

/**
 * Clear a one-enemy stage by holding fire and standing still.
 *
 * Not a shortcut — it is the script `scripts/capture-campaign.ts` established
 * for exactly this job, and the reasoning is the AI's: fidelity §9 weights
 * enemies toward the base, so they come down into a stationary player's lane.
 * A player who also moves has an outcome that compounds with the AI's own
 * decisions, which is how the first version of these tests failed to kill a
 * single tank in 150 seconds of wandering.
 *
 * Still a real game against a real AI, so the callers retry across seeds rather
 * than assume one attempt lands.
 */
async function holdFireUntilCleared(
  page: Page,
  budgetMs: number,
): Promise<boolean> {
  const tally = screen(page, 'tally');
  await page.keyboard.down('KeyJ');
  // The tally's own key handler is attached during its `enter`, which happens a
  // frame after the screen mounts. Pressing Enter the instant `tally` appears
  // lands before that and does nothing at all — the run then sits on the tally
  // for ever and the failure reads as "the next stage never started", which is
  // a good hour's worth of looking in the wrong file. Callers settle first.
  try {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if ((await tally.count()) > 0) return true;
      await page.waitForTimeout(500);
    }
    return (await tally.count()) > 0;
  } finally {
    await page.keyboard.up('KeyJ');
  }
}

test('neo campaign: menu -> its own stage select -> clear neo-01 -> neo-02', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = watchErrors(page);
  // `main.ts` logs the layout it actually served on every stage start, in dev
  // builds. That line is the decisive assertion here: a HUD reading "2" proves
  // only that a second stage began, not that it was neo-02 rather than the
  // ORIGINAL stage 2 — which is exactly the confusion this feature could ship.
  const stageLog: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('stage ')) stageLog.push(msg.text());
  });

  // Seeds chosen, not arbitrary: swept for ones whose stationary hold-fire run
  // actually kills the single tank inside a minute. It is a real game against a
  // real AI, so three are kept rather than one.
  let cleared = false;
  for (const seed of [33, 37, 44]) {
    stageLog.length = 0;
    await page.goto(`/?quality=low&enemies=1&seed=${seed}`);
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.goto(`/?quality=low&enemies=1&seed=${seed}`);
    await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Enter');
    await expect(screen(page, 'menu')).toBeVisible();

    // The row that was disabled for two phases.
    await focusMenuRow(page, 'neo');
    await expect(row(page, 'neo')).not.toHaveClass(/is-disabled/);
    await page.keyboard.press('Enter');

    // Its OWN stage select: twelve cells, not thirty-five, and its own progress.
    const select = screen(page, 'stageSelect');
    await expect(select).toBeVisible();
    await expect(select).toHaveAttribute('data-campaign', 'neo');
    await expect(
      page.locator('[data-screen="stageSelect"] [data-stage]'),
    ).toHaveCount(12);
    await page.keyboard.press('Enter'); // the furthest unlocked Neo stage (1)

    await expect(hud(page, 'root')).toBeVisible({ timeout: 45_000 });
    await expect(hud(page, 'stage')).toHaveText('1');
    await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });
    expect(stageLog[0], 'first stage served').toContain('neo-01');
    expect(stageLog[0]).toContain('(neo, counter 1)');

    cleared = await holdFireUntilCleared(page, 60_000);
    if (cleared) break;
  }
  expect(cleared, 'never cleared neo-01 on any of the three seeds').toBe(true);
  await expect(screen(page, 'tally')).toBeVisible();

  // And on into the second stage of the SAME campaign.
  await page.waitForTimeout(2000); // let the tally attach its nav
  await page.keyboard.press('Enter');
  await expect(hud(page, 'stage')).toHaveText('2', { timeout: 45_000 });
  expect(stageLog.at(-1), 'second stage served').toContain('neo-02');
  expect(stageLog.at(-1)).toContain('(neo, counter 2)');

  // Progress is recorded in the Neo campaign's own field, and the originals'
  // unlock list is untouched — one save field for two campaigns would hand the
  // player original stage 2 for a Neo clear.
  const save = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('bc.save.v1') ?? '{}'),
  );
  expect(save.highestNeoStage).toBe(2);
  expect(save.highestStage).toBe(1);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

test('neo campaign: clearing the twelfth stage ends the run, never loops', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const consoleErrors = watchErrors(page);
  const stageLog: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('stage ')) stageLog.push(msg.text());
  });

  // Swept the same way as the test above; neo-12 is the more cooperative of the
  // two, which is convenient because it is the one that proves the ending.
  let cleared = false;
  for (const seed of [33, 35, 36]) {
    stageLog.length = 0;
    await page.goto(`/?quality=low&enemies=1&seed=${seed}`);
    // Unlock the whole Neo campaign so the last stage is one keypress away.
    // Save data, not a rule: the ENDING is what is under test, and playing
    // eleven stages to reach it is not something a suite can walk.
    await page.evaluate(() => {
      localStorage.setItem(
        'bc.save.v1',
        JSON.stringify({ highestStage: 1, highestNeoStage: 12 }),
      );
    });
    await page.goto(`/?quality=low&enemies=1&seed=${seed}`);

    await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Enter');
    await expect(screen(page, 'menu')).toBeVisible();
    await focusMenuRow(page, 'neo');
    await page.keyboard.press('Enter');
    // The grid opens on the furthest stage reached, which is now the twelfth.
    await expect(screen(page, 'stageSelect')).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(hud(page, 'root')).toBeVisible({ timeout: 45_000 });
    await expect(hud(page, 'stage')).toHaveText('12');
    expect(stageLog.at(-1)).toContain('neo-12');
    await expect(screen(page, 'intro')).toHaveCount(0, { timeout: 15_000 });

    cleared = await holdFireUntilCleared(page, 60_000);
    if (cleared) break;
  }
  expect(cleared, 'never cleared neo-12 on any of the three seeds').toBe(true);
  await page.waitForTimeout(2000); // let the tally attach its nav
  await page.keyboard.press('Enter');

  // The rule: a finished Neo run goes to fidelity §13's post-run path, NOT into
  // a thirteenth stage and NOT into the originals' stage 1. Either of those
  // would mount the HUD again, so "no HUD" is the strong form of it.
  const entry = screen(page, 'hiScoreEntry');
  const table = screen(page, 'hiScore');
  await expect(entry.or(table).first()).toBeVisible({ timeout: 30_000 });
  await expect(hud(page, 'root')).toHaveCount(0);
  expect(
    stageLog.filter((l) => l.includes('counter 13')),
    'a thirteenth Neo stage was started',
  ).toEqual([]);
  expect(
    stageLog.filter((l) => l.includes('stage01')),
    'the run looped into the original campaign',
  ).toEqual([]);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});
