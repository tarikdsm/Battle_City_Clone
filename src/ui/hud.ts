// src/ui/hud.ts — the in-game HUD (GDD §9, art §10, arch §8).
//
// ## Two halves, and the split is what makes it testable
//
// Everything above `--- The view ---` is **pure**: {@link hudModel} turns a
// `GameState` into the handful of numbers a HUD shows, with no DOM anywhere.
// That is what `tests/ui/hud.test.ts` asserts in the Vitest **node**
// environment, where there is no `document`. Everything below builds markup and
// is verified by screenshot.
//
// ## Two rules it is built around
//
// - **DOM, never canvas.** Anything drawn to the canvas after
//   `renderer.render()` is swallowed by the post chain's composer blit (T2.5),
//   so the HUD is an overlay in `#ui` and never touches the drawing buffer.
// - **Event-driven, not per-frame.** `sync()` is called only on ticks that
//   produced events, and even then it writes a node only when the value it
//   holds actually changed. A HUD that assigned `textContent` 60 times a second
//   would dirty layout every frame for a number that changes a few times a
//   minute (arch §8).
//
// ## Glyphs, not characters
//
// GDD §9 asks for "a grid of mini tank icons" and "lives as tank pips", and art
// §10 for "tier stars" and a "stage flag". Those are **inline SVG**, not font
// characters: a tank glyph has no Unicode code point, and ★/⚑ render as
// whatever the platform emoji font decides — colour on some, monochrome on
// others, and a different width on every one. Three hand-built paths cost
// nothing (they are created once, never per frame) and read identically
// everywhere, which is the point of art §11's grayscale rule.

import { ENEMY_TOTAL } from '../core/constants';
import type { GameState } from '../core/types';

// ---------------------------------------------------------------------------
// --- The model (pure) ------------------------------------------------------
// ---------------------------------------------------------------------------

export interface HudPlayer {
  /** 1 or 2, as the label reads. */
  readonly slot: 1 | 2;
  readonly active: boolean;
  readonly score: number;
  readonly lives: number;
  /** 0…3 (fidelity §3.1's star tiers). */
  readonly tier: 0 | 1 | 2 | 3;
  /** Filled life pips to draw, capped by {@link LIFE_PIPS}. */
  readonly pips: number;
  /** Lives beyond the pips, or 0. Shown as `+n` so a Tank power-up is visible. */
  readonly overflow: number;
}

export interface HudView {
  /** Enemies still to spawn — the queue length, which is GDD §9's icon count. */
  readonly enemiesLeft: number;
  /** One entry per icon, true when that icon has been consumed by a spawn. */
  readonly spent: readonly boolean[];
  /** The number the player is told (fidelity §11.5's looped stage). */
  readonly stage: number;
  readonly players: readonly [HudPlayer, HudPlayer];
}

/**
 * Life pips drawn before the count falls back to `+n`.
 *
 * Three is the start (fidelity §3.1) and the Tank power-up can push it higher;
 * four keeps the common case pictorial without letting a lucky run stretch the
 * dock wide enough to squeeze the board.
 */
export const LIFE_PIPS = 4;

/** Star tiers, 0…3 — how many pips there are to fill. */
export const TIER_PIPS = 3;

function playerOf(state: GameState, index: 0 | 1): HudPlayer {
  const meta = state.players[index];
  // Tank slot index === playerIndex for the whole life of a run, by
  // construction in `createGame` (the spawner only ever recycles a dead slot
  // whose kind is 'enemy'), so this is a lookup and not a search.
  const tier = state.tanks[index]?.tier ?? 0;
  const lives = Math.max(0, meta.lives);
  return {
    slot: (index + 1) as 1 | 2,
    active: meta.active,
    score: meta.score,
    lives,
    tier,
    pips: Math.min(LIFE_PIPS, lives),
    overflow: Math.max(0, lives - LIFE_PIPS),
  };
}

/**
 * The whole HUD as data.
 *
 * `displayStage` exists because after stage 35 the two stage numbers stop being
 * the same one (fidelity §11.5): core's `state.stageNumber` keeps rising so the
 * spawn formula keeps tightening, while the campaign "loops to stage 1" and
 * that is the number a player is told. Defaults to core's, so a caller with no
 * loop to represent passes nothing.
 */
