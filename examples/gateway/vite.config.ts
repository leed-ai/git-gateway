// SPDX-License-Identifier: Apache-2.0
import { nodeTest, workersTestPlugin } from '@leed-ai/git-gateway-repo-tools/vite-presets';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // READ_TOKEN_SECRET is a Worker secret in a deployment; the tests get a throwaway value.
  plugins: [
    workersTestPlugin('./wrangler.jsonc', { READ_TOKEN_SECRET: 'example-test-read-token-secret-0123456789' }),
  ],
  test: nodeTest(),
});
