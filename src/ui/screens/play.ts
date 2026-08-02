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
  let onResize: (() => void) | null = null;
  let quality: Quality = opts.quality;

  return {
    enter(root: HTMLElement): void {
      const game = createGame(opts.level, {
        players: opts.session.players,
        seed: opts.session.seed,
        stageNumber: opts.session.stageNumber,
      });
      const view = createRenderer(opts.canvas, quality);
      const pad = createInput(opts.bindings);
      const panel = createHud(root);
      panel.sync(game);

      const fit = (): void => {
        view.resize(window.innerWidth, window.innerHeight);
      };
      fit();
      window.addEventListener('resize', fit);

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
      onResize = fit;

      // `start()` re-baselines the clock. Calling `tickOnce` by hand would
      // measure dt from the epoch and burn a 10-step catch-up (T2.1 contract).
      driver.start();
    },

    leave(): void {
      loop?.stop();
      if (onResize !== null) {
        window.removeEventListener('resize', onResize);
      }
      input?.dispose();
      hud?.dispose();
      // The renderer goes last: it owns the GL context, and `dispose()` forces
      // a context loss, so nothing that touches the scene may run after it.
      renderer?.dispose();
      loop = null;
      onResize = null;
      input = null;
      hud = null;
      renderer = null;
    },

    setQuality(q: Quality): void {
      quality = q;
      renderer?.setQuality(q);
    },
  };
}
