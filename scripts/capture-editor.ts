// scripts/capture-editor.ts — the construction mode's visual verification.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:editor
//
// Outputs:
//   · `.superpowers/sdd/screens-T8/` — the screenshots (git-ignored, like every
//     other capture directory here; the SCRIPT is what is committed).
//   · `docs/calibration/editor-chunk.json` — **committed**. "The editor is code
//     split" is a claim about a build, so the script runs `vite build` and
//     writes down what came out: which chunk holds the editor, how big it is,
//     and the proof that the entry chunk does not mention it.
//
// Everything below drives the real page with a real mouse. Painting in
// particular is a genuine press-drag-release over the field element, because
// the thing under test is a *stroke* — the mid-stroke screenshot is taken with
// the button still down.

import { chromium, type Browser, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T8');
const ARTIFACT = join('docs', 'calibration', 'editor-chunk.json');

const W = 1400;
const H = 900;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const shots: string[] = [];
let shotIndex = 0;

async function shot(page: Page, name: string): Promise<void> {
  // Art §10's panels fade/slide in over 150 ms; settle before photographing.
  await sleep(350);
  const file = `editor-${String(shotIndex).padStart(2, '0')}-${name}.png`;
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
  /** 0-based slots the UI marks as carriers. Must be `[3, 10, 17]`. */
  carrierSlots: number[];
  /** The wave after the walk, read back from the buttons. */
  wave: string[];
  /** The messages the Validate button showed, verbatim. */
  validationErrors: string[];
  /** …and after the fault was fixed. */
  validationAfterFix: string[];
  /** Tiles and partials in the drawn draft, read from the DOM. */
  drawn: {
    brick: number;
    steel: number;
    water: number;
    trees: number;
    ice: number;
  };
  consoleErrors: string[];
}

// ---------------------------------------------------------------------------
// Field geometry — the field is a square grid of 13 tiles / 26 subcells.
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function subPoint(
  box: Box,
  tx: number,
  ty: number,
  sub: number,
): { x: number; y: number } {
  const s = box.width / 26;
  return {
    x: box.x + (tx * 2 + (sub % 2)) * s + s / 2,
    y: box.y + (ty * 2 + (sub < 2 ? 0 : 1)) * s + s / 2,
  };
}

async function fieldBox(page: Page): Promise<Box> {
  const box = await page.locator('[data-role="field"]').boundingBox();
  if (box === null) {
    throw new Error('the editor field has no box — is the screen up?');
  }
  return box;
}

/** Press, drag through every point, release. A real stroke. */
async function stroke(
  page: Page,
  points: { x: number; y: number }[],
): Promise<void> {
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.up();
}

async function pickBrush(page: Page, char: string): Promise<void> {
  await page.locator(`[data-brush="${char}"]`).click();
}

async function pickMode(page: Page, mode: string): Promise<void> {
  await page.locator(`[data-mode="${mode}"]`).click();
}

// ---------------------------------------------------------------------------
// The walk
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

async function walkEditor(browser: Browser, results: Results): Promise<void> {
  const page = await newPage(browser, results);
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  await page.goto(`${BASE}#editor`);
  await page.locator('[data-screen="editor"]').waitFor({ timeout: 30_000 });
  await shot(page, 'empty');

  // --- a stage in progress ------------------------------------------------
  let box = await fieldBox(page);

  await pickMode(page, 'tile');
  await pickBrush(page, 'B');
  // Two brick corridors and a room around the base — drawn as strokes, so the
  // drag path is what produces them rather than 40 separate clicks.
  await stroke(page, [subPoint(box, 1, 2, 0), subPoint(box, 11, 2, 0)]);
  await stroke(page, [subPoint(box, 1, 4, 0), subPoint(box, 1, 9, 0)]);
  await stroke(page, [subPoint(box, 11, 4, 0), subPoint(box, 11, 9, 0)]);
  await stroke(page, [subPoint(box, 3, 9, 0), subPoint(box, 9, 9, 0)]);

  await pickBrush(page, 'S');
  await stroke(page, [subPoint(box, 4, 4, 0), subPoint(box, 8, 4, 0)]);

  await pickBrush(page, 'W');
  await stroke(page, [subPoint(box, 2, 6, 0), subPoint(box, 5, 6, 0)]);
  await stroke(page, [subPoint(box, 7, 6, 0), subPoint(box, 10, 6, 0)]);

  await pickBrush(page, 'T');
  await stroke(page, [subPoint(box, 5, 11, 0), subPoint(box, 4, 11, 0)]);
  await stroke(page, [subPoint(box, 8, 11, 0), subPoint(box, 9, 11, 0)]);

  await pickBrush(page, 'I');
  await stroke(page, [subPoint(box, 3, 7, 0), subPoint(box, 9, 7, 0)]);

  // Metadata, typed into the real inputs.
  await page.locator('[data-field="name"]').fill('Ice bridge');
  await page.locator('[data-field="author"]').fill('T8');

  // A wave with some shape to it: the back six armor, a couple of fast ones.
  for (const [slot, clicks] of [
    [3, 1],
    [10, 2],
    [17, 3],
    [6, 1],
  ] as const) {
    for (let i = 0; i < clicks; i++) {
      await page.locator(`[data-slot="${slot}"]`).click();
    }
  }
  await page.locator('[data-slot="14"]').click({ modifiers: ['Shift'] });
  await shot(page, 'level-in-progress');

  // --- subcell painting, photographed MID-stroke ---------------------------
  await pickMode(page, 'subcell');
  await pickBrush(page, 'B');
  box = await fieldBox(page);
  // The originals' signature move: a row of half-tiles. Pressed and dragged
  // across five subcells, then held there while the shutter goes.
  const start = subPoint(box, 2, 3, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [tx, sub] of [
    [2, 1],
    [3, 0],
    [3, 1],
    [4, 0],
    [4, 1],
    [5, 0],
  ] as const) {
    const p = subPoint(box, tx, 3, sub);
    await page.mouse.move(p.x, p.y);
    await sleep(40);
  }
  await shot(page, 'subcell-mid-stroke');
  await page.mouse.up();
  await sleep(150);
  await shot(page, 'subcell-stroke-done');

  // --- the wave editor, with its fixed carriers ---------------------------
  results.carrierSlots = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-carrier="fixed"]')].map(
      (n) => Number(n.dataset.slot),
    ),
  );
  results.wave = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-slot]')].map(
      (n) => n.dataset.type ?? '?',
    ),
  );
  await page.locator('.bc-editor-wave').scrollIntoViewIfNeeded();
  await sleep(200);
  await page
    .locator('[data-screen="editor"] .bc-editor-side')
    .screenshot({ path: join(OUT, 'editor-04-wave-carriers.png') });
  shots.push('editor-04-wave-carriers.png');
  shotIndex++;
  console.log('  → editor-04-wave-carriers.png');

  // --- a validation error, in validateLevel's own words --------------------
  await page.locator('[data-field="name"]').fill('');
  await page.locator('[data-action="validate"]').click();
  await sleep(250);
  results.validationErrors = await page.evaluate(() =>
    [...document.querySelectorAll('[data-role="errors"] li')].map(
      (n) => n.textContent ?? '',
    ),
  );
  await shot(page, 'validation-error');

  await page.locator('[data-field="name"]').fill('Ice bridge');
  await page.locator('[data-action="validate"]').click();
  await sleep(250);
  results.validationAfterFix = await page.evaluate(() =>
    [...document.querySelectorAll('[data-role="errors"] li')].map(
      (n) => n.textContent ?? '',
    ),
  );
  await shot(page, 'validation-clean');

  // Written as one expression on purpose: a *named* helper inside `evaluate`
  // is rewritten by tsx/esbuild into a call to its `__name` shim, which does
  // not exist in the page — "ReferenceError: __name is not defined", measured.
  results.drawn = await page.evaluate(() => ({
    brick: document.querySelectorAll('.bc-sub.is-brick').length,
    steel: document.querySelectorAll('.bc-sub.is-steel').length,
    water: document.querySelectorAll('.bc-sub.is-water').length,
    trees: document.querySelectorAll('.bc-sub.is-trees').length,
    ice: document.querySelectorAll('.bc-sub.is-ice').length,
  }));

  await page.close();
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

