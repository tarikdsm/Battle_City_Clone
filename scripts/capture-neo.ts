// scripts/capture-neo.ts — T8.3's visual verification.
//
//   npm run dev        # in another terminal — the script needs it
//   npm run capture:neo
//
// Four things, all of them driven through the real page with a real mouse:
//
//   1. a mirror mode painting LIVE — the shutter fires with the button still
//      down, so what is on the board is four strokes from one drag;
//   2. a rectangle drag, photographed mid-drag (the preview) and after release;
//   3. every one of the twelve Neo stages imported into the editor and put
//      through the Validate button — the same gate a shared level meets;
//   4. one of them actually played, in 1P and again in 2P (`?players=2`).
//
// Plus the contact sheet's Neo half rendered to a PNG, because "the sheet" is
// the deliverable the content review reads and a .txt is not a screenshot.
//
// Output: `.superpowers/sdd/screens-T8/` (git-ignored, like every capture
// directory here — the SCRIPT is what is committed).
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5173/';
const OUT =
  process.env.CAPTURE_OUT ?? join('.superpowers', 'sdd', 'screens-T8');
const NEO_DIR = join('src', 'levels', 'neo');
const SHEET = join('docs', 'assets', 'level-contact-sheet.txt');

const W = 1400;
const H = 900;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const shots: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  await sleep(300);
  const file = `neo-${name}.png`;
  await page.screenshot({ path: join(OUT, file) });
  shots.push(file);
  console.log(`  → ${file}`);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The centre of a subcell, in page coordinates. The field is 26 across. */
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

interface Results {
  capturedAt: string;
  screenshots: string[];
  /** Painted subcells after the quad-mirror stroke, by material. */
  mirrorStroke: { brick: number; steel: number };
  /** The four quadrants' subcell signatures — they must agree. */
  quadrants: string[];
  /** The whole board at subcell resolution, as read back from the DOM. */
  board: string[];
  /** Subcells the rectangle drag left behind. */
  rectSteel: number;
  /** What the coordinate readout said while hovering a known tile. */
  readout: { tile: string; half: string };
  /** Per stage: what the editor's Validate button answered. */
  validated: { id: string; name: string; messages: string[] }[];
  /** The 2P board: how many player tanks the HUD showed lives for. */
  twoPlayerLives: string[];
  consoleErrors: string[];
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
  });
  return page;
}

// ---------------------------------------------------------------------------
// 1 + 2 — the new tools, live
// ---------------------------------------------------------------------------

