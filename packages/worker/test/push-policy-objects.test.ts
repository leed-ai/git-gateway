// SPDX-License-Identifier: Apache-2.0
import { concatBytes, hexToBytes, readAllBytes, sha1Bytes, streamOf } from '@leed-ai/git-gateway-core/bytes';
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { encodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';
import type { GitTreeEntry } from '@leed-ai/git-gateway-core/schemas/git-object';
import { fixtureCommit } from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { GitHttpClient } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { describe, expect, it } from 'vite-plus/test';

import { readPushedObjects } from '../src/push-policy/pushed-objects.ts';
import { ChangeSink, diffTrees } from '../src/push-policy/tree-diff.ts';
import { ReadBudget, Uncheckable } from '../src/push-policy/uncheckable.ts';

const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);

/** A delta size varint. */
const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return out;
};

/** A one-entry thin pack: a REF_DELTA against `base` copying it whole and appending `suffix`. */
async function thinPack(base: { sha: string; data: Uint8Array }, suffix: Uint8Array): Promise<Uint8Array> {
  const length = base.data.length;
  const delta = Uint8Array.from([
    ...varint(length),
    ...varint(length + suffix.length),
    0x80 | 0x01 | 0x10 | 0x20,
    0,
    length & 0xff,
    length >> 8,
    suffix.length,
    ...suffix,
  ]);
  const deflated = await readAllBytes(streamOf(delta).pipeThrough(new CompressionStream('deflate')));
  const header = [0x80 | (7 << 4) | (delta.length & 0x0f), delta.length >> 4];
  const body = concatBytes([
    new TextEncoder().encode('PACK'),
    Uint8Array.from([0, 0, 0, 2, 0, 0, 0, 1, ...header]),
    hexToBytes(base.sha),
    deflated,
  ]);
  return concatBytes([body, await sha1Bytes(body)]);
}

async function storedTree() {
  const backend = new MemoryBackend();
  await backend.createRepo('site', { defaultBranch: 'main' });
  const seed = await fixtureCommit({ 'README.md': '# Site\n' });
  const client = new GitHttpClient(await backend.gitRemote('site', 'write'), { fetch: backend.fetch });
  await client.push([{ ref: 'refs/heads/main', oldSha: ZERO_SHA, newSha: seed.sha }], seed.objects);
  const tree = seed.objects.find((object) => object.type === 'tree');
  if (tree === undefined) throw new Error('no tree');
  return { backend, tree };
}

describe('readPushedObjects', () => {
  it('resolves a thin-pack tree delta against the tree storage has, verified by its id', async () => {
    const { backend, tree } = await storedTree();
    const entry = concatBytes([new TextEncoder().encode('100644 zz.md\0'), hexToBytes(BLOB_A)]);
    const pack = await thinPack(tree, entry);
    const budget = new ReadBudget(10);
    const objects = await readPushedObjects(pack, {
      repo: 'site',
      backend,
      budget,
      maxObjectBytes: 1_000_000,
    });
    const expected = await createObject('tree', concatBytes([tree.data, entry]));
    expect([...objects.trees.keys()]).toEqual([expected.sha]);
    expect(budget.used).toBe(1);
  });

  it('is uncheckable when a base is nowhere, the budget runs out, or the objects are too large', async () => {
    const { backend, tree } = await storedTree();
    const entry = concatBytes([new TextEncoder().encode('100644 zz.md\0'), hexToBytes(BLOB_A)]);
    const missing = await thinPack({ sha: BLOB_B, data: tree.data }, entry);
    const sources = { repo: 'site', backend, budget: new ReadBudget(10), maxObjectBytes: 1_000_000 };
    await expect(readPushedObjects(missing, sources)).rejects.toBeInstanceOf(Uncheckable);
    const pack = await thinPack(tree, entry);
    await expect(readPushedObjects(pack, { ...sources, budget: new ReadBudget(0) })).rejects.toThrow(
      /storage reads/,
    );
    await expect(readPushedObjects(pack, { ...sources, maxObjectBytes: 10 })).rejects.toThrow(
      /bytes of objects/,
    );
  });
});

describe('diffTrees', () => {
  const trees = new Map<string, GitTreeEntry[]>();
  let lookups = 0;
  const lookup = async (sha: string): Promise<readonly GitTreeEntry[]> => {
    lookups += 1;
    const found = trees.get(sha);
    if (found === undefined) throw new Uncheckable(`no tree ${sha}`);
    return found;
  };
  const tree = async (entries: GitTreeEntry[]): Promise<string> => {
    const { sha } = await createObject('tree', encodeTree(entries));
    trees.set(sha, entries);
    return sha;
  };

  it('reports files across type and mode changes, skipping unchanged subtrees', async () => {
    const shared = await tree([{ name: 'x.md', mode: '100644', sha: BLOB_A }]);
    const dir = await tree([{ name: 'inner', mode: '100644', sha: BLOB_B }]);
    const before = await tree([
      { name: 'same', mode: '040000', sha: shared },
      { name: 'run.sh', mode: '100644', sha: BLOB_A },
      { name: 'swap', mode: '100644', sha: BLOB_A },
    ]);
    const after = await tree([
      { name: 'same', mode: '040000', sha: shared },
      { name: 'run.sh', mode: '100755', sha: BLOB_A },
      { name: 'swap', mode: '040000', sha: dir },
    ]);
    lookups = 0;
    const changes = await diffTrees(lookup, before, after, new ChangeSink(100));
    expect(changes).toEqual([
      {
        path: 'run.sh',
        change: 'modified',
        oldMode: '100644',
        newMode: '100755',
        oldSha: BLOB_A,
        newSha: BLOB_A,
      },
      { path: 'swap/inner', change: 'added', oldMode: null, newMode: '100644', oldSha: null, newSha: BLOB_B },
      { path: 'swap', change: 'deleted', oldMode: '100644', newMode: null, oldSha: BLOB_A, newSha: null },
    ]);
    expect(lookups).toBe(3);
    await expect(diffTrees(lookup, null, after, new ChangeSink(1))).rejects.toThrow(/more than 1 paths/);
  });
});
