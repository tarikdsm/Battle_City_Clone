// src/ui/hud.ts — the minimal in-game HUD (GDD §9, arch §8).
//
// Scope is deliberately T3.2's: enemies left to spawn, per-player lives / score
// / tier, stage number. The full treatment (art §10, fonts, score popups) is
// T6.3 — this exists so the first playable tells you what is happening.
//
// Two rules it is built around:
//
// - **DOM, never canvas.** Anything drawn to the canvas after
//   `renderer.render()` is swallowed by the post chain's composer blit (T2.5),
//   so the HUD is an overlay in `#ui` and never touches the drawing buffer.
// - **Event-driven, not per-frame.** `sync()` is called only on ticks that
//   produced events, and even then it writes a node only when the value it
//   holds actually changed. A HUD that assigned `textContent` 60 times a second
//   would dirty layout every frame for a number that changes a few times a
//   minute (arch §8).

import { ENEMY_TOTAL } from '../core/constants';
import type { GameState } from '../core/types';

export interface Hud {
  /**
   * Reflect `state` into the DOM, writing only the nodes that changed.
   *
   * `displayStage` exists because after stage 35 the two stage numbers stop
   * being the same one (fidelity §11.5): core's `state.stageNumber` keeps
   * rising so the spawn formula keeps tightening, while the campaign "loops to
   * stage 1" and that is the number a player is told. Defaults to the core's,
   * so a caller with no loop to represent passes nothing.
   */
  sync(state: GameState, displayStage?: number): void;
  /**
   * Re-dock for the current viewport and report the space the HUD occupies, in
   * CSS pixels. The caller subtracts this from the viewport to get the board
   * area — the HUD is *docked* beside the board (GDD §9, art §10), never
   * painted over it.
   *
   * Measured from the live element rather than assumed from a constant: the
   * blocks are text, so a different font or a five-digit score changes the
   * width, and a dock that is one glyph too narrow puts a tank behind the
   * word LIVES.
   */
  dock(): { right: number; bottom: number };
  /** Remove everything this HUD added to the document. */
  dispose(): void;
}

/** Star pips for tiers 0..3 (GDD §9). */
const TIER_PIPS: readonly string[] = ['—', '★', '★★', '★★★'];

const STYLE_ID = 'bc-hud-style';

// Placeholder styling, in a single <style> the HUD owns and removes. T6.3
// replaces this with the real stylesheet and CSS custom properties; the palette
// here follows art §3's UI foreground over the near-black board so the first
// playable does not read as a debug overlay.
const CSS = `
.bc-hud {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  /* The overlay must never eat a click meant for the game. */
  pointer-events: none;
  user-select: none;
  font: 13px/1.35 ui-monospace, "Cascadia Mono", "Courier New", monospace;
  letter-spacing: 0.06em;
  color: #e8e8e8;
}
/* Landscape: docked right, a column beside the board. */
.bc-hud.landscape {
  top: 0;
  right: 0;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  gap: 1.5rem;
  padding: 1rem 1.25rem;
  min-width: 7.5rem;
}
/* Portrait: docked bottom, a row under the board (GDD §9). */
.bc-hud.portrait {
  left: 0;
  bottom: 0;
  width: 100%;
  flex-direction: row;
  align-items: center;
  justify-content: space-around;
  gap: 1rem;
  padding: 0.75rem 1rem;
}
.bc-hud.portrait .bc-hud-icons {
  grid-template-columns: repeat(10, 8px);
}
.bc-hud-label {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: #7f8996;
}
.bc-hud-value {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.bc-hud-icons {
  display: grid;
  grid-template-columns: repeat(4, 8px);
  gap: 3px;
  margin: 0.4rem 0 0.2rem;
}
.bc-hud-icon {
  width: 8px;
  height: 8px;
  background: #d8d8d8;
  border-radius: 1px;
}
.bc-hud-icon.spent {
  background: #2a2f38;
}
.bc-hud-tier {
  color: #ffd76b;
}
.bc-hud-player[hidden] {
  display: none;
}
`;

