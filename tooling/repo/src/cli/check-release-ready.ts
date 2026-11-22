// SPDX-License-Identifier: Apache-2.0
// Fails when changesets are waiting to be versioned: a release publishes the versions already on
// main, so the Changesets "chore: release packages" pull request has to be merged first.
import { pendingChangesets } from '../release-readiness.ts';
import { REPO_ROOT } from '../repo-root.ts';

const pending = pendingChangesets(REPO_ROOT);
if (pending.length > 0) {
  console.error(
    `::error::${pending.length} changeset(s) are not versioned yet (${pending.join(', ')}). ` +
      'Merge the "chore: release packages" pull request first, then release.',
  );
  process.exit(1);
}
console.log('No changesets are waiting: the versions on main are the release.');
