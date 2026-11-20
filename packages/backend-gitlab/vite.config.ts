// SPDX-License-Identifier: Apache-2.0
import { libraryPack, nodeTest } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: libraryPack(),
  test: nodeTest({ testTimeout: 60_000 }),
});
