// src/app/session.ts — what a run is playing right now.
//
// Deliberately thin: T6.2 grows this into the campaign/continue state. It exists
// today so the screens have one object to hand around instead of loose numbers.

export interface Session {
  players: 1 | 2;
  stageNumber: number;
  seed: number;
}

/**
 * The seed is the app layer's job: the core takes it and stays deterministic
 * (arch §3.5). A fresh run draws it from the wall clock; a replay, a debug
 * `?seed=` flag or a test passes its own.
 */
export function createSession(init?: Partial<Session>): Session {
  return {
    players: init?.players ?? 1,
    stageNumber: init?.stageNumber ?? 1,
    seed: init?.seed ?? Date.now() >>> 0,
  };
}