interface ChunkReport {
  builtAt: string;
  /** Every JS chunk the build produced, largest first. */
  chunks: { file: string; bytes: number }[];
  entry: { file: string; bytes: number };
  editor: { file: string; bytes: number };
  /** The editor chunk's share of the entry chunk. */
  editorShareOfEntry: string;
  /** Proof of the split: the entry chunk must not contain the editor's code. */
  entryMentionsEditorSource: boolean;
  /** …and must reference the editor chunk only as a lazy import. */
  entryReferencesEditorChunk: boolean;
}

function measureChunks(): ChunkReport {
  console.log('building…');
  execSync('npm run build', { stdio: 'inherit' });
  const dir = join('dist', 'assets');
  if (!existsSync(dir)) {
    throw new Error('dist/assets missing — did the build fail?');
  }
  const chunks = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, bytes: statSync(join(dir, f)).size }))
    .sort((a, b) => b.bytes - a.bytes);

  const editor = chunks.find((c) => /^editor-/.test(c.file));
  if (editor === undefined) {
    throw new Error(
      `no editor chunk in dist/assets — found ${chunks.map((c) => c.file).join(', ')}`,
    );
  }
  const entry = chunks.find((c) => /^(index|main)-/.test(c.file)) ?? chunks[0];
  const entrySource = readFileSync(join(dir, entry.file), 'utf8');

  return {
    builtAt: new Date().toISOString(),
    chunks,
    entry,
    editor,
    editorShareOfEntry: `${((editor.bytes / entry.bytes) * 100).toFixed(1)}%`,
    // A string only the editor's own code contains. Its absence from the entry
    // chunk is what "not in the main bundle" actually means.
    entryMentionsEditorSource: entrySource.includes('bc-editor-slot-carrier'),
    entryReferencesEditorChunk: entrySource.includes(editor.file),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join('docs', 'calibration'), { recursive: true });

  const results: Results = {
    capturedAt: new Date().toISOString(),
    url: BASE,
    viewport: [W, H],
    screenshots: shots,
    carrierSlots: [],
    wave: [],
    validationErrors: [],
    validationAfterFix: [],
    drawn: { brick: 0, steel: 0, water: 0, trees: 0, ice: 0 },
    consoleErrors: [],
  };

  // Headed, like the other capture scripts: headless Chromium renders through
  // SwiftShader, and a screenshot of a software rasteriser is not what anybody
  // sees. (The editor is DOM, but the page still boots the same app.)
  const browser = await chromium.launch({ headless: false });
  try {
    console.log('editor…');
    await walkEditor(browser, results);
  } finally {
    await browser.close();
  }

  const chunkReport = measureChunks();
  writeFileSync(ARTIFACT, `${JSON.stringify(chunkReport, null, 2)}\n`);
  writeFileSync(
    join(OUT, 'editor-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  console.log(`\nscreenshots → ${OUT} (${shots.length})`);
  console.log(`chunk artifact → ${ARTIFACT}`);
  console.log(`carrier slots: ${JSON.stringify(results.carrierSlots)}`);
  console.log(`wave: ${results.wave.join(',')}`);
  console.log(`validation: ${JSON.stringify(results.validationErrors)}`);
  console.log(`after fix : ${JSON.stringify(results.validationAfterFix)}`);
  console.log(
    `entry ${chunkReport.entry.file} ${chunkReport.entry.bytes} B · ` +
      `editor ${chunkReport.editor.file} ${chunkReport.editor.bytes} B ` +
      `(${chunkReport.editorShareOfEntry} of the entry chunk)`,
  );

  if (JSON.stringify(results.carrierSlots) !== '[3,10,17]') {
    console.error('carrier slots are not the 4th, 11th and 18th.');
    process.exitCode = 1;
  }
  if (chunkReport.entryMentionsEditorSource) {
    console.error('the entry chunk contains the editor — the split is broken.');
    process.exitCode = 1;
  }
  if (results.consoleErrors.length > 0) {
    console.error('\nconsole errors:', results.consoleErrors);
    process.exitCode = 1;
  }
}

void main();
