import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config. Base = ESLint + typescript-eslint recommended.
 *
 * The `src/core/**` block enforces the architecture's hard boundary (arch §2):
 * core is a pure, deterministic simulation — it imports NOTHING external
 * (not even three) and touches no browser/non-deterministic API. These rules
 * are what keep that true for every task built on this scaffold.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // Core imports nothing external. The regex matches every import source
      // that does not start with '.', i.e. all bare/package specifiers
      // (three, node:*, @scope/*). Relative imports (./x, ../x) within core
      // remain allowed.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^[^.]',
              message:
                'src/core must import nothing external — it is a pure, dependency-free simulation (arch §2). Use relative imports within core only.',
            },
          ],
        },
      ],
      // Non-deterministic / browser globals are forbidden in core.
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'src/core is headless — no browser globals (arch §2).',
        },
        {
          name: 'document',
          message: 'src/core is headless — no browser globals (arch §2).',
        },
        {
          name: 'performance',
          message:
            'src/core must be deterministic — no performance/time APIs (arch §2).',
        },
        {
          name: 'Date',
          message: 'src/core must be deterministic — no Date (arch §2).',
        },
      ],
      // Math.random is banned: all randomness flows through the seeded rng (arch §3.5).
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'src/core must use the seeded rng (mulberry32), not Math.random (arch §3.5).',
        },
      ],
    },
  },
);
