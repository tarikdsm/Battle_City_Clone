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
//
// ## T6.2: one screen, many stages, and an attract run
//
// A run is 35 stages, and each is a fresh `GameState`. `start()` rebuilds the
// simulation in place rather than the screen machine re-entering the screen,
// because `leave()` disposes the GL context and a campaign would then create
// and destroy one per stage.
//
// The same screen also runs the title's diorama: `attract` mode builds
// everything except the HUD and the input, so GDD §5's "subtle attract camera
// drift over a diorama" is a real board with real tanks on it rather than a
// still image — and no key press can reach the simulation behind the title.
//
// ## What this screen does NOT decide
//
// Pause, phases, scoring and lives are core's (fidelity §11–§13). This screen
// *reports* them — `onStageCleared`, `onGameOver`, `onPauseChanged` — and the
// campaign flow in `main.ts` decides which screen answers. The one thing it
// writes back is a single tick of pause intent, which goes through the same
// edge detector a real key press does.

import { createGame, stepGame } from '../../core/game';
import { STAGE_CLEAR_S } from '../../core/constants';
import type { GameEvent } from '../../core/events';
import type { GameState, LevelData, PlayerIntent } from '../../core/types';
import type { AudioSystem } from '../../audio/audio';
import { createLoop, type Loop } from '../../app/loop';
import type { Screen } from '../../app/screens';
import { applyCarry, levelStageOf, type Session } from '../../app/session';
import type { SettingsV1 } from '../../app/storage';
import { createInput, type InputSystem } from '../../input/input';
import { sharedGamepads } from '../../input/gamepad';
import {
  createTouchControls,
  isTouchDevice,
  type TouchControls,
} from '../../input/touch';
import { concreteQuality } from '../../render/post';
import {
  createRenderer,
  type Quality,
  type Renderer,
} from '../../render/renderer';
import { createHud, type Hud } from '../hud';
import { bindingsFor, fxFlagsFor, volumesFor } from './settings';

/** What one visit to the board is: a run's state plus the stage to play. */
export interface PlayRun {
  session: Session;
  level: LevelData;
  /** No HUD, no input — the live diorama behind the title screen. */
  attract?: boolean;
}

export interface PlayScreen extends Screen {
  /**
   * Switch the render preset without rebuilding anything. This is what lets the
   * auto-quality probe sample a **drawing** frame and then act on the answer —
   * see `main.ts`.
   */
  setQuality(q: Quality): void;
  /** Rebuild the simulation for a new stage, keeping the GL context alive. */
  start(run: PlayRun): void;
  /** Inject one tick of pause intent — the same edge a key press produces. */
  togglePause(): void;
  /**
   * Stop the pad reaching the simulation, without tearing the input layer down.
   *
   * The bug this exists for, found by `npm run capture:ui`: a modal overlay and
   * the input layer are **both** window `keydown` listeners, so one Escape was
   * consumed twice — it closed the settings panel *and* unpaused the game, and
   * which of the two you got depended on whether a 60 Hz tick happened to land
   * inside the press. Suspending is what makes an overlay's keys the overlay's
   * alone. The keyboard driver keeps tracking held keys, so a key held across
   * the suspension and released outside it is still accounted for.
   *
   * `togglePause` deliberately still works while suspended: it is the app's own
   * injection, not the pad's, and it is how the pause menu resumes.
   */
  setInputSuspended(suspended: boolean): void;
  /** The live state, or `null` between `leave` and the next `enter`. */
  state(): GameState | null;
  /** Push changed settings at the audio, render and input layers. */
  applySettings(s: SettingsV1): void;
}

export interface PlayScreenOptions {
  canvas: HTMLCanvasElement;
  /** The preset to start on. `setQuality` may move it once the probe lands. */
  quality: Quality;
  /**
   * The app's single audio system. Injected rather than created here because an
   * `AudioContext` is a scarce process-wide resource and a campaign visits this
   * screen once per stage — one context per stage would exhaust the browser's
   * cap in a long run, and the menus need the same one for their SFX.
   */
  audio: AudioSystem;
  /** The live settings, read at every (re)start. */
  settings(): SettingsV1;
  /** `prefers-reduced-motion`, read once by the composition root. */
  reducedMotion: boolean;
  onPauseChanged?(paused: boolean): void;
  /** Fidelity §11.2: the 20th enemy died and the 2 s beat has elapsed. */
  onStageCleared?(state: GameState): void;
  /** Fidelity §11.3/§11.4: the run is over. */
  onGameOver?(state: GameState): void;
}

