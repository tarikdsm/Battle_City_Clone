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

/**
 * Signatures of a GPU/driver failure rather than an application one.
 *
 * T8.3 reported a one-off boot-smoke failure on "expected no console/page
 * errors", immediately after a headed capture session had been driving the same
 * dev server, and the message was gone before it could be read. T10 reproduced
 * it exactly once — after fifteen consecutive headed captures — and never in
 * eight isolated runs, five back-to-back boot runs, or a run following a single
 * capture. That pattern is GPU/context pressure from concurrent headed
 * browsers, which is also what `playwright.config.ts` already pins `workers: 1`
 * for: at four workers this suite produced 26 `VALIDATE_STATUS false` shader
 * errors in one boot, the signature of a lost context.
 *
 * These strings do NOT suppress anything — the assertion still demands an empty
 * list, because a real shader bug looks the same from here and must not be
 * excused. They only make the failure message say which of the two it looks
 * like, so the next person does not spend an hour rediscovering it.
 */
const GPU_ERROR_SIGNATURES = [
  'VALIDATE_STATUS',
  'WebGLProgram',
  'Shader Error',
  'CONTEXT_LOST',
  'context lost',
  'Failed to create WebGL',
] as const;

function diagnose(errors: readonly string[]): string {
  if (errors.length === 0) return 'expected no console/page errors';
  const gpu = errors.filter((e) =>
    GPU_ERROR_SIGNATURES.some((sig) => e.includes(sig)),
  );
  const base = `expected no console/page errors, got ${errors.length}`;
  if (gpu.length === errors.length) {
    return (
      `${base} — and EVERY ONE is a GPU/driver signature. This is very likely ` +
      'the environmental flake documented above (headed captures competing ' +
      'for the same GPU), not an application fault. Re-run this file alone ' +
      'with nothing else driving a browser before treating it as a defect.'
    );
  }
  return `${base} (${gpu.length} GPU-shaped, ${errors.length - gpu.length} not)`;
}
const screen = (page: Page, name: string) =>
  page.locator(`[data-screen="${name}"]`);

/**
 * Since T6.1 the game opens on GDD §5's title screen. `?stage=` is the dev-only
 * flag that boots straight onto the board (`main.ts`), which is what the tests
 * about the *board* want; the flow tests walk the real path instead.
 */
const AUTOSTART = '&stage=1';

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
  expect(consoleErrors, diagnose(consoleErrors)).toEqual([]);
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

/**
 * The portrait half of the docking contract (T9.2).
 *
 * `reframes` above asserts the LANDSCAPE contract — HUD on the right, canvas
 * keeps the full height — and that contract is false in portrait *by design*
 * (art §10 docks the bar along the top and gives the bottom to the touch
 * controls). So portrait needs its own row rather than a widened assertion, and
 * without one the entire mobile layout was untested.
 */
