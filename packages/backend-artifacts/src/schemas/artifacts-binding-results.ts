// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const SHA = /^[0-9a-f]{40}$/;
const EXAMPLE_SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const EXAMPLE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const timestamp = z.iso.datetime({ offset: true });

/** Repository metadata from `ArtifactsRepo.info()`. */
export const ArtifactsRepoInfo = z
  .object({
    id: z.string().min(1).describe('Unique repository id assigned by Artifacts.'),
    name: z.string().min(1).describe('Repository name within the namespace.'),
    description: z.string().nullable().describe('Repository description; null when none was set.'),
    defaultBranch: z.string().min(1).describe('Default branch name, e.g. "main".'),
    createdAt: timestamp.describe('When the repository was created, ISO 8601.'),
    updatedAt: timestamp.describe('When the repository metadata last changed, ISO 8601.'),
    lastPushAt: timestamp
      .nullable()
      .describe('When the repository was last pushed to, ISO 8601; null if never.'),
    source: z
      .string()
      .nullable()
      .describe('Fork or import source such as "github:owner/repo"; null when neither.'),
    readOnly: z.boolean().describe('true when the repository refuses pushes.'),
    remote: z.url().describe('HTTPS (HTTP locally) git remote URL of the repository, ending in ".git".'),
  })
  .meta({
    id: 'ArtifactsRepoInfo',
    title: 'Artifacts repository info',
    description:
      'What ArtifactsRepo.info() returns: the repository metadata, including its git remote URL. Unknown extra fields are ignored.',
    examples: [
      {
        id: 'tq6o4x0af6vky45b',
        name: 'acme-raw-content',
        description: null,
        defaultBranch: 'main',
        createdAt: '2026-11-20T21:55:53.422Z',
        updatedAt: '2026-11-20T21:55:53.422Z',
        lastPushAt: null,
        source: null,
        readOnly: false,
        remote: 'https://acct.artifacts.cloudflare.net/git/default/acme-raw-content.git',
      },
    ],
  });

/** Repository metadata from Artifacts, inferred from {@link ArtifactsRepoInfo}. */
export type ArtifactsRepoInfo = z.infer<typeof ArtifactsRepoInfo>;

/** The result of `Artifacts.create()`. */
export const ArtifactsCreateResult = z
  .object({
    id: z.string().min(1).describe('Unique repository id assigned by Artifacts.'),
    name: z.string().min(1).describe('Repository name within the namespace.'),
    defaultBranch: z.string().min(1).describe('Default branch name.'),
    remote: z.url().describe('Git remote URL of the new repository.'),
    token: z
      .string()
      .min(1)
      .describe(
        'Initial write token, plaintext. Secret: the backend revokes it immediately and never returns it.',
      ),
  })
  .meta({
    id: 'ArtifactsCreateResult',
    title: 'Artifacts create result',
    description: 'What Artifacts.create() returns: the new repository and an initial write token.',
    examples: [
      {
        id: 'tq6o4x0af6vky45b',
        name: 'acme-raw-content',
        defaultBranch: 'main',
        remote: 'https://acct.artifacts.cloudflare.net/git/default/acme-raw-content.git',
        token: 'art_v2_example?expires=1795298153',
      },
    ],
  });

/** The result of creating an Artifacts repository, inferred from {@link ArtifactsCreateResult}. */
export type ArtifactsCreateResult = z.infer<typeof ArtifactsCreateResult>;

/** The result of `ArtifactsRepo.createToken()`. */
export const ArtifactsToken = z
  .object({
    id: z.string().min(1).describe('Unique token id, usable to revoke it.'),
    plaintext: z
      .string()
      .min(1)
      .describe('The token itself. Secret: sent only as a Bearer header to the remote.'),
    scope: z.enum(['read', 'write']).meta({
      description: 'What the token allows.',
      enumDescriptions: { read: 'Fetch and clone only.', write: 'Fetch, clone and push.' },
    }),
    expiresAt: timestamp.describe('When the token stops working, ISO 8601.'),
  })
  .meta({
    id: 'ArtifactsToken',
    title: 'Artifacts token',
    description: 'A repository access token minted by ArtifactsRepo.createToken(); authenticates git only.',
    examples: [
      {
        id: 'hh50uo1kos7zorfv',
        plaintext: 'art_v2_example?expires=1795212353',
        scope: 'write',
        expiresAt: '2026-11-20T22:05:53.602Z',
      },
    ],
  });

