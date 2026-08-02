// src/ui/screens/play.ts — the screen the game is actually played on (arch §8).
//
// It is the one place where all five layers meet: it owns the `GameState`, the
// input system, the renderer, the HUD and the fixed-timestep loop, and it
// disposes every one of them on `leave()`. Nothing above it knows that three.js
// exists; nothing below it knows there is a screen machine.
//
// The wiring order inside `step()` is a contract, not a preference:
//
//   poll → stepGame → drain state.events → (render, later, from the loop)
//
// `stepGame` clears `state.events` at the top of the NEXT tick (arch §3.1), so
// the drain has to happen inside the same `step()` that produced them. Deferring
// it to render time loses a whole tick's events whenever the loop catches up two
// steps in one frame — which is exactly when a lot is being shot.

import { createGame, stepGame } from '../../core/game';
import type { GameEvent } from '../../core/events';
import type { LevelData } from '../../core/types';
import { createLoop, type Loop } from '../../app/loop';
import type { Screen } from '../../app/screens';
import type { Session } from '../../app/session';
import { createInput, type InputSystem } from '../../input/input';
import type { Bindings } from '../../input/keyboard';
import {
  createRenderer,
  type Quality,
  type Renderer,
} from '../../render/renderer';
import { createHud, type Hud } from '../hud';

export interface PlayScreen extends Screen {
  /**
   * Switch the render preset without rebuilding anything. This is what lets the
   * auto-quality probe sample a **drawing** frame and then act on the answer —
   * see `main.ts`.
   */
  setQuality(q: Quality): void;
}

export interface PlayScreenOptions {
  canvas: HTMLCanvasElement;
  level: LevelData;
  session: Session;
  /** The preset to start on. `setQuality` may move it once the probe lands. */
  quality: Quality;
  /** Defaults to `DEFAULT_BINDINGS` inside the input layer. */
  bindings?: Bindings;
}

export function createPlayScreen(opts: PlayScreenOptions): PlayScreen {
  // Everything below is built in `enter` and released in `leave`; `null` between
  // the two is what makes a stray `setQuality` or resize after teardown a no-op
  // instead of a crash on a disposed GL context.
  let renderer: Renderer | null = null;
  let input: InputSystem | null = null;
  let hud: Hud | null = null;
  let loop: Loop | null = null;
  let observer: ResizeObserver | null = null;
  let quality: Quality = opts.quality;

  function leave(): void {
    loop?.stop();
    observer?.disconnect();
    input?.dispose();
    hud?.dispose();
    // The renderer goes last: it owns the GL context, and `dispose()` forces a
    // context loss, so nothing that touches the scene may run after it.
    renderer?.dispose();
    loop = null;
    observer = null;
    input = null;
    hud = null;
    renderer = null;
    delete opts.canvas.dataset.bcMounted;
  }

  return {
    enter(root: HTMLElement): void {
      // Two renderers on one canvas is not a cosmetic problem: three answers
      // `getDrawingBufferSize()` from its OWN `_width × _pixelRatio`, not from
      // the canvas, so the loser's post chain copies the real framebuffer into
      // a beauty texture of a different size and the composer blits the board
      // small and off-centre — while `canvas.width`, the drawing buffer and the
      // GL viewport all still read correct. Measured: a second renderer at a
      // different DPR cap moved the board's content box from (277,56) to
      // (935,0). Both loops also step the simulation, so every duration in the
      // fidelity spec halves.
      //
      // The dataset flag lives on the ELEMENT, so it is shared even between two
      // evaluations of this module (an HMR double-eval, a stray second script
      // tag) where a module-scope guard would not be.
      if (renderer !== null) {
        leave(); // re-entry: rebuild rather than stack a second stack
      }
      if (opts.canvas.dataset.bcMounted === '1') {
        throw new Error(
          'canvas#game already has a mounted play screen — refusing to run two renderers on one canvas',
        );
      }
      opts.canvas.dataset.bcMounted = '1';

      const game = createGame(opts.level, {
        players: opts.session.players,
        seed: opts.session.seed,
        stageNumber: opts.session.stageNumber,
      });
      const view = createRenderer(opts.canvas, quality);
      const pad = createInput(opts.bindings);
      const panel = createHud(root);
      panel.sync(game);

      // The board area is the viewport MINUS whatever the HUD docks, so the
      // two never overlap at any size or orientation. `dock()` re-docks for the
      // current orientation and measures the live element, so a longer score or
      // a different font widens the reservation instead of covering the board.
      let lastW = -1;
      let lastH = -1;
      const fit = (): void => {
        const reserved = panel.dock();
        const w = Math.max(1, Math.floor(window.innerWidth - reserved.right));
        const h = Math.max(1, Math.floor(window.innerHeight - reserved.bottom));
        // Idempotent: `setSize` writes the canvas's inline style, which the
        // observer below sees as a resize. Without this the two would ping-pong
        // forever at one frame per bounce.
        if (w === lastW && h === lastH) {
          return;
        }
        lastW = w;
        lastH = h;
        view.resize(w, h);
      };
      fit();

      // A ResizeObserver on the document element, not a `window.resize`
      // listener. `resize` only fires for the WINDOW, so any host that changes
      // the layout box without resizing the window — a devtools dock, a split
      // pane, an embedding iframe, a zoom change — leaves the renderer sized
      // for a viewport that no longer exists, and dispatching a synthetic
      // `resize` cannot fix it because `innerWidth` was never the thing that
      // moved. The observer watches the box itself, so it fires for all of
      // them, including the initial layout.
      const ro = new ResizeObserver(() => {
        fit();
      });
      ro.observe(document.documentElement);

      const driver = createLoop({
        step(): void {
          // One poll per tick — the turbo pulse is counted in ticks, so polling
          // per frame instead would make the autofire rate frame-rate dependent.
          stepGame(game, pad.poll());

          const events: GameEvent[] = game.events;
          if (events.length === 0) {
            return;
          }
          for (let i = 0; i < events.length; i++) {
            view.onEvent(events[i]);
          }
          // The HUD is synced from the state, not from the events, but only on
          // a tick that produced some: that is what makes it event-driven
          // without having to derive lives/score/tier from an event stream.
          panel.sync(game);
        },
        render(alpha: number, dtMs: number): void {
          view.render(game, alpha, dtMs);
        },
        isPaused(): boolean {
          return game.paused;
        },
      });

      renderer = view;
      input = pad;
      hud = panel;
      loop = driver;
      observer = ro;

      // `start()` re-baselines the clock. Calling `tickOnce` by hand would
      // measure dt from the epoch and burn a 10-step catch-up (T2.1 contract).
      driver.start();
    },

    leave,

    setQuality(q: Quality): void {
      quality = q;
      renderer?.setQuality(q);
    },
  };
}
