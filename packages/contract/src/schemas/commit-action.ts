// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { ContentEncoding, FileContent, isBase64 } from './content-encoding.ts';
import { FilePath } from './names.ts';

const encodingField = ContentEncoding.default('text').describe(
  'How `content` is encoded; defaults to "text".',
);

/** Rejects base64 content that is not valid padded base64. */
function base64Valid(value: { content?: string | undefined; encoding: 'text' | 'base64' }): boolean {
  return value.encoding !== 'base64' || value.content === undefined || isBase64(value.content);
}
const base64Message = { message: 'content is not valid base64', path: ['content'] };

/** Create a file that must not exist yet. */
export const CreateAction = z
  .object({
    action: z.literal('create').describe('Create a new file. Fails with path_exists if the path exists.'),
    path: FilePath.describe('Path of the file to create; it and every parent must not already be a file.'),
    content: FileContent.describe('Content of the new file, encoded as `encoding` says.'),
    encoding: encodingField,
  })
  .strict()
  .refine(base64Valid, base64Message)
  .meta({
    id: 'CreateAction',
    title: 'Create action',
    description:
      'Creates a file that does not exist yet. Fails with path_exists if the path is a file or a directory, and with path_conflict if a parent is a file. The new file is not executable.',
    examples: [{ action: 'create', path: 'content/about.md', content: '# About\n', encoding: 'text' }],
  });

/** Replace the content of an existing file. */
export const UpdateAction = z
  .object({
    action: z
      .literal('update')
      .describe('Replace an existing file. Fails with path_not_found if it is absent.'),
    path: FilePath.describe('Path of the existing file to replace.'),
    content: FileContent.describe('New content of the file, encoded as `encoding` says.'),
    encoding: encodingField,
  })
  .strict()
  .refine(base64Valid, base64Message)
  .meta({
    id: 'UpdateAction',
    title: 'Update action',
    description:
      'Replaces the content of an existing file, keeping its executable bit. Fails with path_not_found if the path is not a file.',
    examples: [{ action: 'update', path: 'content/about.md', content: '# About us\n', encoding: 'text' }],
  });

/** Create or replace a file. */
export const UpsertAction = z
  .object({
    action: z.literal('upsert').describe('Create the file, or replace it if it exists.'),
    path: FilePath.describe('Path of the file to create or replace.'),
    content: FileContent.describe('Content of the file, encoded as `encoding` says.'),
    encoding: encodingField,
  })
  .strict()
  .refine(base64Valid, base64Message)
  .meta({
    id: 'UpsertAction',
    title: 'Upsert action',
    description:
      'Creates the file, or replaces it (keeping its executable bit) if it exists. Fails with path_exists if the path is a directory and path_conflict if a parent is a file. Not part of the GitLab Commits API.',
    examples: [{ action: 'upsert', path: 'assets/logo.png', content: 'iVBORw0KGgo=', encoding: 'base64' }],
  });

/** Delete an existing file. */
export const DeleteAction = z
  .object({
    action: z
      .literal('delete')
      .describe('Delete an existing file. Fails with path_not_found if it is absent.'),
    path: FilePath.describe('Path of the file to delete. Directories left empty disappear with it.'),
  })
  .strict()
  .meta({
    id: 'DeleteAction',
    title: 'Delete action',
    description:
      'Deletes an existing file. Fails with path_not_found if the path is not a file (a directory cannot be deleted in one action).',
    examples: [{ action: 'delete', path: 'content/old.md' }],
  });

/** Move (rename) a file, optionally replacing its content. */
export const MoveAction = z
  .object({
    action: z.literal('move').describe('Move a file from `previousPath` to `path`.'),
    path: FilePath.describe('Destination path; it must not exist and no parent of it may be a file.'),
    previousPath: FilePath.describe('Path of the existing file to move.'),
    content: FileContent.optional().describe(
      'New content for the moved file, encoded as `encoding` says. Absent: the content is kept.',
    ),
    encoding: encodingField,
  })
  .strict()
  .refine((value) => value.path !== value.previousPath, {
    message: 'path and previousPath must differ',
    path: ['path'],
  })
  .refine(base64Valid, base64Message)
  .meta({
    id: 'MoveAction',
    title: 'Move action',
    description:
      'Moves a file, keeping its executable bit and, unless `content` is given, its content. Fails with path_not_found if `previousPath` is not a file, path_exists if `path` exists, and path_conflict if a parent of `path` is a file.',
    examples: [{ action: 'move', path: 'content/new.md', previousPath: 'content/old.md', encoding: 'text' }],
  });

/** Set or clear the executable bit of an existing file. */
export const ChmodAction = z
  .object({
    action: z.literal('chmod').describe('Set or clear the executable bit of an existing file.'),
    path: FilePath.describe('Path of the existing file.'),
    executeFilemode: z
      .boolean()
      .describe('true: mode 100755 (executable); false: mode 100644 (not executable).'),
  })
  .strict()
  .meta({
    id: 'ChmodAction',
    title: 'Chmod action',
    description:
      'Sets (true) or clears (false) the executable bit of an existing file. Fails with path_not_found if the path is not a file. Setting the bit it already has changes nothing.',
    examples: [{ action: 'chmod', path: 'scripts/build.sh', executeFilemode: true }],
  });

/** One change in a commit, discriminated by `action`. */
export const CommitAction = z
  .discriminatedUnion('action', [
    CreateAction,
    UpdateAction,
    UpsertAction,
    DeleteAction,
    MoveAction,
    ChmodAction,
  ])
  .meta({
    id: 'CommitAction',
    title: 'Commit action',
    description:
      'One change in a commit, discriminated by `action`. Actions apply in order, each to the result of the one before, with the GitLab Commits API semantics (plus upsert).',
    examples: [
      { action: 'create', path: 'content/about.md', content: '# About\n', encoding: 'text' },
      { action: 'delete', path: 'content/old.md' },
    ],
  });

/** One change in a commit, as accepted (before defaults). */
export type CommitActionInput = z.input<typeof CommitAction>;
/** One change in a commit, after parsing. */
export type CommitAction = z.output<typeof CommitAction>;
