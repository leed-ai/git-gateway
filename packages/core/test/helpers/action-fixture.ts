// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';

import { applyCommitActions } from '../../src/actions/apply-commit-actions.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import { editTree } from '../../src/tree/edit-tree.ts';
import { MemoryStore, textFile } from './memory-store.ts';

/** UTF-8 bytes of a string. */
export const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
/** The blob id of some text. */
export const sha = async (text: string): Promise<string> => hashObject('blob', bytes(text));

/** A repository with a regular file, an executable, a symbolic link, a submodule and nested directories. */
export async function setup(): Promise<{ store: MemoryStore; root: string }> {
  const store = new MemoryStore();
  const files = await store.writeSnapshot(
    new Map([
      ['README.md', textFile('# Site\n')],
      ['content/about.md', textFile('About\n')],
      ['content/blog/one.md', textFile('One\n')],
      ['scripts/build.sh', textFile('#!/bin/sh\n', '100755')],
      ['current', textFile('content/about.md', '120000')],
    ]),
  );
  const withSubmodule = await editTree(
    { tree: files, changes: [{ op: 'set', path: 'vendor/lib', mode: '160000', sha: '1'.repeat(40) }] },
    store,
  );
  store.put(withSubmodule.objects);
  return { store, root: withSubmodule.tree };
}

/** The files after applying actions to the setup repository. */
export async function apply(actions: CommitActionInput[]): Promise<Map<string, GitTreeEntry>> {
  const { store, root } = await setup();
  const result = await applyCommitActions({ tree: root, actions }, store);
  if (result.status === 'noop') return store.flatten(root);
  store.put(result.objects);
  return store.flatten(result.tree);
}

/** The contract error the actions fail with, or null when they succeed. */
export async function errorOf(
  actions: CommitActionInput[],
): Promise<{ code: string; details: unknown } | null> {
  const { store, root } = await setup();
  try {
    await applyCommitActions({ tree: root, actions }, store);
  } catch (thrown) {
    const body = readGatewayError(thrown);
    if (body === null) throw thrown;
    return { code: body.code, details: body.details };
  }
  return null;
}
