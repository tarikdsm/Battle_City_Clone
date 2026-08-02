// scripts/capture-campaign.ts — the proof that the campaign is 35 stages long.
//
//   npm run dev          # in another terminal — the script needs it
//   npm run capture:campaign
//
// Outputs:
//   · `.superpowers/sdd/screens-T8/` — screenshots (git-ignored, like every
//     other capture directory here; the SCRIPT is what is committed).
//   · `docs/calibration/campaign-chain.json` — **committed**, because "stage 2
//     loads and is different" is a claim about a run, and a claim about a run
//     needs an artifact from a run.
//
// ## What it is actually checking
//
// Until T8 `main.ts` imported one level file and handed it to every stage, so a
// campaign played stage 1 thirty-five times. That bug is invisible from any
// single stage: every number produced a valid, playable board with the right
// label on the curtain. It is only visible from *two*, which is why this walk
// clears a stage rather than photographing one.
//
// Three independent signals are collected, because each alone can lie:
//
//   1. the **screen chain** — play → tally → intro → play — read from the DOM;
//   2. the **layout id** per stage, from the dev-only `stage N orig-NN` console
//      line `startStage` writes (dev builds only, see `main.ts`);
//   3. the **terrain**, pulled from the level files and diffed, so the report
//      says how many of the 169 tiles actually changed rather than "different".
//
// The one dev affordance used is `?enemies=` (see `src/app/debug.ts`), which
// shortens the wave so the clear is reachable in seconds. It changes level
// content, never a rule.

import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  allOriginalStages,
  ORIGINAL_STAGE_COUNT,
} from '../src/levels/campaign';
import { stampedTileRows } from '../src/levels/analysis';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T8');
const ARTIFACT = join('docs', 'calibration', 'campaign-chain.json');

const W = 1280;
const H = 800;
/** Fixed so the AI, the spawn cycle and the power-up rolls repeat run to run. */
const SEED = 20260802;
/** Fidelity §11.1: a 2 s "STAGE N" curtain before the controls come alive. */
const INTRO_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const shots: string[] = [];
let shotIndex = 0;

async function shot(page: Page, name: string): Promise<void> {
  // Art §10's panels fade/slide in over 150 ms, and `waitFor` returns the
  // instant the node exists — so a shot taken straight after a transition
  // photographs a half-transparent panel. Settle first, always.
  await sleep(400);
  const file = `campaign-${String(shotIndex).padStart(2, '0')}-${name}.png`;
  shotIndex++;
  await page.screenshot({ path: join(OUT, file) });
  shots.push(file);
  console.log(`  → ${file}`);
}

interface Results {
  capturedAt: string;
  url: string;
  viewport: [number, number];
  screenshots: string[];
  /** The screens the walk really passed through, read from the DOM. */
  chain: string[];
  /** `stage N orig-NN` lines, in order, from the dev-only log in `startStage`. */
  stageLog: string[];
  /** What the intro curtain said for the second stage. */
  secondStageCurtain: string;
  /** Tile-by-tile difference between the two layouts (out of 169). */
  terrainDiff: { stage1: string; stage2: string; tilesDiffering: number };
  /** Every stage's id + a terrain fingerprint, so "35 distinct" is checkable. */
  stages: { stage: number; id: string; name: string; fingerprint: string }[];
  distinctLayouts: number;
  consoleErrors: string[];
}

/** The number of tiles in which two stamped layouts disagree. */
function tileDiff(a: string[], b: string[]): number {
  let n = 0;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) n++;
    }
  }
  return n;
}

/** FNV-1a over the stamped rows — short enough to read in a diff. */
function fingerprint(rows: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of rows.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

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
    if (msg.text().startsWith('stage ')) {
      results.stageLog.push(msg.text());
    }
  });
  return page;
}

/**
 * Clear stage 1 and photograph what comes next.
 *
 * The script is "hold fire and do not move": enemies come down toward the base
 * (fidelity §9 weights the AI that way), so they walk into the lane, and a
 * stationary player is the only script whose outcome does not compound with the
 * AI. It is still a real game against a real AI, so this retries rather than
 * assuming one attempt lands.
 */
