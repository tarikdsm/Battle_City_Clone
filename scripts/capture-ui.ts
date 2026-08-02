// scripts/capture-ui.ts — T6.1/T6.2's visual verification, driven by the keyboard.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:ui
//
// Outputs:
//   · `.superpowers/sdd/screens-T6/` — the screenshots (git-ignored, like every
//     other `screens/` directory in this repo; the SCRIPT is what is committed,
//     so anybody can regenerate them).
//   · `docs/calibration/high-contrast.json` — **committed**, because art §11's
//     claim ("high contrast fixes player-vs-enemy separation") is a measurement
//     and a measurement without an artifact is an opinion.
//
// ## What makes this different from the other capture scripts
//
// `capture-entities` and `capture-post` build their own render rig. This one
// touches nothing: it loads the real page and presses real keys, exactly as
// `capture-play` does for the board — because the thing under test is the
// *flow*, and a flow assembled by the harness would prove nothing about the
// flow the player walks.
//
// The one dev affordance used is `?enemies=` (see `src/app/debug.ts`), which
// shortens the wave so the stage-clear beat and the tally are reachable. It
// changes level content, never a rule.

import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PALETTE,
  TANK_SKIN_KEYS,
  HIGH_CONTRAST,
  luma601,
  tankToken,
  worstPlayerEnemySeparation,
} from '../src/render/materials';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T6');
const ARTIFACT = join('docs', 'calibration', 'high-contrast.json');

const W = 1280;
const H = 800;
/** Fixed so the AI, the spawn cycle and the power-up rolls repeat run to run. */
const SEED = 20260802;
/** Fidelity §11.1: a 2 s "STAGE N" curtain before the controls come alive. */
const INTRO_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let shotIndex = 0;
const shots: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  // Art §10's panels fade/slide in over 150 ms, and `waitFor` returns the
  // instant the node exists — so a shot taken straight after a transition
  // photographs a half-transparent panel. Settle first, always.
  await sleep(400);
  const file = `${String(shotIndex).padStart(2, '0')}-${name}.png`;
  shotIndex++;
  await page.screenshot({ path: join(OUT, file) });
  shots.push(file);
  console.log(`  → ${file}`);
}

/** The `data-screen` of whatever is on top, or `null`. */
async function currentScreen(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll<HTMLElement>('[data-screen]');
    const last = nodes[nodes.length - 1];
    return last?.dataset.screen ?? null;
  });
}

async function waitForScreen(
  page: Page,
  name: string,
  timeoutMs = 30_000,
): Promise<void> {
  await page.locator(`[data-screen="${name}"]`).waitFor({ timeout: timeoutMs });
}

/** One key press, with a beat afterwards so the 150 ms transition has settled. */
async function press(page: Page, code: string, settleMs = 320): Promise<void> {
  await page.keyboard.press(code);
  await sleep(settleMs);
}

interface Results {
  capturedAt: string;
  url: string;
  viewport: [number, number];
  /** Every screenshot written, in order. */
  screenshots: string[];
  /** The flow actually walked, screen by screen, as observed from the DOM. */
  loop: string[];
  /** Console/page errors seen over the whole session. Must stay empty. */
  consoleErrors: string[];
  highContrast: HighContrastReport;
}