/** An Artifacts token, inferred from {@link ArtifactsToken}. */
export type ArtifactsToken = z.infer<typeof ArtifactsToken>;

/** One entry from `ArtifactsRepo.readTree()`. */
export const ArtifactsTreeEntry = z
  .object({
    name: z.string().min(1).describe('Entry name within the tree.'),
    mode: z
      .string()
      .regex(/^[0-7]{5,6}$/)
      .describe('Canonical git mode as Artifacts reports it, e.g. "100644" or "40000" (no leading zero).'),
    hash: z.string().regex(SHA).describe('40-character lowercase hex id of the object the entry names.'),
    type: z.enum(['tree', 'blob', 'symlink', 'gitlink', 'exec']).meta({
      description: 'Classification Artifacts derives from the mode.',
      enumDescriptions: {
        tree: 'A directory (mode 40000).',
        blob: 'A regular file (mode 100644).',
        symlink: 'A symbolic link (mode 120000).',
        gitlink: 'A submodule commit (mode 160000).',
        exec: 'An executable file (mode 100755).',
      },
    }),
  })
  .meta({
    id: 'ArtifactsTreeEntry',
    title: 'Artifacts tree entry',
    description: 'One immediate child of a tree, as ArtifactsRepo.readTree() returns it.',
    examples: [
      { name: 'about.md', mode: '100644', hash: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', type: 'blob' },
    ],
  });

/** An Artifacts tree entry, inferred from {@link ArtifactsTreeEntry}. */
export type ArtifactsTreeEntry = z.infer<typeof ArtifactsTreeEntry>;

const person = z
  .object({
    name: z.string().describe('Name as recorded in the commit.'),
    email: z.string().describe('Email as recorded in the commit.'),
  })
  .describe('An identity recorded in a commit.');

/** Commit metadata from `ArtifactsRepo.readCommit()` and `log()`. */
export const ArtifactsCommit = z
  .object({
    hash: z.string().regex(SHA).describe('40-character lowercase hex commit id.'),
    treeHash: z.string().regex(SHA).describe("Id of the commit's root tree."),
    message: z.string().describe('Commit message with one trailing newline removed, if it had one.'),
    author: person.describe('Author identity.'),
    committer: person.describe('Committer identity.'),
    parents: z
      .array(z.string().regex(SHA).describe('A parent commit id.'))
      .describe('Parent ids in git order; empty for a root commit.'),
    authoredAt: z.int().min(0).describe('Author timestamp, Unix seconds.'),
    committedAt: z.int().min(0).describe('Committer timestamp, Unix seconds.'),
  })
  .meta({
    id: 'ArtifactsCommit',
    title: 'Artifacts commit',
    description:
      'Decoded commit metadata from ArtifactsRepo.readCommit() and log(). Time zones are not reported and one trailing newline of the message is removed.',
    examples: [
      {
        hash: EXAMPLE_SHA,
        treeHash: EXAMPLE_TREE,
        message: 'Update about page',
        author: { name: 'Ada Lovelace', email: 'ada@example.com' },
        committer: { name: 'Ada Lovelace', email: 'ada@example.com' },
        parents: [],
        authoredAt: 1795211753,
        committedAt: 1795211753,
      },
    ],
  });

/** Artifacts commit metadata, inferred from {@link ArtifactsCommit}. */
export type ArtifactsCommit = z.infer<typeof ArtifactsCommit>;

/** The identifying fields of an error thrown by the Artifacts binding. */
export const ArtifactsBindingError = z
  .object({
    code: z.string().min(1).describe('String error code, e.g. "NOT_FOUND" or "ALREADY_EXISTS".'),
    message: z.string().describe('Human-readable message from the binding.'),
  })
  .meta({
    id: 'ArtifactsBindingError',
    title: 'Artifacts binding error',
    description:
      "The fields of an ArtifactsError the backend relies on. Parsed from whatever was thrown, since an error crossing the binding's RPC boundary may lose its prototype.",
    examples: [{ code: 'NOT_FOUND', message: 'Repository not found: acme' }],
  });

/** An Artifacts binding error, inferred from {@link ArtifactsBindingError}. */
export type ArtifactsBindingError = z.infer<typeof ArtifactsBindingError>;
