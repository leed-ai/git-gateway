// SPDX-License-Identifier: Apache-2.0
import { libraryPack, nodeTest } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

// One shard sees only part of the suite, so its coverage says nothing about the whole: the gate
// applies to unsharded runs (locally, and the coverage job in CI).
const sharded = process.argv.some((argument) => argument.startsWith('--shard'));

export default defineConfig({
  pack: libraryPack(),
  test: nodeTest({
    // The property suites run hundreds of generated cases; leave room under coverage and Stryker.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
      // The spec's gate for core: 90 % of lines.
      ...(sharded ? {} : { thresholds: { lines: 90 } }),
    },
  }),
});
