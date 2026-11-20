// SPDX-License-Identifier: Apache-2.0
import { createCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { describe, expect, it } from 'vite-plus/test';

import { toContractCommit, toStorageTreeEntry } from '../src/artifacts-mapping.ts';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SIGNATURE = { name: 'Ada', email: 'ada@example.com', date: '2026-11-20T09:30:00.000Z' };
const SECONDS = Date.parse(SIGNATURE.date) / 1000;

async function metadataOf(
  message: string,
): Promise<{ metadata: Parameters<typeof toContractCommit>[0]; sha: string }> {
  const { object } = await createCommit({
    tree: TREE,
    parents: [],
    author: SIGNATURE,
    committer: SIGNATURE,
    message,
  });
  return {
    sha: object.sha,
    metadata: {
      hash: object.sha,
      treeHash: TREE,
      message: message.endsWith('\n') ? message.slice(0, -1) : message,
      author: { name: 'Ada', email: 'ada@example.com' },
      committer: { name: 'Ada', email: 'ada@example.com' },
      parents: [],
      authoredAt: SECONDS,
      committedAt: SECONDS,
    },
  };
}

describe('toContractCommit', () => {
  it('restores the trailing newline Artifacts removes when the commit id says it was there', async () => {
    const { metadata } = await metadataOf('Update\n\nGateway-Idempotency-Key: k1\n');
    const commit = await toContractCommit(metadata);
    expect(commit.message).toBe('Update\n\nGateway-Idempotency-Key: k1\n');
    expect(commit.idempotencyKey).toBe('k1');
    expect(commit.author.date).toBe(SIGNATURE.date);
  });

  it('keeps a message that had no trailing newline as it is', async () => {
    const { metadata } = await metadataOf('No newline');
    expect((await toContractCommit(metadata)).message).toBe('No newline');
  });

  it('falls back to a trailing newline when neither encoding matches (another time zone)', async () => {
    const { metadata } = await metadataOf('Elsewhere\n');
    expect((await toContractCommit({ ...metadata, authoredAt: SECONDS + 3600 })).message).toBe('Elsewhere\n');
  });
});

describe('toStorageTreeEntry', () => {
  it.each([
    [
      { name: 'd', mode: '40000', hash: TREE, type: 'tree' as const },
      { name: 'd', mode: '040000', sha: TREE, type: 'tree' },
    ],
    [
      { name: 'x', mode: '100755', hash: TREE, type: 'exec' as const },
      { name: 'x', mode: '100755', sha: TREE, type: 'blob' },
    ],
    [
      { name: 'l', mode: '120000', hash: TREE, type: 'symlink' as const },
      { name: 'l', mode: '120000', sha: TREE, type: 'blob' },
    ],
    [
      { name: 's', mode: '160000', hash: TREE, type: 'gitlink' as const },
      { name: 's', mode: '160000', sha: TREE, type: 'commit' },
    ],
    [
      { name: 'f', mode: '100644', hash: TREE, type: 'blob' as const },
      { name: 'f', mode: '100644', sha: TREE, type: 'blob' },
    ],
  ])('maps %o', (entry, expected) => {
    expect(toStorageTreeEntry(entry)).toEqual(expected);
  });
});
