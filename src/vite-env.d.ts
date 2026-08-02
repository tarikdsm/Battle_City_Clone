// Ambient typings for the Vite-injected `import.meta.env` fields the app reads.
//
// Deliberately hand-written instead of `/// <reference types="vite/client" />`:
// the app program compiles with `types: []` (see tsconfig.json) to keep ambient
// packages — and the Node globals some of them pull in — out of `src`. This
// declares exactly the two constants Vite statically replaces at build time, so
// `if (import.meta.env.DEV)` folds to `if (false)` in a production bundle.

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