export function createPlayScreen(opts: PlayScreenOptions): PlayScreen {
  // Everything below is built in `enter` and released in `leave`; `null` between
  // the two is what makes a stray `setQuality` or resize after teardown a no-op
  // instead of a crash on a disposed GL context.
  let renderer: Renderer | null = null;
  let input: InputSystem | null = null;
  let touch: TouchControls | null = null;
  let hud: Hud | null = null;
  let loop: Loop | null = null;
  let observer: ResizeObserver | null = null;
  let game: GameState | null = null;
  let quality: Quality = opts.quality;
  let root: HTMLElement | null = null;
  let run: PlayRun | null = null;
  /** One-tick synthetic pause press, set by `togglePause`. */
  let injectPause = false;
  /** While true the pad is polled but ignored — see `setInputSuspended`. */
  let inputSuspended = false;
  /** So the two terminal callbacks fire once each per stage, not per tick. */
  let reported = false;
  let lastPaused = false;

  function teardownRun(): void {
    loop?.stop();
    observer?.disconnect();
    input?.dispose();
    touch?.dispose();
    hud?.dispose();
    // The renderer goes last: it owns the GL context and every GPU resource
    // hanging off it, so nothing that touches the scene may run after it.
    //
    // **It does NOT force a context loss** — an earlier revision of this
    // comment said it did, and three 0.185.1's `WebGLRenderer.dispose()` is
    // right there in `three.module.js` doing no such thing (it drops caches and
    // listeners; `forceContextLoss()` is a separate method nothing here calls).
    // Nothing leaks, and the reason is worth knowing before somebody "fixes" it:
    // a canvas has exactly ONE context for its whole life, so the next
    // `new WebGLRenderer({ canvas })` re-acquires the same one rather than
    // opening a second. That is what makes a 35-stage campaign — one
    // build/teardown per stage — cost zero contexts.
    renderer?.dispose();
    loop = null;
    observer = null;
    input = null;
    touch = null;
    hud = null;
    renderer = null;
    game = null;
    delete opts.canvas.dataset.bcMounted;
  }

  function leave(): void {
    teardownRun();
    // The audio system is NOT disposed: it is the app's, not this screen's, and
    // the menus keep using it. Music is stopped so a torn-down stage does not
    // keep playing under the title.
    opts.audio.stopMusic();
    root = null;
    run = null;
  }

  function build(next: PlayRun): void {
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
      teardownRun(); // re-entry / next stage: rebuild rather than stack a second stack
    }
    if (opts.canvas.dataset.bcMounted === '1') {
      throw new Error(
        'canvas#game already has a mounted play screen — refusing to run two renderers on one canvas',
      );
    }
    opts.canvas.dataset.bcMounted = '1';

    const mount = root;
    if (mount === null) {
      throw new Error('play screen started before it was entered');
    }
    run = next;
    reported = false;
    injectPause = false;
    inputSuspended = false;
    lastPaused = false;

    const settings = opts.settings();
    // The RISING internal counter reaches core (fidelity §11.5): the spawn
    // formula's own cap at 35 lives in `spawnIntervalTicks`, so capping it here
    // would make stage 36 play like stage 1.
    const state = createGame(next.level, {
      players: next.session.players,
      seed: next.session.seed,
      stageNumber: next.session.stageNumber,
    });
    // Fidelity §12's carryover: lives, score and the bonus-life threshold from
    // the stage that just ended. Written before the first tick — this is
    // construction, which arch §2 gives to `app/`, not presentation feedback.
    applyCarry(state, next.session);

    const view = createRenderer(opts.canvas, quality);
    // Art §11: every accessibility switch reaches the render layer through this
    // one object — screen shake, flash reduction and high contrast alike. The
    // render layer cannot read any of them itself (`render/` may not import
    // `app/`, arch §2), so the screen that owns both hands them down.
    view.setFxFlags(fxFlagsFor(settings, opts.reducedMotion));

    // Audio §2: the context is built **suspended** and only ever resumed from a
    // real user gesture. The input layer is where the game's gestures already
    // land, so `resume` rides in on the existing `keydown` listener rather than
    // on a second one of its own (see `createInput`).
    opts.audio.setVolumes(volumesFor(settings));

    // GDD §7's touch column, on touch devices only. Built before the input
    // system because it is one of its sources, and mounted into the same
    // overlay root the HUD uses so `leave()` cannot leave it behind.
    const glass =
      next.attract === true || !isTouchDevice(window)
        ? null
        : createTouchControls(mount, {
            onUserGesture: () => {
              opts.audio.resume();
            },
          });
    touch = glass;

    // GDD §7's four devices, merged behind one `PlayerIntent` pair. The gamepad
    // hub is the app's, not this screen's (`sharedGamepads`) — hot-plug
    // assignment has to survive a stage change, and a campaign rebuilds this
    // screen once per stage.
    const pad =
      next.attract === true
        ? null
        : createInput(
            bindingsFor(settings),
            undefined,
            () => {
              opts.audio.resume();
            },
            glass === null
              ? [sharedGamepads()]
              : [sharedGamepads(), glass.source],
          );
    const panel = next.attract === true ? null : createHud(mount);
    panel?.sync(state, levelStageOf(next.session.stageNumber));

    // The board area is the viewport MINUS whatever the HUD docks, so the
    // two never overlap at any size or orientation. `dock()` re-docks for the
    // current orientation and measures the live element, so a longer score or
    // a different font widens the reservation instead of covering the board.
    let lastW = -1;
    let lastH = -1;
    let lastTop = -1;
    const fit = (): void => {
      const reserved = panel?.dock() ?? { right: 0, bottom: 0, top: 0 };
      // The touch strip is inset by whatever the HUD already took, so the two
      // docks are disjoint boxes and the strip is exactly as wide as the board.
      const glassDock = glass?.dock(reserved.right) ?? { bottom: 0 };
      const w = Math.max(1, Math.floor(window.innerWidth - reserved.right));
      const h = Math.max(
        1,
        Math.floor(
          window.innerHeight -
            reserved.bottom -
            reserved.top -
            glassDock.bottom,
        ),
      );
      // Idempotent: `setSize` writes the canvas's inline style, which the
      // observer below sees as a resize. Without this the two would ping-pong
      // forever at one frame per bounce.
      if (w === lastW && h === lastH && reserved.top === lastTop) {
        return;
      }
      lastW = w;
      lastH = h;
      lastTop = reserved.top;
      // Art §10 docks the portrait HUD along the TOP (the bottom is Phase 9's
      // touch zone), so the board has to start below it. `index.html` pins the
      // canvas at `top: 0`; this is the only thing that ever moves it, and it
      // is written before `resize` so the two land in one layout pass.
      opts.canvas.style.top = `${reserved.top}px`;
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
      frame(): void {
        // The polled devices, once per frame — see `LoopCallbacks.frame`. The
        // attract board has no input at all, so there is nothing to sample.
        input?.sample();
      },
      step(): void {
        // One poll per tick — the turbo pulse is counted in ticks, so polling
        // per frame instead would make the autofire rate frame-rate dependent.
        // Polled even while suspended, so the driver's held-key set and its
        // turbo phase stay honest; the RESULT is what is dropped.
        //
        // Read through the `input` BINDING, never through the `pad` const above
        // (fixed at T9.1). `applySettings` replaces the driver whenever any
        // setting changes mid-run — the map is snapshotted at construction — so
        // a loop that closed over the original object kept polling a **disposed**
        // driver, which reports neutral for ever. Nudging the volume from the
        // pause menu made the game uncontrollable, and nothing caught it because
        // no harness plays on after touching a setting.
        const polled: readonly [PlayerIntent, PlayerIntent] =
          input?.poll() ?? IDLE_INTENTS;
        const intents = inputSuspended ? SUSPENDED_INTENTS : polled;
        if (injectPause) {
          // A single tick of "the pause button is down", so core's own edge
          // detector does the toggle. Writing `state.paused` directly would
          // bypass `pauseHeld` and desynchronise the next real key press.
          intents[0].pause = true;
          injectPause = false;
        }
        stepGame(state, intents);

        const events: GameEvent[] = state.events;
        for (let i = 0; i < events.length; i++) {
          view.onEvent(events[i]);
          // The audio layer is a peer of the renderer, not a client of it:
          // same event stream, same read-only contract, same frame.
          opts.audio.onEvent(events[i]);
        }
        if (events.length > 0) {
          // The HUD is synced from the state, not from the events, but only on
          // a tick that produced some: that is what makes it event-driven
          // without having to derive lives/score/tier from an event stream.
          panel?.sync(state, levelStageOf(next.session.stageNumber));
        }

        if (state.paused !== lastPaused) {
          lastPaused = state.paused;
          opts.onPauseChanged?.(state.paused);
        }
        if (next.attract === true || reported) {
          return;
        }
        // Fidelity §11.2: "20th enemy destroyed → 2 s beat → tally screen". The
        // beat is measured in SIMULATION time (`phaseT`), not by a timer, so a
        // pause during it freezes it exactly like everything else.
        if (state.phase === 'cleared' && state.phaseT >= STAGE_CLEAR_S) {
          reported = true;
          opts.onStageCleared?.(state);
        } else if (state.phase === 'gameOver') {
          // No extra beat here: the base-lost path already spent core's
          // GAME_OVER_DELAY_S in `baseLost`, and the out-of-lives path only
          // reaches this phase once the last respawn timer has run out.
          reported = true;
          opts.onGameOver?.(state);
        }
      },
      render(alpha: number, dtMs: number): void {
        view.render(state, alpha, dtMs);
        // The sustained sounds — engine hums, shield hum, ice whoosh, the
        // power-up sparkle, the clock's tick-tock — are *state*, not events,
        // so they are driven from the frame like the renderer is. `dtMs` is
        // the loop's real frame time, deliberately unscaled: art §2's slow-mo
        // dilates the picture, not the pitch of the sound.
        opts.audio.update(state, dtMs);
      },
      isPaused(): boolean {
        return state.paused;
      },
    });

    renderer = view;
    input = pad;
    hud = panel;
    loop = driver;
    observer = ro;
    game = state;

    // `start()` re-baselines the clock. Calling `tickOnce` by hand would
    // measure dt from the epoch and burn a 10-step catch-up (T2.1 contract).
    driver.start();
  }

  return {
    enter(mount: HTMLElement, params?: unknown): void {
      root = mount;
      const next = params as PlayRun | undefined;
      if (next === undefined) {
        throw new Error('play screen entered without a run');
      }
      build(next);
    },

    leave,

    start(next: PlayRun): void {
      build(next);
    },

    setQuality(q: Quality): void {
      quality = q;
      renderer?.setQuality(q);
    },

    togglePause(): void {
      injectPause = true;
    },

    setInputSuspended(suspended: boolean): void {
      inputSuspended = suspended;
    },

    state(): GameState | null {
      return game;
    },

    applySettings(s: SettingsV1): void {
      opts.audio.setVolumes(volumesFor(s));
      renderer?.setFxFlags(fxFlagsFor(s, opts.reducedMotion));
      const settled = concreteQuality(s.quality, undefined);
      if (settled !== null) {
        quality = settled;
        renderer?.setQuality(settled);
      }
      // Rebinding mid-run: the keyboard driver snapshots its map at
      // construction (`createKeyboard`), so a new map means a new driver.
      if (input !== null && run !== null && run.attract !== true) {
        input.dispose();
        const glass = touch;
        input = createInput(
          bindingsFor(s),
          undefined,
          () => {
            opts.audio.resume();
          },
          glass === null
            ? [sharedGamepads()]
            : [sharedGamepads(), glass.source],
        );
      }
    },
  };
}

/** The pad an attract run does not have. */
const IDLE_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  { dir: null, fire: false, pause: false },
  { dir: null, fire: false, pause: false },
];

/**
 * What the simulation sees while the pad is suspended. A SECOND pair, not
 * `IDLE_INTENTS` reused: `togglePause` writes `pause` into whichever tuple is
 * live for exactly one tick, and sharing one object between the attract board
 * and a suspended run would let that write leak across them.
 */
const SUSPENDED_INTENTS: readonly [PlayerIntent, PlayerIntent] = [
  { dir: null, fire: false, pause: false },
  { dir: null, fire: false, pause: false },
];
