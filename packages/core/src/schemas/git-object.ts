// SPDX-License-Identifier: Apache-2.0
import { Signature, Timestamp } from '@leed-ai/git-gateway-contract/schemas/identity';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { TreeEntry } from '@leed-ai/git-gateway-contract/schemas/tree-entry';
import { z } from 'zod';

import { Bytes } from './packet.ts';

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SIGNATURE = { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-11-20T09:30:00.000Z' };

/** The kinds of git object the gateway writes. */
export const GitObjectType = z.enum(['blob', 'tree', 'commit']).meta({
  id: 'GitObjectType',
  title: 'Git object type',
  description: 'The kind of a git object, as named in its "<type> <size>\\0" header and its pack entry.',
  enumDescriptions: {
    blob: 'File content (pack type 3).',
    tree: 'A directory listing (pack type 2).',
    commit: 'A commit (pack type 1).',
  },
  examples: ['blob', 'tree', 'commit'],
});

/** A git object type, inferred from {@link GitObjectType}. */
export type GitObjectType = z.infer<typeof GitObjectType>;

/** A git object: its type, id and raw content. */
export const GitObject = z
  .object({
    type: GitObjectType,
    sha: Sha.describe('The object id: SHA-1 of "<type> <size>\\0" followed by `data`.'),
    data: Bytes.describe('The object content without the "<type> <size>\\0" header, uncompressed.'),
  })
  .strict()
  .meta({
    id: 'GitObject',
    title: 'Git object',
    description:
      'A git object ready to be packed: type, id and uncompressed content. Produced by the encoders and tree operations, consumed by writePack.',
    examples: [{ type: 'blob', sha: EMPTY_BLOB, data: new Uint8Array(0) }],
  });

/** A git object, inferred from {@link GitObject}. */
export type GitObject = z.infer<typeof GitObject>;

/** One entry of a git tree object: name, mode and id. */
export const GitTreeEntry = TreeEntry.pick({ name: true, mode: true, sha: true })
  .strict()
  .meta({
    id: 'GitTreeEntry',
    title: 'Git tree entry',
    description:
      'One entry of a git tree object as stored: the name within its directory, the mode, and the id of the blob, tree or submodule commit. A contract TreeEntry without its derived path and type, so a TreeEntry list from a backend can be passed where these are read.',
    examples: [{ name: 'about.md', mode: '100644', sha: EMPTY_BLOB }],
  });

/** A git tree entry, inferred from {@link GitTreeEntry}. */
export type GitTreeEntry = z.infer<typeof GitTreeEntry>;

/** The earliest date git can store: it writes dates as unsigned seconds since 1970-01-01T00:00:00Z. */
const EPOCH = Date.parse('1970-01-01T00:00:00Z');

/** A timestamp git can store in a commit object: 1970-01-01T00:00:00Z or later. */
export const CommitTimestamp = Timestamp.refine((date) => Date.parse(date) >= EPOCH, {
  message: 'git stores dates as seconds since 1970-01-01T00:00:00Z; earlier dates cannot be written',
}).meta({
  id: 'CommitTimestamp',
  title: 'Commit timestamp',
  description:
    'An ISO 8601 UTC timestamp at or after 1970-01-01T00:00:00Z. git writes commit dates as unsigned seconds since the epoch, and git fsck rejects a commit with a negative one.',
  examples: ['2026-11-20T09:30:00.000Z'],
});

/** A storable commit timestamp, inferred from {@link CommitTimestamp}. */
export type CommitTimestamp = z.infer<typeof CommitTimestamp>;

/** A signature git can store in a commit object: a contract Signature dated 1970 or later. */
export const CommitSignature = Signature.extend({
  date: CommitTimestamp.describe(
    'When this person authored or committed the change: an ISO 8601 UTC timestamp, 1970 or later.',
  ),
}).meta({
  id: 'CommitSignature',
  title: 'Commit signature',
  description:
    'A name, email and date as a commit object stores them: a contract Signature whose date is 1970-01-01T00:00:00Z or later.',
  examples: [SIGNATURE],
});

/** A storable signature, inferred from {@link CommitSignature}. */
export type CommitSignature = z.infer<typeof CommitSignature>;

/** The fields a commit object records. */
export const CommitFields = z
  .object({
    tree: Sha.describe('Id of the root tree the commit records.'),
    parents: z
      .array(Sha.describe('Id of a parent commit.'))
      .max(2)
      .describe('Parent ids in order: none for a root commit, one for an ordinary commit, two for a merge.'),
    author: CommitSignature.describe(
      'Who wrote the change and when, dated 1970 or later. The date is stored in whole seconds at +0000; fractional seconds are dropped.',
    ),
    committer: CommitSignature.describe(
      'Who recorded the commit and when, dated 1970 or later; stored like the author.',
    ),
    message: z
      .string()
      .min(1)
      .describe('The full commit message, stored exactly as given (trailers included).'),
  })
  .strict()
  .meta({
    id: 'CommitFields',
    title: 'Commit fields',
    description:
      'What a new commit object records: tree, parents, author, committer and message. Encoded in git\'s commit format with "<seconds> +0000" dates.',
    examples: [
      {
        tree: EMPTY_TREE,
        parents: [],
        author: SIGNATURE,
        committer: SIGNATURE,
        message: 'Initial commit\n',
      },
    ],
  });

/** Commit fields as accepted. */
export type CommitFields = z.infer<typeof CommitFields>;
