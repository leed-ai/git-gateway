// SPDX-License-Identifier: Apache-2.0
import { isPublic, type WorkspacePackage } from './manifest.ts';

/** The file name the snapshot changeset is written to inside `.changeset/`. */
export const SNAPSHOT_CHANGESET_FILE = 'next-snapshot.md';

/**
 * A changeset that bumps every public package by a patch, so `changeset version --snapshot next`
 * gives each one a `0.x.y-next.<timestamp>` version even when no other changeset is pending.
 */
export function snapshotChangeset(packages: readonly WorkspacePackage[]): string {
  const names = packages
    .flatMap(({ dir, manifest }) =>
      dir !== '.' && isPublic(manifest) && manifest.name !== undefined ? [manifest.name] : [],
    )
    .toSorted();
  if (names.length === 0) throw new Error('no public packages to snapshot');
  const header = names.map((name) => `"${name}": patch`).join('\n');
  return `---\n${header}\n---\n\nSnapshot of main for the next dist-tag.\n`;
}