test('reframes (portrait): the HUD docks top and the board starts below it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const consoleErrors = watchErrors(page);

  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`/?quality=low&seed=20260802${AUTOSTART}`);
  await expect(hud(page, 'root')).toBeVisible();
  await page.waitForTimeout(1200);

  const boxes = await page.evaluate(() => {
    const c = (
      document.querySelector('canvas#game') as HTMLCanvasElement
    ).getBoundingClientRect();
    const h = (
      document.querySelector('[data-hud="root"]') as HTMLElement
    ).getBoundingClientRect();
    return {
      canvas: { top: c.top, left: c.left, w: c.width, h: c.height },
      hud: { top: h.top, h: h.height, w: h.width },
      overlap:
        Math.max(0, Math.min(c.right, h.right) - Math.max(c.left, h.left)) *
        Math.max(0, Math.min(c.bottom, h.bottom) - Math.max(c.top, h.top)),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  expect(boxes.overlap, 'HUD overlaps the board in portrait').toBe(0);
  // The bar is along the top, full width…
  expect(boxes.hud.top).toBe(0);
  expect(Math.round(boxes.hud.w)).toBe(boxes.viewport.w);
  // …and the board really starts below it, rather than being hidden behind it.
  // `index.html` pins the canvas at top:0; the play screen's `fit` is the only
  // thing that ever moves it, so a regression there shows up right here.
  expect(Math.round(boxes.canvas.top)).toBe(Math.ceil(boxes.hud.h));
  expect(Math.round(boxes.canvas.top + boxes.canvas.h)).toBe(boxes.viewport.h);
  expect(Math.round(boxes.canvas.w)).toBe(boxes.viewport.w);

  expect(consoleErrors, 'expected no console/page errors').toEqual([]);
});

/**
 * The touch overlay (T9.2), on an emulated touch device.
 *
 * Emulated, and the T9 report says so: this proves the gate, the reserved box
 * and the event path, not that a thumb on real glass feels right.
 */
test.describe('touch controls', () => {
  test.use({ viewport: { width: 400, height: 820 }, hasTouch: true });

  test('mount only on touch devices, and never over the board', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const consoleErrors = watchErrors(page);

    await page.goto(`/?quality=low&seed=20260802${AUTOSTART}`);
    await expect(hud(page, 'root')).toBeVisible();
    await page.waitForTimeout(1500);

    await expect(page.locator('[data-touch="zone-main"]')).toBeVisible();
    await expect(page.locator('[data-touch="stick"]')).toBeVisible();
    await expect(page.locator('[data-touch="fire"]')).toBeVisible();

    // The whole claim of the layout, as a number: every reserved control box
    // and the board are disjoint, so no thumb can rest on the playfield.
    const geometry = await page.evaluate(() => {
      // A hidden element still answers `getBoundingClientRect` — with a zero
      // rect — so "absent" has to mean zero AREA, not a missing node.
      const r = (sel: string): DOMRect | null => {
        const box = document.querySelector(sel)?.getBoundingClientRect();
        return box === undefined || box.width * box.height === 0 ? null : box;
      };
      const over = (a: DOMRect | null, b: DOMRect | null): number =>
        a === null || b === null
          ? 0
          : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const c = r('canvas#game') as DOMRect;
      const main = r('[data-touch="zone-main"]') as DOMRect;
      const aux = r('[data-touch="zone-aux"]');
      const h = r('[data-hud="root"]');
      return {
        canvasMain: over(c, main),
        canvasAux: over(c, aux),
        canvasHud: over(c, h),
        mainBottom: Math.round(main.bottom),
        mainTop: Math.round(main.top),
        canvasBottom: Math.round(c.bottom),
        viewportH: window.innerHeight,
        fire: (r('[data-touch="fire"]') as DOMRect).width,
        hasAux: aux !== null,
      };
    });
    expect(geometry.canvasMain, 'controls overlap the board').toBe(0);
    expect(geometry.canvasAux, 'controls overlap the board').toBe(0);
    expect(geometry.canvasHud, 'HUD overlaps the board').toBe(0);
    // Portrait viewport, so this is the bottom strip: it reaches the bottom of
    // the screen and the board stops exactly where it starts.
    expect(geometry.hasAux).toBe(false);
    expect(geometry.mainBottom).toBe(geometry.viewportH);
    expect(geometry.canvasBottom).toBe(geometry.mainTop);
    // A fire button smaller than a thumb is a fire button that does not work.
    expect(geometry.fire).toBeGreaterThanOrEqual(44);

    // GDD §7's touch row for pause is an on-screen icon, and it reaches the
    // same core pause edge a key does.
    await page.locator('[data-touch="pause"]').tap();
    await expect(screen(page, 'pause')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-item="resume"]').tap();
    await expect(screen(page, 'pause')).toHaveCount(0);

    expect(consoleErrors, 'expected no console/page errors').toEqual([]);
  });

  test('landscape puts the controls in columns beside the board', async ({
    page,
  }) => {
    // The T9 follow-up. A bottom strip in landscape came straight off a board
    // that is bound by height: 12.8 CSS px per tile, at which five tank
    // silhouettes are not tellable apart. The columns take space the square
    // board could never have used, so they cost nothing.
    test.setTimeout(60_000);
    const consoleErrors = watchErrors(page);

    await page.setViewportSize({ width: 802, height: 294 });
    await page.goto(`/?quality=low&seed=20260802${AUTOSTART}`);
    await expect(hud(page, 'root')).toBeVisible();
    await page.waitForTimeout(1500);

    const geometry = await page.evaluate(() => {
      // A hidden element still answers `getBoundingClientRect` — with a zero
      // rect — so "absent" has to mean zero AREA, not a missing node.
      const r = (sel: string): DOMRect | null => {
        const box = document.querySelector(sel)?.getBoundingClientRect();
        return box === undefined || box.width * box.height === 0 ? null : box;
      };
      const over = (a: DOMRect | null, b: DOMRect | null): number =>
        a === null || b === null
          ? 0
          : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const c = r('canvas#game') as DOMRect;
      const main = r('[data-touch="zone-main"]') as DOMRect;
      const aux = r('[data-touch="zone-aux"]') as DOMRect | null;
      const h = r('[data-hud="root"]');
      return {
        canvas: { left: c.left, right: c.right, w: c.width, h: c.height },
        main: { left: main.left, right: main.right, w: main.width },
        aux:
          aux === null
            ? null
            : { left: aux.left, right: aux.right, w: aux.width },
        canvasMain: over(c, main),
        canvasAux: over(c, aux),
        canvasHud: over(c, h),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    });

    // Two columns, not a strip.
    expect(geometry.aux, 'landscape should use two columns').not.toBeNull();
    expect(geometry.canvasMain, 'left column overlaps the board').toBe(0);
    expect(geometry.canvasAux, 'right column overlaps the board').toBe(0);
    expect(geometry.canvasHud, 'HUD overlaps the board').toBe(0);

    // Left column, then the board, then the right column, then the HUD.
    expect(Math.round(geometry.main.left)).toBe(0);
    expect(Math.round(geometry.canvas.left)).toBe(
      Math.round(geometry.main.right),
    );
    expect(Math.round(geometry.canvas.right)).toBe(
      Math.round(geometry.aux?.left ?? -1),
    );

    // …and the board keeps the FULL height, which is the point: a strip would
    // have taken 116 px of 294 off the one axis that binds.
    expect(Math.round(geometry.canvas.h)).toBe(geometry.viewport.h);

    expect(consoleErrors, 'expected no console/page errors').toEqual([]);
  });

  test('a tap on the title does not fall through to the menu', async ({
    page,
  }) => {
    // The regression this exists for: the title started on `pointerdown`, so
    // one tap mounted the menu under a finger that had not lifted and the
    // `click` that followed activated whatever row was at those coordinates —
    // the centre of the screen, which is Construction. Tapping "press any key"
    // opened the level editor.
    test.setTimeout(60_000);
    await page.goto('/?quality=low&seed=20260802');
    await expect(screen(page, 'title')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-screen="title"]').tap();
    await expect(screen(page, 'menu')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).not.toContain('#editor');
  });
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
  // An instantaneous press: the sub-tick latch is what makes this reliable.
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
  // Every row is live as of T10's follow-up: the Neo campaign was a disabled
  // placeholder for two phases while twelve authored stages sat unreachable in
  // `src/levels/neo/`. `e2e/flows.spec.ts` walks that campaign; here it is
  // enough that nothing on this menu is a dead end any more.
  for (const id of ['players', 'campaign', 'neo', 'construction', 'custom']) {
    await expect(page.locator(`[data-item="${id}"]`)).not.toHaveClass(
      /is-disabled/,
    );
  }
  // The menu opens on T10's `players` row, so Campaign is one step down. Walked
  // rather than counted, so another row above it cannot silently retarget this.
  for (let i = 0; i < 8; i++) {
    const cls =
      (await page.locator('[data-item="campaign"]').getAttribute('class')) ??
      '';
    if (cls.includes('is-focused')) break;
    await page.keyboard.press('ArrowDown');
  }
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
  // Both instantaneous. These two presses are the end-to-end guard for T6.3's
  // press latch: without it they land inside a tick and vanish.
  await page.keyboard.press('Escape');
  await expect(screen(page, 'pause')).toBeVisible();
  await page.keyboard.press('Escape'); // resumes from the pause menu
  await expect(screen(page, 'pause')).toHaveCount(0);

  // --- death ---------------------------------------------------------------
  // Deterministic, and it uses a rule rather than luck: fidelity §5.2 says a
  // PLAYER's bullet destroys the eagle. P1 spawns at tile (4,12) and the eagle
  // sits at (6,12) on the same row, behind the stamped brick ring — so facing
  // right and holding fire brings the run down on the player's own shot.
  //
  // "Face right" is re-pressed on a beat rather than once, because a respawn
  // resets the tank to facing up. That was free on T3.2's provisional stage 1;
  // it is not on the transcribed one (T7.1), whose brick columns sit on the ODD
  // tiles and leave column 4 — the one P1 spawns in — open from the top of the
  // field to the player. A tank that wanders into it has a clean shot down, and
  // a P1 that came back facing up would then fire at the sky until the timeout.
  // Re-aiming keeps the mechanism the comment above describes, whether the run
  // ends on the first life or the third.
  const gameOver = screen(page, 'gameOver');
  await page.keyboard.down('KeyJ');
  for (let beat = 0; beat < 60 && (await gameOver.count()) === 0; beat++) {
    await page.keyboard.press('KeyD');
    await page.waitForTimeout(500);
  }
  await expect(gameOver).toBeVisible({ timeout: 30_000 });
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
