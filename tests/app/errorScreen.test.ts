import { describe, expect, it } from 'vitest';
import {
  FRIENDLY_MESSAGE,
  createErrorRail,
  describeFailure,
  isErrorParams,
} from '../../src/app/errorScreen';

/** Records what the rail would have shown. */
function sink(): { calls: { message: string; details: string }[] } {
  return { calls: [] };
}

describe('createErrorRail (arch §12)', () => {
  it('shows the friendly message with the stack in the copyable details', () => {
    const s = sink();
    const rail = createErrorRail((message, details) => {
      s.calls.push({ message, details });
    });

    rail.onError({ message: 'boom', error: new Error('boom') });

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].message).toBe(FRIENDLY_MESSAGE);
    expect(s.calls[0].details).toContain('boom');
    // The player-facing text never leaks the raw error.
    expect(s.calls[0].message).not.toContain('boom');
  });

  it('latches: the first failure wins and a cascade shows nothing more', () => {
    const s = sink();
    const rail = createErrorRail((message, details) => {
      s.calls.push({ message, details });
    });

    rail.onError({ message: 'first', error: new Error('first') });
    rail.onError({ message: 'second', error: new Error('second') });
    rail.onRejection({ reason: new Error('third') });

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].details).toContain('first');
    expect(s.calls[0].details).not.toContain('second');
  });

  it('ignores a resource load failure aimed at an element', () => {
    const s = sink();
    const selfTarget = { name: 'window' };
    const rail = createErrorRail(() => {
      s.calls.push({ message: '', details: '' });
    }, selfTarget);

    // A failed <img>/<script>: the event targets the element, not the window.
    rail.onError({ message: '', error: null, target: { tagName: 'IMG' } });
    expect(s.calls).toHaveLength(0);

    // A genuine code fault targets the window (or carries no target at all).
    rail.onError({
      message: 'kaboom',
      error: new Error('kaboom'),
      target: selfTarget,
    });
    expect(s.calls).toHaveLength(1);
  });

  it('handles an event with no usable message', () => {
    const s = sink();
    const rail = createErrorRail((message, details) => {
      s.calls.push({ message, details });
    });

    rail.onError({});

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].details).toContain('uncaught error');
  });

  it('reports a rejection reason of any shape', () => {
    const s = sink();
    const rail = createErrorRail((message, details) => {
      s.calls.push({ message, details });
    });

    rail.onRejection({ reason: 'just a string' });

    expect(s.calls[0].details).toContain('unhandled promise rejection');
    expect(s.calls[0].details).toContain('just a string');
  });

  it('never lets a failing error screen throw back into the handler', () => {
    const rail = createErrorRail(() => {
      throw new Error('the error screen is broken too');
    });

    expect(() => {
      rail.onError({ message: 'boom', error: new Error('boom') });
    }).not.toThrow();
  });
});

describe('describeFailure', () => {
  it('leads with the label and ends with the stack', () => {
    const err = new Error('detonated');
    const report = describeFailure('window.onerror', err);
    const lines = report.split('\n');

    expect(lines[0]).toBe('Battle City — window.onerror');
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(report).toContain('detonated');
    expect(report).toContain('errorScreen.test'); // the stack, not just the message
  });

  it('stringifies a non-Error rejection reason', () => {
    expect(describeFailure('rejection', { code: 42 })).toContain(
      '[object Object]',
    );
    expect(describeFailure('rejection', undefined)).toContain('undefined');
  });

  it('does not require a browser (no location/navigator in node)', () => {
    expect(() => describeFailure('smoke', null)).not.toThrow();
    expect(describeFailure('smoke', null)).toContain('(no location)');
  });
});

describe('isErrorParams', () => {
  it('accepts only a full params object', () => {
    expect(isErrorParams({ message: 'm', details: 'd' })).toBe(true);
    expect(isErrorParams({ message: 'm' })).toBe(false);
    expect(isErrorParams({ details: 'd' })).toBe(false);
    expect(isErrorParams({ message: 1, details: 'd' })).toBe(false);
    expect(isErrorParams(null)).toBe(false);
    expect(isErrorParams(undefined)).toBe(false);
    expect(isErrorParams('nope')).toBe(false);
  });
});
