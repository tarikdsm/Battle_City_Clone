import { describe, expect, it } from 'vitest';
import {
  createLazyScreen,
  createScreenMachine,
  type Screen,
  type ScreenName,
} from '../../src/app/screens';

// Vitest runs in the node environment: there is no DOM. The machine never
// touches `root` — it only hands it to `enter` — so a bare object is enough.
const root = {} as HTMLElement;

function fake(name: string, log: string[]): Screen & { params: unknown[] } {
  return {
    params: [],
    enter(el: HTMLElement, params?: unknown): void {
      expect(el).toBe(root);
      this.params.push(params);
      log.push(`enter:${name}`);
    },
    leave(): void {
      log.push(`leave:${name}`);
    },
  };
}

describe('createScreenMachine (arch §8)', () => {
  it('leaves the outgoing screen before entering the incoming one', () => {
    const log: string[] = [];
    const boot = fake('boot', log);
    const title = fake('title', log);
    const machine = createScreenMachine(root);
    machine.register('boot', boot);
    machine.register('title', title);

    // Nothing is mounted yet, so the first show must actually enter.
    expect(machine.current()).toBe('boot');
    machine.show('boot');
    expect(log).toEqual(['enter:boot']);
    expect(machine.current()).toBe('boot');

    machine.show('title', { stage: 3 });
    expect(log).toEqual(['enter:boot', 'leave:boot', 'enter:title']);
    expect(machine.current()).toBe('title');
    expect(title.params).toEqual([{ stage: 3 }]);
  });

  it('ignores a show of the screen already on stage', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('title', fake('title', log));
    machine.show('title');
    machine.show('title');
    machine.show('title');

    expect(log).toEqual(['enter:title']);
  });

  it('throws for an unregistered screen, naming it', () => {
    const machine = createScreenMachine(root);
    machine.register('boot', fake('boot', []));
    machine.show('boot');

    expect(() => {
      machine.show('editor');
    }).toThrow(/editor/);
    expect(() => {
      machine.show('nope' as ScreenName);
    }).toThrow(/nope/);
    // A failed show leaves the current screen untouched.
    expect(machine.current()).toBe('boot');
  });
});

describe('the overlay layer (GDD §5: pause/intro/tally sit OVER play)', () => {
  it('leaves the screen underneath mounted', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', log));
    machine.register('pause', fake('pause', log));
    machine.show('play');
    machine.showOverlay('pause');

    // The whole point: no `leave:play`. Tearing the play screen down would
    // dispose the renderer, the audio context and the simulation.
    expect(log).toEqual(['enter:play', 'enter:pause']);
    expect(machine.current()).toBe('play');
    expect(machine.currentOverlay()).toBe('pause');

    machine.hideOverlay();
    expect(log).toEqual(['enter:play', 'enter:pause', 'leave:pause']);
    expect(machine.current()).toBe('play');
    expect(machine.currentOverlay()).toBe(null);
  });

  it('replaces rather than stacks', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', log));
    machine.register('intro', fake('intro', log));
    machine.register('tally', fake('tally', log));
    machine.show('play');
    machine.showOverlay('intro');
    machine.showOverlay('tally');

    expect(log).toEqual([
      'enter:play',
      'enter:intro',
      'leave:intro',
      'enter:tally',
    ]);
    expect(machine.currentOverlay()).toBe('tally');
  });

  it('ignores a re-show of the overlay already up', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', log));
    machine.register('pause', fake('pause', log));
    machine.show('play');
    machine.showOverlay('pause');
    machine.showOverlay('pause');
    expect(log).toEqual(['enter:play', 'enter:pause']);
  });

  it('takes the overlay down with the screen it belonged to, top-down', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', log));
    machine.register('pause', fake('pause', log));
    machine.register('title', fake('title', log));
    machine.show('play');
    machine.showOverlay('pause');
    machine.show('title');

    // `leave:pause` BEFORE `leave:play`: an overlay reads the simulation the
    // screen under it owns, so it must never outlive it.
    expect(log).toEqual([
      'enter:play',
      'enter:pause',
      'leave:pause',
      'leave:play',
      'enter:title',
    ]);
    expect(machine.currentOverlay()).toBe(null);
  });

  it('hideOverlay is a no-op when nothing is up', () => {
    const log: string[] = [];
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', log));
    machine.show('play');
    machine.hideOverlay();
    machine.hideOverlay();
    expect(log).toEqual(['enter:play']);
  });

  it('throws for an unregistered overlay, naming it', () => {
    const machine = createScreenMachine(root);
    machine.register('play', fake('play', []));
    machine.show('play');
    expect(() => {
      machine.showOverlay('tally');
    }).toThrow(/tally/);
    expect(machine.currentOverlay()).toBe(null);
  });
});

