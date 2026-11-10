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
    ignores: ['apps/api/src/platform/**'],
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
  prettier,
);
