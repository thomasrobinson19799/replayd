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
    // PRD §4.1: the lazy replay chunk bundles the pinned, patched @rrweb/record (core devDependency, D-17).
    // It is never a runtime dependency of the published package and never reaches index.js.
    files: ['packages/core/src/replay/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\.{1,2}/|@rrweb/record$)', message: 'No runtime dependencies in @replayd/core (AGENTS.md rule 3).' }] }],
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