interface PlayerNodes {
  block: HTMLElement;
  score: HTMLElement;
  lives: HTMLElement;
  tier: HTMLElement;
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
  const block = el('section', 'bc-hud-player');
  block.dataset.hud = `p${index + 1}`;
  block.append(el('div', 'bc-hud-label', `${index + 1}P`));

  const score = el('div', 'bc-hud-value', '0');
  score.dataset.hud = `p${index + 1}-score`;

  const lives = el('span', undefined, '3');
  lives.dataset.hud = `p${index + 1}-lives`;
  const tier = el('span', 'bc-hud-tier', TIER_PIPS[0]);
  tier.dataset.hud = `p${index + 1}-tier`;

  const meta = el('div');
  meta.append(
    document.createTextNode('LIVES '),
    lives,
    document.createTextNode('  '),
    tier,
  );

  block.append(score, meta);
  return { block, score, lives, tier };
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
    const icon = el('div', 'bc-hud-icon');
    iconNodes.push(icon);
    icons.append(icon);
  }
  const enemiesLeft = el('div', 'bc-hud-value', String(ENEMY_TOTAL));
  enemiesLeft.dataset.hud = 'enemies-left';
  enemyBlock.append(el('div', 'bc-hud-label', 'ENEMY'), icons, enemiesLeft);

  const players: [PlayerNodes, PlayerNodes] = [playerBlock(0), playerBlock(1)];

  const stageBlock = el('section');
  const stage = el('div', 'bc-hud-value', '1');
  stage.dataset.hud = 'stage';
  stageBlock.append(el('div', 'bc-hud-label', 'STAGE'), stage);

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
    dock(): { right: number; bottom: number } {
      // Orientation decides the edge. Chosen from the viewport rather than
      // from a media query so the play screen and the HUD can never disagree
      // about which one is in force on the frame that matters.
      const landscape = window.innerWidth >= window.innerHeight;
      hud.classList.toggle('landscape', landscape);
      hud.classList.toggle('portrait', !landscape);
      const box = hud.getBoundingClientRect();
      return landscape
        ? { right: Math.ceil(box.width), bottom: 0 }
        : { right: 0, bottom: Math.ceil(box.height) };
    },

    sync(state: GameState, displayStage?: number): void {
      // The queue IS the "left to spawn" count: the spawner shifts an entry on
      // the tick it emits `enemySpawnStarted`, which is the event GDD §9 pins
      // the icon grid to. Reading the state rather than counting events keeps
      // the HUD right even if a state is ever restored or re-entered.
      const remaining = state.spawner.queue.length;
      if (remaining !== last.remaining) {
        // 20 idempotent class toggles, and only on a tick where the count
        // actually changed — i.e. 20 times in a whole stage.
        for (let i = 0; i < ENEMY_TOTAL; i++) {
          iconNodes[i].classList.toggle('spent', i >= remaining);
        }
        enemiesLeft.textContent = String(remaining);
        last.remaining = remaining;
      }

      const shown = displayStage ?? state.stageNumber;
      if (shown !== last.stage) {
        stage.textContent = String(shown);
        last.stage = shown;
      }

      for (let i = 0; i < players.length; i++) {
        const meta = state.players[i];
        const nodes = players[i];
        if (meta.active !== last.active[i]) {
          // 1P hides the second block rather than showing a dead player.
          nodes.block.hidden = !meta.active;
          last.active[i] = meta.active;
        }
        if (!meta.active) {
          continue;
        }
        if (meta.score !== last.score[i]) {
          nodes.score.textContent = String(meta.score);
          last.score[i] = meta.score;
        }
        if (meta.lives !== last.lives[i]) {
          nodes.lives.textContent = String(meta.lives);
          last.lives[i] = meta.lives;
        }
        // Tank slot index === playerIndex for the whole life of a run, by
        // construction in `createGame` (the spawner only ever recycles a dead
        // slot whose kind is 'enemy').
        const tier = state.tanks[i].tier;
        if (tier !== last.tier[i]) {
          nodes.tier.textContent = TIER_PIPS[tier];
          last.tier[i] = tier;
        }
      }
    },

    dispose(): void {
      hud.remove();
      style.remove();
    },
  };
}
