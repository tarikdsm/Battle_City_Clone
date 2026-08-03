// tests/app/perfArtifact.test.ts — the release notes must agree with the
// measurement they cite.
//
// This file exists because the same mistake happened twice in one session, and
// both times it was invisible. `docs/calibration/play.json` is rewritten in
// place by `npm run capture:play`, so a re-run — hunting a quieter machine,
// say — silently replaces the numbers a document was written from, and a
// `git add -A` afterwards commits the new file next to the old prose. The
// second time, a background capture I had already stopped overwrote the file
// *after* I restored it and before I staged.
//
// Nobody catches that by reading a diff of a 700-line JSON blob. A test does.
// It is cheap, it is exact, and it turns "the artifact is authoritative" from
// an intention into something enforced by `npm run check`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PhaseStats {
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

interface LoopRow {
  fps: number;
  meanMs: number;
  p95Ms: number;
  drawCalls: { min: number; median: number; max: number };
  cpuThrottle: number;
  sim: (PhaseStats & { steps: number }) | null;
  render: PhaseStats | null;
}

interface PlayArtifact {
  loop: Record<string, LoopRow>;
  budget: {
    renderCpuMs: number;
    drawCalls: number;
    simStepMs: number;
    fps: number;
  };
  machine: { certified: boolean; certifyNote: string };
  consoleErrors: string[];
  failedRequests: string[];
}

const artifact = JSON.parse(
  readFileSync(
    new URL('../../docs/calibration/play.json', import.meta.url),
    'utf8',
  ),
) as PlayArtifact;

const notes = readFileSync(
  new URL('../../docs/08-release-notes.md', import.meta.url),
  'utf8',
);

const PRESETS = ['high', 'medium', 'low', 'low@4x'] as const;

describe('the committed performance artifact', () => {
  it('was taken on a machine the harness was willing to certify', () => {
    // An uncertified run's rates describe the machine, not the game. Shipping
    // one as the release's measurement is worse than shipping no number.
    expect(artifact.machine.certified, artifact.machine.certifyNote).toBe(true);
  });

  it('covers every preset, including the throttled mobile stand-in', () => {
    for (const p of PRESETS) {
      expect(artifact.loop[p], `missing row: ${p}`).toBeDefined();
    }
    expect(artifact.loop['low@4x'].cpuThrottle).toBe(4);
  });

  it('has a clean console and no failed requests', () => {
    expect(artifact.consoleErrors).toEqual([]);
    expect(artifact.failedRequests).toEqual([]);
  });

  // The CPU-side budgets are the ones this project can actually hold a machine
  // to — they are counts and durations of work the code does, not rates that a
  // shared GPU can move. So they are asserted, not merely recorded.
  it('meets every CPU-side budget it claims to meet', () => {
    const b = artifact.budget;
    for (const p of PRESETS) {
      const row = artifact.loop[p];
      const t = row.cpuThrottle;
      expect(row.drawCalls.max, `${p} draw calls`).toBeLessThanOrEqual(
        b.drawCalls,
      );
      expect(row.sim?.p95Ms ?? Infinity, `${p} sim p95`).toBeLessThanOrEqual(
        b.simStepMs * t,
      );
      expect(
        row.render?.p95Ms ?? Infinity,
        `${p} render p95`,
      ).toBeLessThanOrEqual(b.renderCpuMs * t);
    }
  });
});

describe('the release notes quote the artifact exactly', () => {
  // The table in §4 is `| Preset | FPS | frame CPU (mean / p95) | draw calls |`.
  // Reading it back out of the prose is the whole point: a number that drifted
  // from the file it came from fails here rather than in a reader's hands.
  const table = new Map<string, string>([
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
    ['low@4x', 'Low, 4× CPU throttle'],
  ]);

  for (const [key, label] of table) {
    it(`states ${label}'s figures as measured`, () => {
      const row = artifact.loop[key];
      const line = notes
        .split('\n')
        .find((l) => l.trim().startsWith(`| ${label} |`));
      expect(line, `no release-notes row for ${label}`).toBeDefined();
      if (line === undefined) return;

      // Parsed numerically rather than matched as text: the notes round for
      // readability, and asserting on a rendered string would fail on
      // `(3.005).toFixed(2) === '3.00'` — a float artifact, not a wrong number.
      // The cells are FPS, mean ms, p95 ms, then the draw-call range.
      // Cells after the label only — the label itself carries a digit in
      // "Low, 4x CPU throttle", which a whole-line scan would read as the FPS.
      const cells = line.split('|').slice(2);
      const nums = (cells.join(' ').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      expect(nums.length, `${label}: unreadable row`).toBeGreaterThanOrEqual(5);
      const near = (got: number, want: number): boolean =>
        Math.abs(got - want) <= 0.005 + Math.abs(want) * 1e-9;
      expect(near(nums[0], row.fps), `${label} FPS: ${nums[0]}`).toBe(true);
      expect(
        near(nums[1], row.meanMs),
        `${label} mean frame CPU: ${nums[1]} vs ${row.meanMs}`,
      ).toBe(true);
      expect(
        near(nums[2], row.p95Ms),
        `${label} p95 frame CPU: ${nums[2]} vs ${row.p95Ms}`,
      ).toBe(true);
      expect(nums[3], `${label} draw calls min`).toBe(row.drawCalls.min);
      expect(nums[4], `${label} draw calls max`).toBe(row.drawCalls.max);
    });
  }

  it('does not claim a preset holds 60 FPS unless the artifact shows it', () => {
    // Every rate in the artifact is a LOWER bound (the harness cannot see a
    // shared GPU), so a row at or above 60 proves the budget and a row below it
    // proves nothing. The notes may therefore only mark a preset "proven" when
    // its measured rate actually clears.
    for (const [key, label] of table) {
      const line =
        notes.split('\n').find((l) => l.trim().startsWith(`| ${label} |`)) ??
        '';
      const claimsProven = /proven/i.test(line);
      expect(
        claimsProven,
        `${label}: notes say "${line.trim()}" for ${artifact.loop[key].fps} FPS`,
      ).toBe(artifact.loop[key].fps >= 60);
    }
  });
});
