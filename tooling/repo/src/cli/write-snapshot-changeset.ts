// SPDX-License-Identifier: Apache-2.0
// Snapshot workflow only: adds a changeset bumping every public package, so
// `changeset version --snapshot next` versions all of them. Never committed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../repo-root.ts';
import { SNAPSHOT_CHANGESET_FILE, snapshotChangeset } from '../snapshot-changeset.ts';
import { listWorkspacePackages } from '../workspace.ts';

const path = join(REPO_ROOT, '.changeset', SNAPSHOT_CHANGESET_FILE);
writeFileSync(path, snapshotChangeset(listWorkspacePackages(REPO_ROOT)));
console.log(`Wrote ${path}`);