export function hudModel(state: GameState, displayStage?: number): HudView {
  // The QUEUE is the "left to spawn" count: the spawner shifts an entry on the
  // tick it emits `enemySpawnStarted`, which is the event GDD §9 pins the icon
  // grid to. Reading the state rather than counting events keeps the HUD right
  // even if a state is ever restored or re-entered.
  const enemiesLeft = state.spawner.queue.length;
  const spent: boolean[] = new Array<boolean>(ENEMY_TOTAL);
  for (let i = 0; i < ENEMY_TOTAL; i++) {
    spent[i] = i >= enemiesLeft;
  }
  return {
    enemiesLeft,
    spent,
    stage: displayStage ?? state.stageNumber,
    players: [playerOf(state, 0), playerOf(state, 1)],
  };
}

// ---------------------------------------------------------------------------
// --- The view --------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface Hud {
  /** Reflect `state` into the DOM, writing only the nodes that changed. */
  sync(state: GameState, displayStage?: number): void;
  /**
   * Re-dock for the current viewport and report the space the HUD occupies, in
   * CSS pixels. The caller subtracts this from the viewport to get the board
   * area — the HUD is *docked* beside the board (GDD §9, art §10), never
   * painted over it.
   *
   * Landscape reserves on the **right**; portrait reserves at the **top**, per
   * art §10's "slim top bar + bottom control zone" — the bottom belongs to
   * Phase 9's touch controls, so the HUD may not take it.
   *
   * Measured from the live element rather than assumed from a constant: the
   * blocks are text, so a different font or a five-digit score changes the
   * width, and a dock that is one glyph too narrow puts a tank behind the
   * score.
   */
  dock(): { right: number; bottom: number; top: number };
  /** Remove everything this HUD added to the document. */
  dispose(): void;
}

const STYLE_ID = 'bc-hud-style';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The HUD's own stylesheet, in a single `<style>` it owns and removes.
 *
 * It uses `styles.css`'s custom properties rather than literals — one palette,
 * one place — with the token values as fallbacks, so the HUD still reads
 * correctly if it is ever mounted without the app stylesheet.
 */
const CSS = `
.bc-hud {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  /* The overlay must never eat a click meant for the game. */
  pointer-events: none;
  user-select: none;
  font-family: var(--bc-font-body, system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.35;
  color: var(--bc-text, #e8e8e8);
}
/* Landscape: docked right, a column beside the board. */
.bc-hud.landscape {
  top: 0;
  right: 0;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  gap: 1.35rem;
  padding: 1rem 1.15rem;
  min-width: 8.5rem;
}
/* Portrait: a slim bar along the TOP (art §10 — the bottom is the touch zone). */
.bc-hud.portrait {
  left: 0;
  top: 0;
  width: 100%;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.45rem 0.7rem 0.6rem;
  background: linear-gradient(to bottom, rgb(6 7 11 / 92%), rgb(6 7 11 / 0%));
}
.bc-hud-label {
  font-family: var(--bc-font-display, system-ui, sans-serif);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--bc-text-dim, #8b93a7);
}
.bc-hud-value {
  font-family: var(--bc-font-display, system-ui, sans-serif);
  font-size: 20px;
  font-weight: 700;
  /* Art §10: "Tabular numerals for scores." A score that changes width as it
     counts up makes the whole dock jitter, and the dock sizes the board. */
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.bc-hud.portrait .bc-hud-value {
  font-size: 15px;
}

/* --- enemies left to spawn (GDD §9: a 4x5 grid of mini tanks) ------------ */
.bc-hud-icons {
  display: grid;
  grid-template-columns: repeat(4, 10px);
  gap: 3px;
  margin: 0.4rem 0 0.25rem;
}
.bc-hud.portrait .bc-hud-icons {
  grid-template-columns: repeat(10, 8px);
  gap: 2px;
  margin: 0.15rem 0 0;
}
.bc-hud-icon {
  width: 10px;
  height: 10px;
  color: var(--bc-text, #e8e8e8);
  transition:
    color 150ms ease-out,
    opacity 150ms ease-out;
}
.bc-hud.portrait .bc-hud-icon {
  width: 8px;
  height: 8px;
}
/* "dimming as consumed" (art §10) — dimmed, not removed: the grid's SHAPE is
   the readout, so a shrinking grid would lose the "out of twenty" reference. */
.bc-hud-icon.spent {
  color: #2a2f38;
  opacity: 0.55;
}

/* --- per-player card ----------------------------------------------------- */
.bc-hud-player {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.bc-hud-player[hidden] {
  display: none;
}
.bc-hud-player.p1 .bc-hud-label {
  color: var(--bc-p1, #f2c14e);
}
.bc-hud-player.p2 .bc-hud-label {
  color: var(--bc-p2, #7fd695);
}
.bc-hud-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 13px;
}
.bc-hud-pips {
  display: flex;
  gap: 2px;
  align-items: center;
}
.bc-hud-pip {
  width: 11px;
  height: 11px;
}
.bc-hud-player.p1 .bc-hud-pip {
  color: var(--bc-p1, #f2c14e);
}
.bc-hud-player.p2 .bc-hud-pip {
  color: var(--bc-p2, #7fd695);
}
.bc-hud-pip.empty {
  color: #2a2f38;
}
.bc-hud-extra {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--bc-text-dim, #8b93a7);
}
.bc-hud-tier {
  display: flex;
  gap: 1px;
  align-items: center;
  margin-left: 0.25rem;
}
.bc-hud-star {
  width: 11px;
  height: 11px;
  color: var(--bc-gold, #ffd76b);
}
.bc-hud-star.empty {
  color: #2a2f38;
}

/* --- stage flag + number ------------------------------------------------- */
.bc-hud-stage {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.bc-hud-flag {
  width: 15px;
  height: 15px;
  color: var(--bc-gold, #ffd76b);
}
`;

