// src/input/latch.ts — the per-player input state every source shares (arch §7).
//
// GDD §7 gives one job to four devices, and arch §7 says their output is
// "uniform: `PlayerIntent` per player per tick". That uniformity is not a
// convention anybody can be trusted to re-implement three times — the three
// rules below are all feel-critical, all invisible from the type, and all were
// found the hard way by the keyboard driver (T6.1/T6.2/T6.3). So they live here
// once, and `keyboard.ts`, `gamepad.ts` and `touch.ts` are three ways of
// producing *edges* that feed the same state machine.
//
// 1. **The 4-way latch.** Battle City has no diagonals, and the NES resolves a
//    two-direction hold as "the most recent press wins, and releasing it falls
//    back to whatever is still held". That is a *stack*, not a bitmask and not a
//    priority order — and it is what makes the standard move work: hold a
//    direction, tap another to peek down a corridor, release, keep going. The
//    stack does not care whether the two presses came from the same device, so
//    a stick and a D-pad latch against each other exactly as two keys do.
//
// 2. **The turbo pulse.** Fire is reported as a level and the core fires on the
//    press EDGE (fidelity §5.1), so a plain held level would fire exactly once
//    per hold. Autofire is therefore an input-layer job: the level is *pulsed*
//    at 10 Hz so the core's edge detector sees repeated presses, capped at what
//    a human mashing the button achieves on the NES. The period is counted in
//    TICKS, not milliseconds, because `drain()` is called once per simulation
//    tick — so the shot rate is identical on a 30 fps laptop and a 144 Hz
//    monitor, which a wall-clock pulse would not be.
//
// 3. **The press latch.** Every value below is a LEVEL sampled once per tick,
//    and a level has one failure mode: a button that goes down and up *between*
//    two polls was never down as far as the simulation is concerned. A 60 Hz
//    tick is 16.7 ms, and a fast tap is not much longer — so a press is latched
//    the moment it arrives and held until the next `drain()` reports it. For the
//    keyboard the edge is a DOM event; for the gamepad it is a frame sample, and
//    a 144 Hz display samples more than twice per tick. Both need this.

import type { Dir, PlayerIntent } from '../core/types';

/** Autofire rate while the fire button is held (fidelity §5.1). */
export const TURBO_HZ = 10;

/**
 * The turbo period in simulation ticks. 60 Hz / 10 Hz = 6, i.e. one pulse then
 * five released ticks. Written as a literal rather than derived from `TICK_S`
 * because arch §2 scopes `input/` to core *types*; `tests/input/keyboard.test.ts`
 * imports `TICK_S` and pins the arithmetic, so the two cannot drift silently.
 */
export const TURBO_PERIOD_TICKS = 6;

/**
 * One player's held-input state, fed by edges and drained once per tick.
 *
 * Every method is an *edge*, not a level: `pressDir`/`releaseDir` must be
 * balanced, which is what lets two devices (or two keys) hold the same
 * direction without one release clearing both.
 */
export interface InputPad {
  /** A direction went down. It becomes the latched direction. */
  pressDir(dir: Dir): void;
  /** A direction came up. The latch falls back to whatever is still held. */
  releaseDir(dir: Dir): void;
  /**
   * A *polled* direction source moved. `from` is released and `to` pressed, in
   * that order, which is what makes a stick swing read as a swing rather than
   * as a second direction being added to the stack.
   */
  moveDir(from: Dir | null, to: Dir | null): void;
  pressFire(): void;
  releaseFire(): void;
  pressPause(): void;
  releasePause(): void;
  /** Forget everything held, including the latches. Focus loss, disconnect. */
  reset(): void;
  /** Write the intent for the tick that is about to run, and clear the latches. */
  drain(out: PlayerIntent): void;
}

export function createPad(): InputPad {
  /** Held directions, oldest first — the LAST entry is the latched one. */
  const stack: Dir[] = [];
  /** How many sources are holding fire (two keys, a key and a pad, …). */
  let fireHeld = 0;
  let pauseHeld = 0;
  /** Ticks left before the next turbo pulse; 0 = the next drain fires. */
  let turbo = 0;
  // --- the press latches (rule 3) ------------------------------------------
  // Each records "a press arrived since the last drain", and each is cleared BY
  // that drain. They only ever change the answer when the matching level is
  // already back to zero — i.e. exactly the sub-tick tap that would vanish.
  let tapDir: Dir | null = null;
  let firePressed = false;
  let pausePressed = false;

  // Closures, not methods calling `this`: a caller is allowed to destructure
  // (`const { drain } = pad`), and a `this`-dependent `moveDir` would throw the
  // first time somebody did.
  const pressDir = (dir: Dir): void => {
    stack.push(dir);
    tapDir = dir;
  };

  const releaseDir = (dir: Dir): void => {
    const i = stack.lastIndexOf(dir);
    if (i >= 0) {
      stack.splice(i, 1);
    }
  };

  return {
    pressDir,
    releaseDir,

    moveDir(from: Dir | null, to: Dir | null): void {
      if (from === to) {
        return;
      }
      if (from !== null) {
        releaseDir(from);
      }
      if (to !== null) {
        pressDir(to);
      }
    },

    pressFire(): void {
      firePressed = true;
      fireHeld++;
      if (fireHeld === 1) {
        // A fresh press fires on the NEXT drain, whatever the pulse phase was.
        // Mashing therefore beats the turbo, exactly as on the NES, where the
        // only limit is the airborne-bullet cap.
        turbo = 0;
      }
    },

    releaseFire(): void {
      fireHeld = Math.max(0, fireHeld - 1);
    },

    pressPause(): void {
      pauseHeld++;
      pausePressed = true;
    },

    releasePause(): void {
      pauseHeld = Math.max(0, pauseHeld - 1);
    },

    reset(): void {
      stack.length = 0;
      fireHeld = 0;
      pauseHeld = 0;
      turbo = 0;
      // Blur (or a yanked cable) drops the latches too: a tap the player made
      // on the way out must not fire a shot when they come back.
      tapDir = null;
      firePressed = false;
      pausePressed = false;
    },

    drain(out: PlayerIntent): void {
      // A still-held direction wins over a latched tap: the latch's promise is
      // "a press survives to the next poll", not "a tap overrides the direction
      // you are holding". Releasing the tapped one already fell back through
      // the stack (rule 1), so the held one is the one still down.
      out.dir = stack.length > 0 ? stack[stack.length - 1] : tapDir;
      tapDir = null;

      out.pause = pauseHeld > 0 || pausePressed;
      pausePressed = false;

      if (fireHeld === 0) {
        // Released — but report the tap if one came and went inside this tick.
        // The core sees a clean single-tick edge either way.
        out.fire = firePressed;
        turbo = 0;
      } else if (turbo <= 0) {
        out.fire = true;
        turbo = TURBO_PERIOD_TICKS - 1;
      } else {
        out.fire = false;
        turbo--;
      }
      firePressed = false;
    },
  };
}

/** A fresh, neutral intent pair. Reused every tick by every source. */
export function createIntents(): [PlayerIntent, PlayerIntent] {
  return [
    { dir: null, fire: false, pause: false },
    { dir: null, fire: false, pause: false },
  ];
}
