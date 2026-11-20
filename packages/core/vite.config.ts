// SPDX-License-Identifier: Apache-2.0
import { libraryPack, nodeTest } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

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
      thresholds: { lines: 90 },
    },
  }),
});
