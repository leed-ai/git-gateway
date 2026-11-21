// SPDX-License-Identifier: Apache-2.0
import { nodeTest } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: nodeTest(),
});