interface HighContrastReport {
  /** The scale everything below is on. */
  metric: string;
  note: string;
  enemyScale: number;
  tokens: Record<
    string,
    { off: string; on: string; lumaOff: number; lumaOn: number }
  >;
  /** Every player × enemy pair, both modes. */
  pairs: {
    player: string;
    enemy: string;
    separationOff: number;
    separationOn: number;
  }[];
  worstOff: number;
  worstOn: number;
  improvementFactor: number;
  /** Art §11 quotes ~18 for this pair; reproducing it proves the scale matches. */
  docPairP1VsBasic: number;
  boardLuma: number;
  darkestEnemyLumaOn: number;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
const round = (n: number): number => +n.toFixed(2);

function measureHighContrast(): HighContrastReport {
  const players = ['player1', 'player2'] as const;
  const enemies = [
    'enemyBasic',
    'enemyFast',
    'enemyPower',
    'enemyArmor',
  ] as const;

  const tokens: HighContrastReport['tokens'] = {};
  for (const key of TANK_SKIN_KEYS) {
    const off = tankToken(key, false);
    const on = tankToken(key, true);
    tokens[key] = {
      off: hex(off),
      on: hex(on),
      lumaOff: round(luma601(off)),
      lumaOn: round(luma601(on)),
    };
  }

  const pairs: HighContrastReport['pairs'] = [];
  for (const p of players) {
    for (const e of enemies) {
      pairs.push({
        player: p,
        enemy: e,
        separationOff: round(
          Math.abs(luma601(tankToken(p, false)) - luma601(tankToken(e, false))),
        ),
        separationOn: round(
          Math.abs(luma601(tankToken(p, true)) - luma601(tankToken(e, true))),
        ),
      });
    }
  }

  const worstOff = round(worstPlayerEnemySeparation(false));
  const worstOn = round(worstPlayerEnemySeparation(true));

  return {
    metric: 'ITU-R BT.601 luma over gamma-encoded sRGB bytes, 0–255',
    note:
      'Token luma, not sampled pixels. Art §3.0 binds a fully-lit surface to ' +
      'within ±10% of its authored token, and both modes are measured the same ' +
      'way, so the SEPARATION carries across the rig unchanged. The scale is ' +
      "art §11's own: it is the only one of four common scales on which the " +
      "doc's quoted ~18 for gold-vs-gunmetal reproduces.",
    enemyScale: HIGH_CONTRAST.ENEMY_SCALE,
    tokens,
    pairs,
    worstOff,
    worstOn,
    improvementFactor: round(worstOn / worstOff),
    docPairP1VsBasic: round(
      Math.abs(luma601(PALETTE.player1) - luma601(PALETTE.enemyBasic)),
    ),
    boardLuma: round(luma601(PALETTE.board)),
    darkestEnemyLumaOn: round(
      Math.min(...enemies.map((e) => luma601(tankToken(e, true)))),
    ),
  };
}

// ---------------------------------------------------------------------------
// The walks
// ---------------------------------------------------------------------------

async function newPage(browser: Browser, results: Results): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => {
    results.consoleErrors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      results.consoleErrors.push(msg.text());
    }
  });
  return page;
}

/** Title → menu → settings (with high contrast ON) → stage select → pause. */
async function walkShell(browser: Browser, results: Results): Promise<void> {
  const page = await newPage(browser, results);
  // A clean slate, so the title's HI line and the stage grid are reproducible.
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  await page.goto(`${BASE}?quality=high&seed=${SEED}`);

  await waitForScreen(page, 'title');
  await sleep(1400); // let the attract board populate behind the logo
  results.loop.push('title');
  await shot(page, 'title');

  await press(page, 'Enter');
  await waitForScreen(page, 'menu');
  results.loop.push('menu');
  await shot(page, 'menu');

  // Down to Settings (past the three Phase 8 placeholders and High scores).
  for (let i = 0; i < 5; i++) {
    await press(page, 'ArrowDown', 120);
  }
  await shot(page, 'menu-focus-settings');
  await press(page, 'Enter');
  await waitForScreen(page, 'settings');
  results.loop.push('settings');
  await shot(page, 'settings');

  // Walk down to the high-contrast toggle and turn it on. Five presses: the
  // focusable rows are music, sound, quality, screen shake, reduce flashing,
  // high contrast — the two section labels are skipped, which is the nav
  // model's rule and worth photographing in the act.
  await page.locator('[data-item="highContrast"]').waitFor();
  for (let i = 0; i < 5; i++) {
    await press(page, 'ArrowDown', 120);
  }
  await shot(page, 'settings-high-contrast-focused');
  await press(page, 'Enter'); // toggle it on
  await sleep(300);
  await shot(page, 'settings-high-contrast-on');

  // …and one more row is the first rebindable key (the "Player 1 controls"
  // label is skipped).
  await press(page, 'ArrowDown', 120);
  await press(page, 'Enter'); // listen for a key
  await sleep(250);
  await shot(page, 'settings-rebinding');
  await press(page, 'Escape'); // cancel the rebind, not the screen

  await press(page, 'Escape');
  await waitForScreen(page, 'menu');
  // High scores, straight from the menu, with only the 20,000 seed in it.
  await press(page, 'ArrowUp', 120);
  await press(page, 'Enter');
  await waitForScreen(page, 'hiScore');
  results.loop.push('hiScore(seeded)');
  await shot(page, 'hiscore-table-seeded');
  await press(page, 'Escape');

  await waitForScreen(page, 'menu');
  await press(page, 'ArrowDown', 120); // back to Campaign
  await page.locator('[data-item="campaign"]').waitFor();
  await page.locator('[data-item="campaign"]').click();
  await waitForScreen(page, 'stageSelect');
  results.loop.push('stageSelect');
  await shot(page, 'stage-select');

  await press(page, 'Enter');
  await waitForScreen(page, 'intro');
  results.loop.push('intro');
  await shot(page, 'intro');
  await sleep(INTRO_MS + 600);
  await shot(page, 'play-high-contrast-on');

  await press(page, 'Escape', 500);
  await waitForScreen(page, 'pause');
  results.loop.push('pause');
  await shot(page, 'pause');

  // Pause → settings: the same live, frozen board behind a settings panel, which
  // is what makes the high-contrast toggle previewable while it is flipped.
  // Four presses: resume, restart, music, sound, all settings.
  for (let i = 0; i < 4; i++) {
    await press(page, 'ArrowDown', 120);
  }
  await press(page, 'Enter');
  await waitForScreen(page, 'settings');
  await shot(page, 'pause-settings-over-board');

  // Turn high contrast back OFF, then get the panels out of the way entirely:
  // the comparison shot has to be the same board under the same lighting with
  // nothing over it, or it is not a comparison.
  await page.locator('[data-item="highContrast"]').click();
  await sleep(400);
  await press(page, 'Escape'); // settings → pause
  await waitForScreen(page, 'pause');
  await press(page, 'Escape'); // pause → back to the board
  await sleep(1200);
  await shot(page, 'play-high-contrast-off');

  await page.close();
}

