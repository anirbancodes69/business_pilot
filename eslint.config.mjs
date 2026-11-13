import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.venv/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Rule: only the platform module may use the raw Kysely instance or pg pool (ADR-0009).
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/platform/**',
      'apps/api/src/migrations/**',
      'apps/api/src/connectors/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'kysely', 'ioredis', 'redis'],
              message: 'Raw database/Redis clients may only be imported inside src/platform.',
            },
          ],
        },
      ],
    },
  },
  {
    // Connectors open short-lived connections to customer databases with `pg`. They still must not
    // touch the application database (Kysely) or Redis.
    files: ['apps/api/src/connectors/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['kysely', 'ioredis', 'redis'],
              message: 'Connectors must not use the application database or Redis clients.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
