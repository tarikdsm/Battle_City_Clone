// scripts/gen-icons.ts — the PWA icon set, generated from one SVG.
//
//   npm run icons
//
// Writes `public/icons/*.png`, which are **committed**: a build must not need a
// browser, and the deploy workflow runs `npm ci && npm run build` with no
// Playwright browser installed. The generator is committed too, so the art is a
// source file rather than four opaque binaries — change the SVG below and
// re-run, and the whole set moves together.
//
// ## Why Playwright and not a raster library
//
// Rasterising an SVG needs a renderer, and the project has exactly one runtime
// dependency (`three`, GDD §3) with no room for a second. Chromium is already
// here for the e2e suite, it is the renderer the icons will actually be seen
// through, and `page.screenshot` of a sized viewport is a one-line rasteriser.
//
// ## The two kinds of icon
//
// - **`any`** — drawn to the edges, which is what a browser tab and a desktop
//   install show.
// - **`maskable`** — the same mark inside Android's safe zone. The platform
//   crops a maskable icon to whatever shape the launcher uses (circle, squircle,
//   rounded square) and is allowed to take everything outside the centre 80%
//   circle, so the mark is scaled to ~62% and the background is drawn full
//   bleed. Shipping only an `any` icon gets it letterboxed into a white
//   rounded square on Android; shipping only a maskable one wastes a fifth of
//   the icon everywhere else.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('public', 'icons');

/** Art §3.1's tokens — the same board black and gold the game is drawn in. */
const BG = '#0a0a0a';
const GOLD = '#ffd76b';
const STEEL = '#c9ccd6';

/**
 * The mark: a Battle City tank seen from above, on the board's black.
 *
 * The same silhouette `hud.ts` draws as a life pip (two tracks, a hull, a
 * barrel), at 16×16 so the two cannot drift — an icon that is not the game's own
 * glyph is an icon that stops being it.
 */
function markSvg(scale: number): string {
  // The glyph is authored in a 16×16 box; `scale` is the fraction of the icon
  // it occupies, which is what separates `any` (edge to edge) from `maskable`
  // (inside the safe zone).
  const inset = (1 - scale) / 2;
  return `
    <g transform="translate(${inset * 16} ${inset * 16}) scale(${scale})">
      <rect x="1.5" y="3.5" width="2.6" height="9" fill="${GOLD}"/>
      <rect x="11.9" y="3.5" width="2.6" height="9" fill="${GOLD}"/>
      <rect x="4.8" y="4.2" width="6.4" height="8.3" fill="${GOLD}"/>
      <rect x="7.1" y="0.8" width="1.8" height="4.6" fill="${STEEL}"/>
    </g>`;
}

function iconSvg(scale: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
    <rect width="16" height="16" fill="${BG}"/>
    ${markSvg(scale)}
  </svg>`;
}

interface IconSpec {
  file: string;
  size: number;
  /** Fraction of the icon the mark fills. */
  scale: number;
}

/**
 * `192` and `512` are the two sizes the installability check requires; `180` is
 * iOS's `apple-touch-icon`, which does not read the manifest at all.
 */
const ICONS: readonly IconSpec[] = [
  { file: 'icon-192.png', size: 192, scale: 0.78 },
  { file: 'icon-512.png', size: 512, scale: 0.78 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.62 },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 0.72 },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // The source SVG is committed alongside the PNGs: a favicon can use it
  // directly, and it is the thing a designer would edit.
  writeFileSync(join(OUT, 'icon.svg'), `${iconSvg(0.78)}\n`);

  const browser = await chromium.launch();
  try {
    for (const spec of ICONS) {
      const page = await browser.newPage({
        viewport: { width: spec.size, height: spec.size },
        deviceScaleFactor: 1,
      });
      // `image-rendering: pixelated` is deliberately NOT used: the glyph is
      // vector, so the browser's own rasteriser gives clean edges at every size,
      // and a nearest-neighbour scale of a 16-unit box would alias badly at 512.
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${BG}">
           <div style="width:${spec.size}px;height:${spec.size}px">
             ${iconSvg(spec.scale).replace(
               'width="16" height="16"',
               `width="${spec.size}" height="${spec.size}"`,
             )}
           </div>
         </body></html>`,
      );
      await page.screenshot({ path: join(OUT, spec.file) });
      console.log(`  → ${join(OUT, spec.file)} (${spec.size}px)`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${ICONS.length} icons + icon.svg → ${OUT}`);
}

void main();
