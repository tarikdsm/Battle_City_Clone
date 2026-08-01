// src/core/rng.ts — mulberry32, the single seeded PRNG for the whole simulation
// (fidelity spec §14). State is plain data so it can live inside GameState.rng and
// serialize for replays. ALL core randomness must flow through here (never Math.random).
export interface Rng {
  s: number;
}

export function createRng(seed: number): Rng {
  return { s: seed | 0 };
}

// Returns a float in [0, 1) and advances the state in place.
export function nextFloat(rng: Rng): number {
  rng.s = (rng.s + 0x6d2b79f5) | 0;
  const s = rng.s;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Returns an integer in [0, n).
export function nextInt(rng: Rng, n: number): number {
  return Math.floor(nextFloat(rng) * n);
}
