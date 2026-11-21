// SPDX-License-Identifier: Apache-2.0
import { libraryPack, nodeTest, workersTestPlugin } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [workersTestPlugin('./test/wrangler.jsonc')],
  pack: libraryPack(),
  test: nodeTest({ testTimeout: 30_000 }),
});
