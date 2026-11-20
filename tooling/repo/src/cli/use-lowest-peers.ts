// SPDX-License-Identifier: Apache-2.0
// Nightly only: rewrites devDependencies so tests run against the lowest version of each peer range.
// The result is never committed; CI runs `bun install` afterwards.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pinLowestPeers } from '../lowest-peers.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { listWorkspacePackages } from '../workspace.ts';

for (const { dir, manifest } of listWorkspacePackages(REPO_ROOT)) {
  const pinned = pinLowestPeers(manifest);
  if (pinned === manifest) continue;
  writeFileSync(join(REPO_ROOT, dir, 'package.json'), `${JSON.stringify(pinned, null, 2)}\n`);
  console.log(`${dir}: ${JSON.stringify(pinned.devDependencies)}`);
}