async function walkChain(browser: Browser, results: Results): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = await newPage(browser, results);
    results.stageLog.length = 0;
    results.chain.length = 0;
    await page.addInitScript(() => {
      globalThis.localStorage?.clear();
    });
    // One enemy, so the clear is reachable; every other rule is untouched.
    await page.goto(
      `${BASE}?quality=high&seed=${SEED + attempt}&stage=1&enemies=1`,
    );
    await page.locator('[data-hud="root"]').waitFor({ timeout: 60_000 });
    results.chain.push('play(stage 1)');
    await sleep(INTRO_MS + 600);
    await shot(page, 'stage-1-board');

    await page.keyboard.down('KeyJ');
    const cleared = await page
      .locator('[data-screen="tally"]')
      .waitFor({ timeout: 150_000 })
      .then(() => true)
      .catch(() => false);
    await page.keyboard.up('KeyJ');
    if (!cleared) {
      console.warn(`  ! attempt ${attempt}: stage 1 did not clear`);
      await page.close();
      continue;
    }
    results.chain.push('tally');
    await sleep(2000);
    await shot(page, 'stage-1-tally');

    // Fidelity §11.5: the counter rises and the next stage is announced.
    await page.keyboard.press('Enter');
    await page.locator('[data-screen="intro"]').waitFor({ timeout: 30_000 });
    results.chain.push('intro');
    results.secondStageCurtain = (
      await page.locator('[data-screen="intro"]').innerText()
    ).replace(/\s+/g, ' ');
    await shot(page, 'stage-2-curtain');

    await sleep(INTRO_MS + 900);
    results.chain.push('play(stage 2)');
    await shot(page, 'stage-2-board');
    await page.close();
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const levels = allOriginalStages();
  const rows = levels.map((l) => stampedTileRows(l));
  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: BASE,
    viewport: [W, H],
    screenshots: shots,
    chain: [],
    stageLog: [],
    secondStageCurtain: '',
    terrainDiff: {
      stage1: levels[0].id,
      stage2: levels[1].id,
      tilesDiffering: tileDiff(rows[0], rows[1]),
    },
    stages: levels.map((l, i) => ({
      stage: i + 1,
      id: l.id,
      name: l.name,
      fingerprint: fingerprint(rows[i]),
    })),
    distinctLayouts: new Set(rows.map((r) => fingerprint(r))).size,
    consoleErrors: [],
  };

  // Headed, like the other capture scripts: headless Chromium renders through
  // SwiftShader, and a screenshot of a software rasteriser is not what anybody
  // sees.
  const browser = await chromium.launch({ headless: false });
  // Declared without an initialiser: the only read is after the `finally`, and
  // an exception in the walk leaves through it rather than falling past it.
  let walked: boolean;
  try {
    console.log('campaign chain…');
    walked = await walkChain(browser, results);
  } finally {
    await browser.close();
  }

  writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(
    join(OUT, 'campaign-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  console.log(`\nscreenshots → ${OUT} (${shots.length})`);
  console.log(`chain artifact → ${ARTIFACT}`);
  console.log(`chain walked: ${results.chain.join(' → ')}`);
  console.log(`stage log: ${results.stageLog.join(' | ')}`);
  console.log(`curtain: ${results.secondStageCurtain}`);
  console.log(
    `terrain: ${results.terrainDiff.stage1} vs ${results.terrainDiff.stage2} ` +
      `differ in ${results.terrainDiff.tilesDiffering} of 169 tiles`,
  );
  console.log(
    `distinct layouts: ${results.distinctLayouts} / ${ORIGINAL_STAGE_COUNT}`,
  );

  if (!walked) {
    console.error('campaign chain never completed — no proof captured.');
    process.exitCode = 1;
  }
  if (results.distinctLayouts !== ORIGINAL_STAGE_COUNT) {
    console.error('two stages share a layout.');
    process.exitCode = 1;
  }
  if (results.stageLog.length < 2 || !results.stageLog[1].includes('orig-02')) {
    console.error(
      `second stage was not orig-02: ${results.stageLog.join(' | ')}`,
    );
    process.exitCode = 1;
  }
  if (results.consoleErrors.length > 0) {
    console.error('\nconsole errors:', results.consoleErrors);
    process.exitCode = 1;
  }
}

void main();