/**
 * Drive the run into a game over, deliberately, **from the spawn tile**.
 *
 * It uses a *rule* rather than luck: fidelity §5.2 says a **player's** bullet
 * destroys the eagle, and fidelity §2 puts P1's spawn at tile (4,12) with the
 * eagle at (6,12) — the same row, two tiles apart, with one brick tile of the
 * base ring between them. So a tank that has never moved can face right, hold
 * fire, and end the run in a few seconds, every time.
 *
 * The precondition is the whole trick: the tank must not have moved. That is
 * why the scoring pass above holds fire **without a direction key**.
 */
async function endTheRun(page: Page, budgetMs = 40_000): Promise<boolean> {
  if ((await currentScreen(page)) === 'gameOver') {
    return true; // the enemies got there first, which is also a game over
  }
  await press(page, 'KeyD', 220);
  await page.keyboard.down('KeyJ');
  const ended = await page
    .locator('[data-screen="gameOver"]')
    .waitFor({ timeout: budgetMs })
    .then(() => true)
    .catch(() => false);
  await page.keyboard.up('KeyJ');
  return ended;
}

/**
 * A short stage played to completion, for the stage-clear tally.
 *
 * The script is "hold fire, facing up, and do not move": enemies come down
 * toward the base (fidelity §9 weights the AI that way), so they walk into the
 * lane, and a stationary player is the only script whose outcome does not
 * compound with the AI. It is still a real game against a real AI, so the walk
 * retries rather than assuming one attempt lands.
 */
async function walkTally(browser: Browser, results: Results): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await newPage(browser, results);
    await page.addInitScript(() => {
      globalThis.localStorage?.clear();
    });
    // One enemy, so the clear is reachable; every other rule is untouched.
    await page.goto(
      `${BASE}?quality=high&seed=${SEED + attempt}&stage=1&enemies=1`,
    );
    await page.locator('[data-hud="root"]').waitFor({ timeout: 30_000 });
    await sleep(INTRO_MS + 600);

    await page.keyboard.down('KeyJ');
    const cleared = await page
      .locator('[data-screen="tally"]')
      .waitFor({ timeout: 150_000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.up('KeyJ');

    if (!cleared) {
      console.warn(`  ! attempt ${attempt}: stage did not clear`);
      await page.close();
      continue;
    }

    results.loop.push('tally');
    await sleep(450);
    await shot(page, 'tally-counting');
    await sleep(1800);
    await shot(page, 'tally-complete');

    // …and it really advances (fidelity §11.2 "then advance"), onto the NEXT
    // stage number, with the run's score carried.
    await press(page, 'Enter', 900);
    await waitForScreen(page, 'intro');
    await shot(page, 'tally-next-stage-intro');
    results.loop.push('intro(stage 2)');
    await sleep(INTRO_MS);
    await shot(page, 'stage-2-carryover');
    await page.close();
    return;
  }
  console.warn('  ! no tally shot after three attempts');
}

/**
 * The full loop, end to end: title → play → death → game over → high-score
 * entry → the table → title. This is the proof the brief asks for, and every
 * transition below is a real key press.
 */