/** A tank seen from above — the same silhouette the board draws (art §4). */
function tankGlyph(className: string): HTMLElement {
  return glyph(
    className,
    'M1.5 3.5h2.6v9H1.5zM11.9 3.5h2.6v9h-2.6zM4.8 4.2h6.4v8.3H4.8zM7.1 0.8h1.8v4.6H7.1z',
  );
}

/** A five-pointed star, for art §10's tier pips. */
function starGlyph(className: string): HTMLElement {
  return glyph(
    className,
    'M8 1l1.9 4.2 4.6.5-3.4 3.1 1 4.5L8 11l-4.1 2.3 1-4.5L1.5 5.7l4.6-.5z',
  );
}

/** A pennant on a pole, for art §10's stage flag. */
function flagGlyph(className: string): HTMLElement {
  return glyph(className, 'M3 1.5h1.6v13H3zM5.2 2.4h8.4l-2 3 2 3H5.2z');
}

function glyph(className: string, d: string): HTMLElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  node.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  // `currentColor` is what lets one path be a live pip, a spent icon and a
  // player-tinted pip without three copies of it.
  path.setAttribute('fill', 'currentColor');
  node.append(path);
  // An `SVGElement` is an `Element` with `classList` and `style`, which is all
  // this file ever asks of it; the cast keeps the node arrays one type.
  return node as unknown as HTMLElement;
}

interface PlayerNodes {
  block: HTMLElement;
  score: HTMLElement;
  pips: HTMLElement[];
  extra: HTMLElement;
  stars: HTMLElement[];
  /** Kept for the e2e/capture selectors, which read lives as a number. */
  lives: HTMLElement;
}

