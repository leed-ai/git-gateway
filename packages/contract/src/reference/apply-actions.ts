// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '../gateway-error.ts';
import type { CommitAction } from '../schemas/commit-action.ts';
import { decodeContent } from './bytes.ts';
import { fileParent, isDirectory, type FileMap, type StoredFile } from './file-map.ts';
import { blobSha } from './hash.ts';

async function storedFile(
  content: string,
  encoding: 'text' | 'base64',
  executable: boolean,
): Promise<StoredFile> {
  const bytes = decodeContent(content, encoding);
  return { bytes, executable, sha: await blobSha(bytes) };
}

/** Throws path_exists or path_conflict unless `path` is free to receive a new file. */
function requireFree(files: FileMap, path: string): void {
  if (files.has(path) || isDirectory(files, path)) {
    throw gatewayError('path_exists', `Path already exists: ${path}`, { path });
  }
  requireNoFileParent(files, path);
}

/** Throws path_conflict when a parent of `path` is a file. */
function requireNoFileParent(files: FileMap, path: string): void {
  const conflictingPath = fileParent(files, path);
  if (conflictingPath !== undefined) {
    throw gatewayError('path_conflict', `A parent of ${path} is a file: ${conflictingPath}`, {
      path,
      conflictingPath,
    });
  }
}

/** The existing file at `path`, or path_not_found. */
function requireFile(files: FileMap, path: string): StoredFile {
  const file = files.get(path);
  if (file === undefined) throw gatewayError('path_not_found', `File not found: ${path}`, { path });
  return file;
}

async function applyOne(files: Map<string, StoredFile>, action: CommitAction): Promise<void> {
  switch (action.action) {
    case 'create':
      requireFree(files, action.path);
      files.set(action.path, await storedFile(action.content, action.encoding, false));
      return;
    case 'update': {
      const existing = requireFile(files, action.path);
      files.set(action.path, await storedFile(action.content, action.encoding, existing.executable));
      return;
    }
    case 'upsert': {
      const existing = files.get(action.path);
      if (existing === undefined) requireFree(files, action.path);
      files.set(
        action.path,
        await storedFile(action.content, action.encoding, existing?.executable ?? false),
      );
      return;
    }
    case 'delete':
      requireFile(files, action.path);
      files.delete(action.path);
      return;
    case 'move': {
      const existing = requireFile(files, action.previousPath);
      // The source leaves first, so a file may move beneath its own old path (a → a/b).
      files.delete(action.previousPath);
      requireFree(files, action.path);
      const moved =
        action.content === undefined
          ? existing
          : await storedFile(action.content, action.encoding, existing.executable);
      files.set(action.path, moved);
      return;
    }
    case 'chmod': {
      const existing = requireFile(files, action.path);
      files.set(action.path, { ...existing, executable: action.executeFilemode });
      return;
    }
  }
}

/**
 * Applies commit actions in order, each to the result of the one before, with the GitLab
 * Commits API rules (plus upsert). Returns the new snapshot; throws a GatewayError on the first
 * action that breaks a rule, leaving `files` untouched.
 */
export async function applyActions(files: FileMap, actions: readonly CommitAction[]): Promise<FileMap> {
  const next = new Map(files);
  for (const action of actions) await applyOne(next, action);
  return next;
}
