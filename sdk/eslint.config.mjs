import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'bench/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      // rule 3: no runtime deps in core — only relative imports allowed
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\.{1,2}/)', message: 'No runtime dependencies in @replayd/core (AGENTS.md rule 3).' }] }],
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', '**/*.config.*'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