async function walkTools(browser: Browser, results: Results): Promise<Page> {
  const page = await newPage(browser, results);
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  await page.goto(`${BASE}#editor`);
  await page.locator('[data-screen="editor"]').waitFor({ timeout: 30_000 });

  // --- quad mirror, painted live at half-tile resolution -------------------
  await page.locator('[data-mirror="quad"]').click();
  await page.locator('[data-mode="subcell"]').click();
  await page.locator('[data-brush="B"]').click();
  // Re-measured before EVERY mouse sequence, never cached: the field is
  // `position: sticky` inside a scrolling panel and Playwright scrolls a
  // control into view before clicking it, so a box taken three clicks ago
  // points at the wrong tiles. (Measured: the first run of this script drew
  // its rectangle two tiles off and the readout proved it.)
  let box = await fieldBox(page);

  const start = subPoint(box, 2, 2, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [tx, ty, sub] of [
    [2, 2, 1],
    [3, 2, 0],
    [3, 3, 2],
    [4, 3, 3],
    [4, 4, 1],
  ] as const) {
    const p = subPoint(box, tx, ty, sub);
    await page.mouse.move(p.x, p.y);
    await sleep(70);
  }
  // Shutter with the button still down: one drag, four strokes on the board.
  await shot(page, '00-mirror-quad-live');
  await page.mouse.up();
  await sleep(150);

  await page.locator('[data-mode="tile"]').click();
  await page.locator('[data-brush="S"]').click();
  // …and settle before measuring: a locator click scrolls its control into
  // view, and a box read while that scroll is still running points a tile and
  // a half off (measured — the steel below landed on (5,5) instead of (6,6)).
  await sleep(250);
  box = await fieldBox(page);
  const p2 = subPoint(box, 6, 6, 0);
  await page.mouse.move(p2.x, p2.y);
  await page.mouse.down();
  await page.mouse.up();
  await shot(page, '01-mirror-quad-done');

  results.mirrorStroke = await page.evaluate(() => ({
    brick: document.querySelectorAll('.bc-sub.is-brick').length,
    steel: document.querySelectorAll('.bc-sub.is-steel').length,
  }));
  // The board as 26x26 glyphs, read straight out of the DOM. Written as ONE
  // expression with no named helper inside `evaluate`: tsx/esbuild rewrites a
  // named function there into a call to its `__name` shim, which does not
  // exist in the page (measured — see capture-editor.ts's note).
  //
  // The cells come back tagged with their own coordinates rather than in DOM
  // order, because DOM order is TILE order — a tile's four subcells are
  // siblings — and reading it as 26 per row silently transposes the board.
  // (Measured: the first version of this check "failed" on a mirror that was
  // in fact perfect.)
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-role="field"] .bc-sub')]
      .map(
        (n) =>
          `${n.dataset.tx},${n.dataset.ty},${n.dataset.sub},` +
          `${
            n.classList.contains('is-brick')
              ? '#'
              : n.classList.contains('is-steel')
                ? '@'
                : n.classList.contains('is-eagle')
                  ? 'A'
                  : '.'
          }`,
      )
      .join(' '),
  );
  const grid = new Array<string>(26 * 26).fill('.');
  for (const entry of cells.split(' ')) {
    const [tx, ty, sub, glyph] = entry.split(',');
    const sx = Number(tx) * 2 + (Number(sub) % 2);
    const sy = Number(ty) * 2 + (Number(sub) < 2 ? 0 : 1);
    grid[sy * 26 + sx] = glyph;
  }
  results.board = Array.from({ length: 26 }, (_, y) =>
    grid.slice(y * 26, y * 26 + 26).join(''),
  );
  // Folded onto each other, the four corners have to be the same picture. A
  // mirror computed at TILE resolution would put a top-left half-tile in the
  // top-left corner of the far tile too, and this is what catches that.
  //
  // A 10x10 subcell window from each corner, not a full quadrant: the eagle
  // and its brick ring are stamped at the bottom centre and have no reflection
  // anywhere, so a fold that included them could never match however perfect
  // the mirror was. (It did not, on the first run.)
  const WINDOW = 10;
  results.quadrants = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ].map(([flipX, flipY]) => {
    let out = '';
    for (let y = 0; y < WINDOW; y++) {
      for (let x = 0; x < WINDOW; x++) {
        const sx = flipX ? 25 - x : x;
        const sy = flipY ? 25 - y : y;
        out += grid[sy * 26 + sx];
      }
    }
    return out;
  });

  // --- the rectangle drag --------------------------------------------------
  await page.locator('[data-action="clear"]').click();
  await page.locator('[data-mirror="off"]').click();
  await page.locator('[data-tool="rectFill"]').click();
  await page.locator('[data-brush="S"]').click();
  await sleep(150);

  box = await fieldBox(page);
  const from = subPoint(box, 2, 3, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const [tx, ty] of [
    [4, 4],
    [6, 5],
    [8, 6],
  ] as const) {
    const p = subPoint(box, tx, ty, 3);
    await page.mouse.move(p.x, p.y);
    await sleep(120);
  }
  // Mid-drag: what is on the board is the preview, and the history is empty.
  await shot(page, '02-rectangle-drag');
  await page.mouse.up();
  await sleep(200);
  await shot(page, '03-rectangle-done');
  results.rectSteel = await page.evaluate(
    () => document.querySelectorAll('.bc-sub.is-steel').length,
  );

  // --- the coordinate readout ----------------------------------------------
  box = await fieldBox(page);
  const hover = subPoint(box, 7, 4, 0);
  await page.mouse.move(hover.x, hover.y);
  await sleep(120);
  results.readout.tile =
    (await page.locator('[data-role="coords"]').textContent()) ?? '';
  await page.locator('[data-mode="subcell"]').click();
  box = await fieldBox(page);
  const hoverHalf = subPoint(box, 7, 4, 1);
  await page.mouse.move(hoverHalf.x, hoverHalf.y);
  await sleep(120);
  results.readout.half =
    (await page.locator('[data-role="coords"]').textContent()) ?? '';
  await shot(page, '04-coordinate-readout');

  return page;
}