interface Last {
  remaining: number;
  stage: number;
  score: [number, number];
  lives: [number, number];
  tier: [number, number];
  active: [boolean, boolean];
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function playerBlock(index: 0 | 1): PlayerNodes {
  const block = el('section', `bc-hud-player p${index + 1}`);
  block.dataset.hud = `p${index + 1}`;
  block.append(el('div', 'bc-hud-label', `${index + 1}P`));

  const score = el('div', 'bc-hud-value', '0');
  score.dataset.hud = `p${index + 1}-score`;

  const meta = el('div', 'bc-hud-meta');
  const pipRow = el('div', 'bc-hud-pips');
  const pips: HTMLElement[] = [];
  for (let i = 0; i < LIFE_PIPS; i++) {
    const pip = tankGlyph('bc-hud-pip');
    pips.push(pip);
    pipRow.append(pip);
  }
  const extra = el('span', 'bc-hud-extra', '');
  // The numeric lives readout the e2e suite and `capture-play` assert on. Kept
  // in the DOM and out of sight: pips are the *design* (GDD §9), a number is
  // what a test can compare, and dropping it would break both harnesses for a
  // cosmetic reason.
  const lives = el('span', 'bc-hud-extra', '3');
  lives.dataset.hud = `p${index + 1}-lives`;
  lives.hidden = true;

  const tier = el('div', 'bc-hud-tier');
  tier.dataset.hud = `p${index + 1}-tier`;
  const stars: HTMLElement[] = [];
  for (let i = 0; i < TIER_PIPS; i++) {
    const star = starGlyph('bc-hud-star empty');
    stars.push(star);
    tier.append(star);
  }

  meta.append(pipRow, extra, lives, tier);
  block.append(score, meta);
  return { block, score, pips, extra, stars, lives };
}

/**
 * Mounts the HUD into `root` (the screen machine's `#ui` overlay). The caller
 * owns the lifetime: `dispose()` removes both the markup and the stylesheet.
 */
export function createHud(root: HTMLElement): Hud {
  // One <style>, reused if a previous HUD somehow left one behind (it cannot
  // today — `dispose` removes it — but a duplicated rule set is a silent leak).
  const style = document.getElementById(STYLE_ID) ?? el('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  if (style.parentNode === null) {
    document.head.append(style);
  }

  const hud = el('aside', 'bc-hud');
  hud.dataset.hud = 'root';

  // --- enemies left to spawn (GDD §9: decrements on enemySpawnStarted) ---
  const enemyBlock = el('section');
  const icons = el('div', 'bc-hud-icons');
  icons.dataset.hud = 'enemy-icons';
  const iconNodes: HTMLElement[] = [];
  for (let i = 0; i < ENEMY_TOTAL; i++) {
    const icon = tankGlyph('bc-hud-icon');
    iconNodes.push(icon);
    icons.append(icon);
  }
  const enemiesLeft = el('div', 'bc-hud-value', String(ENEMY_TOTAL));
  enemiesLeft.dataset.hud = 'enemies-left';
  enemyBlock.append(el('div', 'bc-hud-label', 'Enemy'), icons, enemiesLeft);

  const players: [PlayerNodes, PlayerNodes] = [playerBlock(0), playerBlock(1)];

  const stageBlock = el('section');
  const stageRow = el('div', 'bc-hud-stage');
  const stage = el('div', 'bc-hud-value', '1');
  stage.dataset.hud = 'stage';
  stageRow.append(flagGlyph('bc-hud-flag'), stage);
  stageBlock.append(el('div', 'bc-hud-label', 'Stage'), stageRow);

  hud.append(enemyBlock, players[0].block, players[1].block, stageBlock);
  root.append(hud);

  // Sentinels no real value can equal, so the first `sync` writes everything
  // exactly once and every later one writes only what moved.
  const last: Last = {
    remaining: -1,
    stage: -1,
    score: [-1, -1],
    lives: [-1, -1],
    tier: [-1, -1],
    active: [true, true],
  };

  return {
    dock(): { right: number; bottom: number; top: number } {
      // Orientation decides the edge. Chosen from the viewport rather than
      // from a media query so the play screen and the HUD can never disagree
      // about which one is in force on the frame that matters.
      const landscape = window.innerWidth >= window.innerHeight;
      hud.classList.toggle('landscape', landscape);
      hud.classList.toggle('portrait', !landscape);
      const box = hud.getBoundingClientRect();
      return landscape
        ? { right: Math.ceil(box.width), bottom: 0, top: 0 }
        : { right: 0, bottom: 0, top: Math.ceil(box.height) };
    },

    sync(state: GameState, displayStage?: number): void {
      const view = hudModel(state, displayStage);

      if (view.enemiesLeft !== last.remaining) {
        // 20 idempotent class toggles, and only on a tick where the count
        // actually changed — i.e. 20 times in a whole stage.
        for (let i = 0; i < ENEMY_TOTAL; i++) {
          iconNodes[i].classList.toggle('spent', view.spent[i]);
        }
        enemiesLeft.textContent = String(view.enemiesLeft);
        last.remaining = view.enemiesLeft;
      }

      if (view.stage !== last.stage) {
        stage.textContent = String(view.stage);
        last.stage = view.stage;
      }

      for (let i = 0; i < players.length; i++) {
        const p = view.players[i];
        const nodes = players[i];
        if (p.active !== last.active[i]) {
          // 1P hides the second block rather than showing a dead player.
          nodes.block.hidden = !p.active;
          last.active[i] = p.active;
        }
        if (!p.active) {
          continue;
        }
        if (p.score !== last.score[i]) {
          nodes.score.textContent = p.score.toLocaleString('en-US');
          last.score[i] = p.score;
        }
        if (p.lives !== last.lives[i]) {
          for (let j = 0; j < nodes.pips.length; j++) {
            nodes.pips[j].classList.toggle('empty', j >= p.pips);
          }
          // `+n` only when a Tank power-up has pushed the count past the pips.
          nodes.extra.textContent = p.overflow > 0 ? `+${p.overflow}` : '';
          nodes.lives.textContent = String(p.lives);
          last.lives[i] = p.lives;
        }
        if (p.tier !== last.tier[i]) {
          for (let j = 0; j < nodes.stars.length; j++) {
            nodes.stars[j].classList.toggle('empty', j >= p.tier);
          }
          last.tier[i] = p.tier;
        }
      }
    },

    dispose(): void {
      hud.remove();
      style.remove();
    },
  };
}
