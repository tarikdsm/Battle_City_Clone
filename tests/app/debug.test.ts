import { describe, expect, it } from 'vitest';
import { parseDebugFlags } from '../../src/app/debug';

describe('parseDebugFlags (arch §12)', () => {
  it('parses every flag in a dev build', () => {
    expect(
      parseDebugFlags('?stage=7&seed=42&quality=low&overlay=1', true),
    ).toEqual({ stage: 7, seed: 42, quality: 'low', overlay: true });
  });

  it('is inert in a production build, whatever the query says', () => {
    const flags = parseDebugFlags(
      '?stage=7&seed=42&quality=low&overlay=1',
      false,
    );
    expect(flags).toEqual({ overlay: false });
    expect(flags.stage).toBeUndefined();
    expect(flags.seed).toBeUndefined();
    expect(flags.quality).toBeUndefined();
  });

  it('ignores invalid values instead of substituting a wrong default', () => {
    expect(parseDebugFlags('?stage=99', true).stage).toBeUndefined();
    expect(parseDebugFlags('?stage=0', true).stage).toBeUndefined();
    expect(parseDebugFlags('?stage=abc', true).stage).toBeUndefined();
    expect(parseDebugFlags('?stage=3.5', true).stage).toBeUndefined();
    expect(parseDebugFlags('?quality=ultra', true).quality).toBeUndefined();
    expect(parseDebugFlags('?quality=auto', true).quality).toBeUndefined();
    expect(parseDebugFlags('?seed=nope', true).seed).toBeUndefined();
    expect(parseDebugFlags('?seed=1e999', true).seed).toBeUndefined();
  });

  it('accepts the stage and seed edges', () => {
    expect(parseDebugFlags('?stage=1&seed=0', true)).toEqual({
      stage: 1,
      seed: 0,
      overlay: false,
    });
    expect(parseDebugFlags('?stage=35&seed=-7', true)).toEqual({
      stage: 35,
      seed: -7,
      overlay: false,
    });
  });

  it('treats overlay as a switch and defaults it off', () => {
    expect(parseDebugFlags('', true).overlay).toBe(false);
    expect(parseDebugFlags('?overlay', true).overlay).toBe(true);
    expect(parseDebugFlags('?overlay=1', true).overlay).toBe(true);
    expect(parseDebugFlags('?overlay=true', true).overlay).toBe(true);
    expect(parseDebugFlags('?overlay=0', true).overlay).toBe(false);
    expect(parseDebugFlags('?overlay=false', true).overlay).toBe(false);
  });

  it('accepts a search string with or without the leading "?"', () => {
    expect(parseDebugFlags('stage=4', true).stage).toBe(4);
  });
});

describe('?enemies= (T6.1: a content knob, dev-only)', () => {
  it('accepts 1…20 and rejects everything else', () => {
    expect(parseDebugFlags('?enemies=3', true).enemies).toBe(3);
    expect(parseDebugFlags('?enemies=1', true).enemies).toBe(1);
    expect(parseDebugFlags('?enemies=20', true).enemies).toBe(20);
    expect(parseDebugFlags('?enemies=0', true).enemies).toBeUndefined();
    expect(parseDebugFlags('?enemies=21', true).enemies).toBeUndefined();
    expect(parseDebugFlags('?enemies=two', true).enemies).toBeUndefined();
    expect(parseDebugFlags('', true).enemies).toBeUndefined();
  });

  it('is inert in a production bundle, like every other flag here', () => {
    expect(parseDebugFlags('?enemies=3', false).enemies).toBeUndefined();
  });
});
