import { defineConfig } from 'vitest/config';

// Vite + Vitest share this config. Vitest is scoped to `tests/**` so it never
// picks up Playwright's `e2e/**/*.spec.ts`. The core sim runs headless (arch §2),
// so the default test environment is Node.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
