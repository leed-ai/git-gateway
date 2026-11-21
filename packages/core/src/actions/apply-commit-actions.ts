// SPDX-License-Identifier: Apache-2.0
import { decodeContent } from '@leed-ai/git-gateway-contract/reference/bytes';
import type { CommitAction } from '@leed-ai/git-gateway-contract/schemas/commit-action';

import { createObject } from '../objects/hash-object.ts';
import { ApplyActionsInput, type ActionsResult } from '../schemas/commit-actions.ts';
import type { GitObject, GitTreeEntry } from '../schemas/git-object.ts';
import { requireFile, requireFree } from '../tree/path-rules.ts';
import { TreeOverlay } from '../tree/tree-overlay.ts';
import { EMPTY_TREE_SHA, type TreeReader } from '../tree/tree-reader.ts';

type FileEntryMode = '100644' | '100755' | '120000';

/** Applies actions to an overlay, collecting the blobs they write. */
class ActionApplier {
  readonly blobs = new Map<string, GitObject>();

  constructor(readonly overlay: TreeOverlay) {}

  async blob(content: string, encoding: 'text' | 'base64'): Promise<string> {
    const object = await createObject('blob', decodeContent(content, encoding));
    this.blobs.set(object.sha, object);
    return object.sha;
  }

  async apply(action: CommitAction): Promise<void> {
    const { overlay } = this;
    switch (action.action) {
      case 'create':
        await requireFree(overlay, action.path);
        await overlay.set(action.path, '100644', await this.blob(action.content, action.encoding));
        return;
      case 'update': {
        const existing = await requireFile(overlay, action.path);
        await overlay.set(action.path, fileMode(existing), await this.blob(action.content, action.encoding));
        return;
      }
      case 'upsert': {
        const state = await overlay.stat(action.path);
        const existing = state.kind === 'file' && state.entry.mode !== '160000' ? state.entry : undefined;
        if (existing === undefined) await requireFree(overlay, action.path);
        const mode = existing === undefined ? '100644' : fileMode(existing);
        await overlay.set(action.path, mode, await this.blob(action.content, action.encoding));
        return;
      }
      case 'delete':
        await requireFile(overlay, action.path);
        await overlay.remove(action.path);
        return;
      case 'move': {
        const existing = await requireFile(overlay, action.previousPath);
        // The source leaves first, so a file may move beneath its own old path (a → a/b).
        await overlay.remove(action.previousPath);
        await requireFree(overlay, action.path);
        const sha =
          action.content === undefined ? existing.sha : await this.blob(action.content, action.encoding);
        await overlay.set(action.path, fileMode(existing), sha);
        return;
      }
      case 'chmod': {
        const existing = await requireFile(overlay, action.path);
        // A symbolic link has no executable bit; git records it as 120000 either way.
        if (existing.mode === '120000') return;
        const mode = action.executeFilemode ? '100755' : '100644';
        if (mode !== existing.mode) await overlay.set(action.path, mode, existing.sha);
        return;
      }
    }
  }
}

/** The mode of a file entry; callers have ruled out directories and submodules. */
function fileMode(entry: GitTreeEntry): FileEntryMode {
  return entry.mode === '100755' || entry.mode === '120000' ? entry.mode : '100644';
}

/**
 * Applies commit actions to a tree with GitLab Commits API semantics (plus upsert), in order,
 * each to the result of the one before, reading only the directories along the paths the actions
 * name:
 *
 * - create: fails with path_exists if the path is a file or directory, path_conflict if a parent is a file;
 * - update: fails with path_not_found unless the path is a file; keeps its mode;
 * - upsert: creates or replaces (keeping the mode); path_exists for a directory, path_conflict for a file parent;
 * - delete: fails with path_not_found unless the path is a file; empty directories disappear;
 * - move: `previousPath` must be a file (path_not_found) and `path` free (path_exists / path_conflict) once
 *   the source has left; keeps the mode and, without `content`, the blob;
 * - chmod: sets 100755 or 100644 on an existing file (path_not_found otherwise); symbolic links are left as they are.
 *
 * Content is UTF-8 text or base64. A result equal to the base tree is reported as `noop`.
 * Rule failures throw a contract GatewayError; nothing is returned partially applied.
 */
export async function applyCommitActions(
  input: ApplyActionsInput,
  reader: TreeReader,
): Promise<ActionsResult> {
  const { tree, actions } = ApplyActionsInput.parse(input);
  const base = tree ?? EMPTY_TREE_SHA;
  const applier = new ActionApplier(new TreeOverlay(reader, tree));
  for (const action of actions) await applier.apply(action);
  const written = await applier.overlay.write();
  if (written.tree === base) return { status: 'noop', tree: base };
  const blobs = [...applier.blobs.values()].filter((blob) => written.referenced.has(blob.sha));
  return { status: 'changed', tree: written.tree, objects: [...blobs, ...written.objects] };
}
