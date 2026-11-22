// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { FullRefName, RepoName } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';
import { FileMode } from '../schemas/tree-entry.ts';
import { Principal } from './principal.ts';

const EXAMPLE_OLD = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const EXAMPLE_NEW = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
const EXAMPLE_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** One file a pushed commit adds, changes or removes. */
export const ChangedPath = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\0]+$/)
      .describe(
        'The file\'s path from the repository root, "/"-separated, exactly as the tree names it (any bytes git allows except NUL, decoded as UTF-8); 1–4096 characters. Always a file, symlink or submodule, never a directory: a directory added or removed appears as each file in it.',
      ),
    change: z.enum(['added', 'modified', 'deleted']).meta({
      description: 'What the commit did to the path.',
      enumDescriptions: {
        added: 'The path is new: no entry before (a file replacing a directory is added too).',
        modified: 'The path existed and its content or mode changed.',
        deleted: 'The path is gone (a directory replacing a file deletes the file).',
      },
    }),
    oldMode: FileMode.nullable().describe('The mode before the commit; null when the path was added.'),
    newMode: FileMode.nullable().describe('The mode after the commit; null when the path was deleted.'),
    oldSha: Sha.nullable().describe('The blob (or submodule commit) before the commit; null when added.'),
    newSha: Sha.nullable().describe('The blob (or submodule commit) after the commit; null when deleted.'),
    size: z
      .int()
      .min(0)
      .nullable()
      .describe(
        'Size in bytes of the new blob (for a symlink, of its target text); null when the path was deleted or is a submodule (mode 160000).',
      ),
  })
  .strict()
  .meta({
    id: 'ChangedPath',
    title: 'Changed path',
    description:
      "One path a pushed commit changed, from comparing its tree with its parent's: the change, the modes and ids on both sides, and the new blob's size.",
    examples: [
      {
        path: 'content/pages/about.md',
        change: 'modified',
        oldMode: '100644',
        newMode: '100644',
        oldSha: EXAMPLE_BLOB,
        newSha: EXAMPLE_OLD,
        size: 1832,
      },
    ],
  });

/** A changed path, inferred from {@link ChangedPath}. */
export type ChangedPath = z.infer<typeof ChangedPath>;

/** A commit a push brings that storage did not have, with the paths it changes. */
export const PushedCommit = z
  .object({
    sha: Sha.describe('The commit id.'),
    parents: z.array(Sha.describe('A parent commit id.')).max(1000).describe('Parent ids in order.'),
    changes: z
      .array(ChangedPath)
      .max(100_000)
      .describe(
        "The paths the commit changes. Against its parent for an ordinary commit and against the empty tree for a root commit; for a merge, only the paths whose result differs from every parent (git's combined diff), since anything matching one parent came from that parent. Sorted by path.",
      ),
  })
  .strict()
  .meta({
    id: 'PushedCommit',
    title: 'Pushed commit',
    description:
      'A commit new to the repository that a ref update brings (it is in the pushed pack), with the paths it changes.',
    examples: [
      {
        sha: EXAMPLE_NEW,
        parents: [EXAMPLE_OLD],
        changes: [
          {
            path: 'README.md',
            change: 'added',
            oldMode: null,
            newMode: '100644',
            oldSha: null,
            newSha: EXAMPLE_BLOB,
            size: 0,
          },
        ],
      },
    ],
  });

/** A pushed commit, inferred from {@link PushedCommit}. */
export type PushedCommit = z.infer<typeof PushedCommit>;

/** One ref update of a push, as a push policy sees it. */
export const PushPolicyUpdate = z
  .object({
    ref: FullRefName.describe('The ref the update names, fully qualified.'),
    oldSha: Sha.describe('Id the ref names now; the all-zero id when the update creates the ref.'),
    newSha: Sha.describe('Id the ref will name; the all-zero id when the update deletes the ref.'),
    commits: z
      .array(PushedCommit)
      .max(100_000)
      .nullable()
      .describe(
        'The commits new to the repository that the update brings — those of the pushed pack reachable from `newSha` — newest first (breadth-first from `newSha`), each with its changed paths. Empty for a deletion, or when `newSha` is a commit storage already has. Null when the policy did not ask for changed paths (PushPolicyNeeds.changedPaths false).',
      ),
  })
  .strict()
  .meta({
    id: 'PushPolicyUpdate',
    title: 'Push policy update',
    description: 'One ref update of a push and, when the policy asked for them, the commits it brings.',
    examples: [{ ref: 'refs/heads/main', oldSha: EXAMPLE_OLD, newSha: EXAMPLE_NEW, commits: null }],
  });

/** A ref update as a push policy sees it, inferred from {@link PushPolicyUpdate}. */
export type PushPolicyUpdate = z.infer<typeof PushPolicyUpdate>;

/** What a PushPolicy is asked to judge. */
export const PushPolicyInput = z
  .object({
    principal: Principal.describe('Who is pushing, as the Authenticator established it.'),
    repo: RepoName.describe('The repository pushed to.'),
    updates: z
      .array(PushPolicyUpdate)
      .min(1)
      .max(10_000)
      .describe('Every update of the push, in the order the client sent them; all passed the branch policy.'),
  })
  .strict()
  .meta({
    id: 'PushPolicyInput',
    title: 'Push policy input',
    description:
      'What PushPolicy.check() is given: the principal, the repository and every ref update of a push the branch policy allowed, with changed paths when the policy asked for them.',
    examples: [
      {
        principal: { subject: 'alice', name: null, email: null, roles: ['editor'], expiresAt: null },
        repo: 'acme-site',
        updates: [{ ref: 'refs/heads/main', oldSha: EXAMPLE_OLD, newSha: EXAMPLE_NEW, commits: null }],
      },
    ],
  });

/** A push policy's input, inferred from {@link PushPolicyInput}. */
export type PushPolicyInput = z.infer<typeof PushPolicyInput>;