describe('createLazyScreen (arch §9: the code-split editor route)', () => {
  /** A `load` that resolves when the test says so. */
  function deferred(screen: Screen): {
    load: () => Promise<Screen>;
    resolve: () => Promise<void>;
    calls: number;
  } {
    const box = {
      calls: 0,
      load: (): Promise<Screen> => {
        box.calls++;
        return new Promise<Screen>((res) => {
          settle = (): void => {
            res(screen);
          };
        });
      },
      resolve: async (): Promise<void> => {
        settle();
        // One microtask turn for the `.then` inside the adapter.
        await Promise.resolve();
      },
    };
    let settle = (): void => {};
    return box;
  }

  it('shows the placeholder, then hands the params to the real screen', async () => {
    const log: string[] = [];
    const real = fake('editor', log);
    const loading = fake('loading', log);
    const gate = deferred(real);

    const lazy = createLazyScreen(gate.load, loading);
    lazy.enter(root, { draft: 'x' });
    expect(log).toEqual(['enter:loading']);

    await gate.resolve();
    expect(log).toEqual(['enter:loading', 'leave:loading', 'enter:editor']);
    // The params survive the await — the draft has to reach the editor.
    expect(real.params).toEqual([{ draft: 'x' }]);
  });

  it('imports once, then enters synchronously on the next visit', async () => {
    const log: string[] = [];
    const real = fake('editor', log);
    const gate = deferred(real);
    const lazy = createLazyScreen(gate.load, fake('loading', log));

    lazy.enter(root);
    await gate.resolve();
    lazy.leave();
    log.length = 0;

    lazy.enter(root);
    // No placeholder at all the second time: the chunk is already in memory.
    expect(log).toEqual(['enter:editor']);
    expect(gate.calls).toBe(1);
  });

  it('does not enter a screen the player has already navigated away from', async () => {
    const log: string[] = [];
    const real = fake('editor', log);
    const gate = deferred(real);
    const lazy = createLazyScreen(gate.load, fake('loading', log));

    lazy.enter(root);
    lazy.leave(); // the chunk is still in flight
    expect(log).toEqual(['enter:loading', 'leave:loading']);

    await gate.resolve();
    // …and it never mounts behind whatever screen is up now.
    expect(log).toEqual(['enter:loading', 'leave:loading']);
  });

  it('leaves the real screen once, and not before it was entered', async () => {
    const log: string[] = [];
    const real = fake('editor', log);
    const gate = deferred(real);
    const lazy = createLazyScreen(gate.load, fake('loading', log));

    lazy.enter(root);
    await gate.resolve();
    lazy.leave();
    lazy.leave();
    expect(log).toEqual([
      'enter:loading',
      'leave:loading',
      'enter:editor',
      'leave:editor',
    ]);
  });

  it('works without a placeholder at all', async () => {
    const log: string[] = [];
    const gate = deferred(fake('editor', log));
    const lazy = createLazyScreen(gate.load);
    lazy.enter(root);
    expect(log).toEqual([]);
    await gate.resolve();
    expect(log).toEqual(['enter:editor']);
  });
});
