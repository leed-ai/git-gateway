// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite-plus';

const generated = ['**/dist/**', '**/.turbo/**', '**/.wrangler/**', '**/coverage/**', '**/.vitest/**'];

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ...generated,
      '.changeset/*.md',
      'CHANGELOG.md',
      '**/CHANGELOG.md',
      '**/__snapshots__/**',
    ],
    printWidth: 110,
    singleQuote: true,
    semi: true,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: generated,
    plugins: ['typescript', 'unicorn', 'oxc', 'import', 'vitest'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    rules: {
      'import/no-default-export': 'error',
      'import/no-cycle': 'error',
      'oxc/no-barrel-file': ['error', { threshold: 0 }],
      'max-lines': ['error', { max: 300, skipBlankLines: false, skipComments: false }],
      'no-console': 'error',
      // Zod 4 keeps schema internals on `_zod`; the schema-documentation walker reads them.
      'no-underscore-dangle': ['error', { allow: ['_zod'] }],
      'typescript/no-explicit-any': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/consistent-type-imports': 'error',
      'typescript/no-non-null-assertion': 'error',
      'unicorn/prefer-node-protocol': 'error',
    },
    overrides: [
      {
        // Tool configuration files and the example Worker's module entry must default-export.
        files: ['**/vite.config.ts', 'examples/*/src/index.ts'],
        rules: { 'import/no-default-export': 'off' },
      },
      {
        // Command-line entry points report to the terminal.
        files: ['tooling/repo/src/cli/**'],
        rules: { 'no-console': 'off' },
      },
    ],
  },
});