// ---------------------------------------------------------------------------
// 3 — the twelve, through the editor's own import + validate
// ---------------------------------------------------------------------------

async function walkStages(page: Page, results: Results): Promise<void> {
  const files = readdirSync(NEO_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    const json = readFileSync(join(NEO_DIR, file), 'utf8');
    await page.locator('[data-field="import"]').fill(json);
    await page.locator('[data-action="import"]').click();
    await sleep(200);
    await page.locator('[data-action="validate"]').click();
    await sleep(200);
    const messages = await page.evaluate(() =>
      [...document.querySelectorAll('[data-role="errors"] li')].map(
        (n) => n.textContent ?? '',
      ),
    );
    const name = await page.locator('[data-field="name"]').inputValue();
    results.validated.push({ id: file.replace('.json', ''), name, messages });
    console.log(
      `  ${file.padEnd(12)} ${name.padEnd(15)} ${messages.join(' ')}`,
    );
    // Mirrorworks and Blackout get their own portrait: one is the symmetry
    // case, the other is the openness extreme.
    if (file === 'neo09.json') {
      await shot(page, '05-mirrorworks-in-editor');
    }
    if (file === 'neo11.json') {
      await shot(page, '06-blackout-in-editor');
    }
  }
}

// ---------------------------------------------------------------------------
// 4 — played, 1P then 2P
// ---------------------------------------------------------------------------

async function playIt(page: Page): Promise<void> {
  // The draft in the editor right now is neo-12; go back to neo-09 and play it.
  const json = readFileSync(join(NEO_DIR, 'neo09.json'), 'utf8');
  await page.locator('[data-field="import"]').fill(json);
  await page.locator('[data-action="import"]').click();
  await sleep(250);
  await page.locator('[data-action="testplay"]').click();
  await page.locator('[data-hud="root"]').waitFor({ timeout: 30_000 });
  await sleep(2600);
  await page.keyboard.down('KeyJ');
  await sleep(2600);
  await page.keyboard.up('KeyJ');
  await shot(page, '07-mirrorworks-played-1p');
  await page.keyboard.press('Escape');
  await page.locator('[data-screen="editor"]').waitFor({ timeout: 30_000 });
}

async function playTwoPlayer(
  browser: Browser,
  results: Results,
): Promise<void> {
  const page = await newPage(browser, results);
  await page.addInitScript(() => {
    globalThis.localStorage?.clear();
  });
  // `?players=2` is the only way to get a second tank on the board (debug.ts),
  // and content §3 specifies Mirrorworks as designed around 2P split defence —
  // so this is the shot that decides whether that claim is true.
  await page.goto(`${BASE}?players=2&stage=1#editor`);
  await page.locator('[data-screen="editor"]').waitFor({ timeout: 30_000 });
  const json = readFileSync(join(NEO_DIR, 'neo09.json'), 'utf8');
  await page.locator('[data-field="import"]').fill(json);
  await page.locator('[data-action="import"]').click();
  await sleep(250);
  await page.locator('[data-action="testplay"]').click();
  await page.locator('[data-hud="root"]').waitFor({ timeout: 30_000 });
  await sleep(2600);
  // P1 holds its half (A/D + Space), P2 holds the other (arrows + Numpad 0).
  await page.keyboard.down('KeyA');
  await page.keyboard.down('ArrowRight');
  await sleep(900);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('Space');
  await page.keyboard.down('Numpad0');
  await sleep(2200);
  await page.keyboard.up('Space');
  await page.keyboard.up('Numpad0');
  await shot(page, '08-mirrorworks-played-2p');
  // Two HUD blocks with lives on them is what "two players are on this board"
  // looks like from outside the simulation.
  results.twoPlayerLives = await page.evaluate(() =>
    ['p1-lives', 'p2-lives'].map((k) => {
      const node = document.querySelector<HTMLElement>(`[data-hud="${k}"]`);
      return `${k}:${node === null ? 'absent' : node.textContent}`;
    }),
  );
  await page.close();
}

