import { defineConfig } from 'vitest/config';

// Vite + Vitest share this config. Vitest is scoped to `tests/**` so it never
// picks up Playwright's `e2e/**/*.spec.ts`. The core sim runs headless (arch §2),
// so the default test environment is Node.
// `--mode pages` (used by the GitHub Pages workflow) builds with the project-site
// base path; local dev/preview/e2e keep `/`.
export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/Battle_City_Clone/' : '/',
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
