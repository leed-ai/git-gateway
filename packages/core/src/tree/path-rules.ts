// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';

import type { GitTreeEntry } from '../schemas/git-object.ts';
import type { TreeOverlay } from './tree-overlay.ts';

const isFileMode = (entry: GitTreeEntry): boolean => entry.mode !== '160000';

/**
 * Throws path_exists when `path` is already an entry or a directory, and path_conflict when a
 * parent of it is not a directory; otherwise the path is free for a new entry.
 */
export async function requireFree(overlay: TreeOverlay, path: string): Promise<void> {
  const state = await overlay.stat(path);
  if (state.kind === 'file' || state.kind === 'directory') {
    throw gatewayError('path_exists', `Path already exists: ${path}`, { path });
  }
  if (state.kind === 'blocked') {
    throw gatewayError('path_conflict', `A parent of ${path} is a file: ${state.at}`, {
      path,
      conflictingPath: state.at,
    });
  }
}

/**
 * The file (regular, executable or symbolic link) at `path`, or path_not_found when the path is
 * absent, a directory or a submodule.
 */
export async function requireFile(overlay: TreeOverlay, path: string): Promise<GitTreeEntry> {
  const state = await overlay.stat(path);
  if (state.kind === 'file' && isFileMode(state.entry)) return state.entry;
  throw gatewayError('path_not_found', `File not found: ${path}`, { path });
}

/** Like {@link requireFile}, but any non-directory entry (submodules included) qualifies. */
export async function requireEntry(overlay: TreeOverlay, path: string): Promise<GitTreeEntry> {
  const state = await overlay.stat(path);
  if (state.kind === 'file') return state.entry;
  throw gatewayError('path_not_found', `Entry not found: ${path}`, { path });
}
