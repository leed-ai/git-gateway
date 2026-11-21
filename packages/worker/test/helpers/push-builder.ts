// SPDX-License-Identifier: Apache-2.0
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import { createCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { writePack } from '@leed-ai/git-gateway-core/pack/write-pack';
import { encodeReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/encode-request';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WHO = { name: 'Ada', email: 'ada@example.com', date: '2026-11-20T09:00:00.000Z' };

/** A commit object on the empty tree with the given parents. */
export async function commitObject(parents: readonly string[], message: string): Promise<GitObject> {
  const { object } = await createCommit({
    tree: EMPTY_TREE,
    parents: [...parents],
    author: WHO,
    committer: WHO,
    message: `${message}\n`,
  });
  return object;
}

/** The empty tree object, which every commit here points at. */
export async function emptyTree(): Promise<GitObject> {
  return createObject('tree', new Uint8Array(0));
}

/** A receive-pack request body: commands, capabilities and a pack of `objects` (none for deletes only). */
export async function pushBody(
  commands: readonly { ref: string; oldSha: string; newSha: string }[],
  objects: readonly GitObject[] | null,
  capabilities: readonly string[] = ['report-status', 'side-band-64k', 'agent=git/2.43.0'],
): Promise<Uint8Array> {
  return encodeReceivePackRequest({
    commands: [...commands],
    capabilities: [...capabilities],
    ...(objects === null ? {} : { pack: await writePack(objects) }),
  });
}
