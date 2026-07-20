import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs a trivial green test', () => {
    expect(1 + 1).toBe(2);
  });
});
