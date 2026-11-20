// SPDX-License-Identifier: Apache-2.0
import { nodeTest, workersTestPlugin } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [workersTestPlugin('./wrangler.jsonc')],
  test: nodeTest(),
});
