import { describe, expect, it } from 'vitest';
import {
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
