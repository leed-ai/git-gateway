// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { ContentEncoding, ReadContent } from '../schemas/content-encoding.ts';
import { EXAMPLE_SHA_B } from '../schemas/examples.ts';
import { FilePath, RepoName, Revision } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';

/** Input of `readFile`. */
export const ReadFileInput = z
  .object({
    repo: RepoName.describe('Repository to read from.'),
    ref: Revision.describe('Branch name or commit id to read the file at.'),
    path: FilePath.describe('Path of the file to read.'),
    encoding: ContentEncoding.default('text').describe(
      'Preferred encoding of the returned content. "text" (default) returns text when the bytes are valid UTF-8 and falls back to base64 otherwise; "base64" always returns base64.',
    ),
  })
  .strict()
  .meta({
    id: 'ReadFileInput',
    title: 'readFile input',
    description:
      'Input of readFile(): one file at a branch or commit. Fails with ref_not_found if the ref is missing.',
    examples: [{ repo: 'acme-raw-content', ref: 'main', path: 'content/about.md', encoding: 'text' }],
  });

/** Input of `readFile` as accepted (defaults optional). */
export type ReadFileInput = z.input<typeof ReadFileInput>;

/** A file read from a repository. */
export const FileRead = z
  .object({
    path: FilePath.describe('Path of the file read.'),
    commit: Sha.describe('Id of the commit the file was read at (the ref resolved).'),
    sha: Sha.describe("Id of the file's blob. Equal content always has an equal id."),
    size: z.int().min(0).describe('Size of the file in bytes.'),
    executable: z.boolean().describe('true when the file mode is 100755.'),
    encoding: ContentEncoding.describe(
      'How `content` is encoded; may be base64 even when text was requested.',
    ),
    content: ReadContent.describe("The file's content, encoded as `encoding` says."),
  })
  .strict()
  .meta({
    id: 'FileRead',
    title: 'File read',
    description: 'A file read from a repository at a commit, with its blob id, size and mode.',
    examples: [
      {
        path: 'content/about.md',
        commit: EXAMPLE_SHA_B,
        sha: 'f2a5b0a7d1d3d1f1c1c3e7e5d2b9b7e1a3c5d7e9',
        size: 11,
        executable: false,
        encoding: 'text',
        content: '# About us\n',
      },
    ],
  });

/** A file read, inferred from {@link FileRead}. */
export type FileRead = z.infer<typeof FileRead>;

/** Output of `readFile`: the file, or null when no file is at the path. */
export const ReadFileOutput = FileRead.nullable().meta({
  id: 'ReadFileOutput',
  title: 'readFile output',
  description:
    'Output of readFile(): the file, or null when the path is not a file at that ref (absent or a directory).',
  examples: [null],
});

/** Output of `readFile`, inferred from {@link ReadFileOutput}. */
export type ReadFileOutput = z.infer<typeof ReadFileOutput>;
