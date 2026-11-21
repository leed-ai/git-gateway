// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';

import { EditTreeInput, type EditedTree, type TreeChange } from '../schemas/tree-edit.ts';
import { requireEntry } from './path-rules.ts';
import { TreeOverlay } from './tree-overlay.ts';
import type { TreeReader } from './tree-reader.ts';

async function applyChange(overlay: TreeOverlay, change: TreeChange): Promise<void> {
  if (change.op === 'remove') {
    await requireEntry(overlay, change.path);
    await overlay.remove(change.path);
    return;
  }
  const state = await overlay.stat(change.path);
  if (state.kind === 'directory') {
    throw gatewayError('path_exists', `Path is a directory: ${change.path}`, { path: change.path });
  }
  if (state.kind === 'blocked') {
    throw gatewayError('path_conflict', `A parent of ${change.path} is a file: ${state.at}`, {
      path: change.path,
      conflictingPath: state.at,
    });
  }
  await overlay.set(change.path, change.mode, change.sha);
}

/**
 * Applies path edits to a tree, reading only the directories along the edited paths through
 * `reader` and writing a new tree object only for each directory whose content changed. Entries
 * the edits do not touch are copied as read and untouched subtrees keep their ids.
 *
 * Throws a contract GatewayError (path_exists, path_not_found or path_conflict) when a change
 * breaks its rule, and a missing_object CoreError when a tree on an edited path cannot be read.
 */
export async function editTree(input: EditTreeInput, reader: TreeReader): Promise<EditedTree> {
  const { tree, changes } = EditTreeInput.parse(input);
  const overlay = new TreeOverlay(reader, tree);
  for (const change of changes) await applyChange(overlay, change);
  const written = await overlay.write();
  return { tree: written.tree, objects: [...written.objects] };
}