// ---------------------------------------------------------------------------
// The contact sheet, as a picture
// ---------------------------------------------------------------------------

async function shootSheet(browser: Browser, results: Results): Promise<void> {
  const sheet = readFileSync(SHEET, 'utf8');
  const start = sheet.indexOf('neo-01');
  const neo = sheet.slice(sheet.lastIndexOf('=====', start));
  const page = await newPage(browser, results);
  await page.setViewportSize({ width: 1180, height: 1400 });
  await page.setContent(
    `<body style="margin:0;background:#0d1117;color:#c9d1d9;font:12px/1.25 ui-monospace,Consolas,monospace">
       <pre style="margin:0;padding:16px;white-space:pre">${neo
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')}</pre>
     </body>`,
  );
  await sleep(200);
  await page.screenshot({
    path: join(OUT, 'neo-09-contact-sheet.png'),
    fullPage: true,
  });
  shots.push('neo-09-contact-sheet.png');
  console.log('  → neo-09-contact-sheet.png');
  await page.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const results: Results = {
    capturedAt: new Date().toISOString(),
    screenshots: shots,
    mirrorStroke: { brick: 0, steel: 0 },
    quadrants: [],
    board: [],
    rectSteel: 0,
    readout: { tile: '', half: '' },
    validated: [],
    twoPlayerLives: [],
    consoleErrors: [],
  };

  const browser = await chromium.launch({ headless: false });
  try {
    const page = await walkTools(browser, results);
    await walkStages(page, results);
    await playIt(page);
    await page.close();
    await playTwoPlayer(browser, results);
    await shootSheet(browser, results);
  } finally {
    await browser.close();
  }

  writeFileSync(
    join(OUT, 'neo-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(`\nscreenshots → ${OUT} (${shots.length})`);
  console.log(`readout: "${results.readout.tile}" | "${results.readout.half}"`);
  console.log(
    `mirror stroke: ${results.mirrorStroke.brick} brick subcells, ` +
      `${results.mirrorStroke.steel} steel`,
  );
  console.log(`rectangle drag: ${results.rectSteel} steel subcells`);
  console.log(`2P lives: ${JSON.stringify(results.twoPlayerLives)}`);

  const clean = results.validated.filter(
    (v) => v.messages.length === 1 && /ready to play/i.test(v.messages[0]),
  );
  console.log(`validated clean in the editor: ${clean.length}/12`);
  if (clean.length !== 12) {
    console.error('not every Neo stage validated clean in the editor.');
    process.exitCode = 1;
  }
  if (new Set(results.quadrants).size !== 1) {
    console.error('the quad mirror did not produce four identical quadrants.');
    process.exitCode = 1;
  }
  if (results.mirrorStroke.brick === 0 || results.rectSteel === 0) {
    console.error('a tool painted nothing.');
    process.exitCode = 1;
  }
  if (!/^Tile 7,4/.test(results.readout.tile)) {
    console.error(`the readout did not name the hovered tile.`);
    process.exitCode = 1;
  }
  if (results.consoleErrors.length > 0) {
    console.error('\nconsole errors:', results.consoleErrors);
    process.exitCode = 1;
  }
}

void main();
