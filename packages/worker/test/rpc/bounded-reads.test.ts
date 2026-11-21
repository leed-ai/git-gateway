// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { MemoryBackend } from '@leed-ai/git-gateway-testkit/memory/memory-backend';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { dagCommits, linearDag, shaOf, type DagNode } from '../helpers/commit-dag.ts';
import { memoryGateway } from '../helpers/memory-gateway.ts';

const REPO = 'big';
const LENGTH = 1000;

/** A memory backend whose `big` repository serves a synthetic history and counts commit reads. */
class DagBackend extends MemoryBackend {
  readCommits = 0;
  readonly refs = new Map<string, string>();
  #commits = new Map<string, Commit>();

  load(nodes: readonly DagNode[]): void {
    this.#commits = dagCommits(nodes);
  }

  override async resolveRef(name: string, ref: string): Promise<string | null> {
    if (name !== REPO) return super.resolveRef(name, ref);
    return this.refs.get(ref) ?? null;
  }

  override async readCommit(name: string, sha: string): Promise<Commit | null> {
    if (name !== REPO) return super.readCommit(name, sha);
    this.readCommits += 1;
    return this.#commits.get(sha) ?? null;
  }
}

async function errorOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readGatewayError(error);
  }
  throw new Error('expected the call to fail');
}

describe('RPC reads stay bounded on a 1,000-commit history', () => {
  let backend: DagBackend;

  beforeEach(async () => {
    backend = new DagBackend();
    await backend.createRepo(REPO);
    // A 1,000-commit trunk on main; staging is two commits of its own off the trunk's head.
    const nodes = linearDag(LENGTH);
    nodes.push({ parents: [LENGTH - 1], time: LENGTH * 1000 });
    nodes.push({ parents: [LENGTH], time: (LENGTH + 1) * 1000 });
    backend.load(nodes);
    backend.refs.set('refs/heads/main', shaOf(LENGTH - 1));
    backend.refs.set('refs/heads/staging', shaOf(LENGTH + 1));
  });

  it('log({limit: 10}) reads about a page of commits', async () => {
    const { gateway } = memoryGateway({}, backend);
    const log = await gateway.log({ repo: REPO, ref: 'main', limit: 10 });
    expect(log.commits.map((commit) => commit.sha)).toEqual(
      Array.from({ length: 10 }, (_, index) => shaOf(LENGTH - 1 - index)),
    );
    expect(log.hasMore).toBe(true);
    expect(backend.readCommits).toBeLessThanOrEqual(15);
  });

  it('syncBranch finds staging already contains main without walking the trunk', async () => {
    const { gateway } = memoryGateway({}, backend);
    expect(await gateway.syncBranch({ repo: REPO, from: 'main', into: 'staging' })).toEqual({
      status: 'up_to_date',
      head: shaOf(LENGTH + 1),
    });
    expect(backend.readCommits).toBeLessThanOrEqual(15);
  });

  it('promote refuses a non-fast-forward without walking the trunk', async () => {
    const { gateway } = memoryGateway({}, backend);
    const error = await errorOf(
      gateway.promote({ repo: REPO, from: 'main', into: 'staging', sha: shaOf(LENGTH - 1) }),
    );
    expect(error).toMatchObject({ code: 'not_fast_forward' });
    expect(backend.readCommits).toBeLessThanOrEqual(15);
  });

  it('commitExists on a branch that does not contain the commit stays bounded', async () => {
    const { gateway } = memoryGateway({}, backend);
    expect(await gateway.commitExists({ repo: REPO, sha: shaOf(LENGTH + 1), branch: 'main' })).toEqual({
      exists: false,
    });
    expect(backend.readCommits).toBeLessThanOrEqual(15);
  });
});