async function walkFullLoop(browser: Browser, results: Results): Promise<void> {
  const page = await newPage(browser, results);
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  await page.goto(`${BASE}?quality=high&seed=${SEED}`);

  await waitForScreen(page, 'title');
  await sleep(1200);
  await shot(page, 'loop-1-title');

  await press(page, 'Enter');
  await waitForScreen(page, 'menu');
  await shot(page, 'loop-2-menu');

  await press(page, 'Enter'); // Campaign
  await waitForScreen(page, 'stageSelect');
  await press(page, 'Enter'); // stage 1
  await waitForScreen(page, 'intro');
  await shot(page, 'loop-3-intro');
  await sleep(INTRO_MS + 600);
  await shot(page, 'loop-4-play');

  // Score something first — an entry screen needs a qualifying score, and
  // fidelity §13's fork is the interesting half of this loop.
  //
  // Stationary, facing up, fire held: enemies come down toward the base, so
  // they walk into the lane. **No direction key is pressed**, which is what
  // leaves the tank on its spawn tile for `endTheRun` below.
  await page.keyboard.down('KeyJ');
  const scoreDeadline = Date.now() + 40_000;
  let scored = 0;
  while (Date.now() < scoreDeadline) {
    await sleep(1500);
    if ((await currentScreen(page)) === 'gameOver') {
      break;
    }
    scored = Number(
      (await page
        .locator('[data-hud="p1-score"]')
        .textContent()
        .catch(() => '0')) ?? '0',
    );
    if (scored > 0) {
      break;
    }
  }
  await page.keyboard.up('KeyJ');
  console.log(`  score before the run ends: ${scored}`);
  await shot(page, 'loop-5-played');

  // Death, by a rule rather than by luck (see `endTheRun`).
  const ended = await endTheRun(page);
  if (!ended) {
    console.warn('  ! the run would not end — no game-over shot');
    await page.close();
    return;
  }
  await sleep(500);
  results.loop.push('gameOver');
  await shot(page, 'loop-6-game-over');

  await press(page, 'Enter', 600);
  const after = await currentScreen(page);
  if (after === 'hiScoreEntry') {
    results.loop.push('hiScoreEntry');
    await shot(page, 'loop-7-hiscore-entry');
    // Spell something, so the shot shows a real three-character wheel.
    await press(page, 'ArrowUp', 100); // A → B
    await press(page, 'ArrowRight', 100);
    await press(page, 'ArrowUp', 100);
    await press(page, 'ArrowUp', 100); // A → C
    await press(page, 'ArrowRight', 100);
    await press(page, 'ArrowDown', 100); // A → the last glyph on the wheel
    await shot(page, 'loop-8-hiscore-entry-typed');
    await press(page, 'Enter', 700);
  } else {
    console.warn(`  ! score did not qualify (${scored}) — no entry shot`);
  }

  await waitForScreen(page, 'hiScore');
  results.loop.push('hiScore');
  await sleep(400);
  await shot(page, 'loop-9-hiscore-table');

  await press(page, 'Enter', 800);
  await waitForScreen(page, 'title');
  results.loop.push('title');
  await sleep(900);
  await shot(page, 'loop-10-back-to-title');

  // …and the loop really closes: the entry survived into storage, which is
  // read back from `bc.scores.v1` rather than from the DOM (the title screen
  // shows only the top row).
  const stored = await page.evaluate(
    () => globalThis.localStorage?.getItem('bc.scores.v1') ?? '(none)',
  );
  console.log(`  bc.scores.v1 after the loop: ${stored}`);
  results.loop.push(`stored:${stored}`);
  await page.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: BASE,
    viewport: [W, H],
    screenshots: shots,
    loop: [],
    consoleErrors: [],
    highContrast: measureHighContrast(),
  };

  // Headed, like `capture-play`: headless Chromium renders through SwiftShader,
  // and a screenshot of a software rasteriser is not what anybody sees.
  const browser = await chromium.launch({ headless: false });
  try {
    console.log('shell…');
    await walkShell(browser, results);
    console.log('tally…');
    await walkTally(browser, results);
    console.log('full loop…');
    await walkFullLoop(browser, results);
  } finally {
    await browser.close();
  }

  writeFileSync(ARTIFACT, `${JSON.stringify(results.highContrast, null, 2)}\n`);
  writeFileSync(
    join(OUT, 'results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  console.log(`\nscreenshots → ${OUT} (${shots.length})`);
  console.log(`high-contrast measurement → ${ARTIFACT}`);
  console.log(`flow walked: ${results.loop.join(' → ')}`);
  console.table(results.highContrast.tokens);
  console.log(
    `worst player-vs-enemy separation: ${results.highContrast.worstOff} → ` +
      `${results.highContrast.worstOn} (×${results.highContrast.improvementFactor})`,
  );
  if (results.consoleErrors.length > 0) {
    console.error('\nconsole errors:', results.consoleErrors);
    process.exitCode = 1;
  }
}

void main();
