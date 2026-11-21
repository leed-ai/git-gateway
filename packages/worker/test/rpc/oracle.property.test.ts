// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '@leed-ai/git-gateway-contract/git-gateway';
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { createReferenceGateway } from '@leed-ai/git-gateway-contract/reference/reference-gateway';
import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { AUTHOR, memoryGateway } from '../helpers/memory-gateway.ts';

const REPO = 'oracle';
const PATHS = ['a.md', 'b.md', 'd', 'd/c.md', 'd/e/f.md'];
const BRANCHES = ['main', 'staging'] as const;

const path = fc.constantFrom(...PATHS);
const content = fc.constantFrom('x', 'y');
const action: fc.Arbitrary<CommitActionInput> = fc.oneof(
  fc.record({ action: fc.constant('create' as const), path, content }),
  { weight: 2, arbitrary: fc.record({ action: fc.constant('update' as const), path, content }) },
  { weight: 3, arbitrary: fc.record({ action: fc.constant('upsert' as const), path, content }) },
  fc.record({ action: fc.constant('delete' as const), path }),
  fc.record({ action: fc.constant('move' as const), previousPath: path, path }),
  fc.record({ action: fc.constant('chmod' as const), path, executeFilemode: fc.boolean() }),
);

type Operation =
  | { kind: 'commit'; branch: string; actions: CommitActionInput[]; key: string; startBranch: boolean }
  | { kind: 'sync'; from: string; into: string }
  | { kind: 'promote'; from: string; into: string; stale: boolean };

const branchPair = fc.constantFrom(['main', 'staging'], ['staging', 'main']);
const operation: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('commit' as const),
      branch: fc.constantFrom(...BRANCHES),
      actions: fc.array(action, { minLength: 1, maxLength: 3 }),
      key: fc.constantFrom('k1', 'k2', 'k3', 'k4', 'k5', 'k6'),
      startBranch: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: branchPair.map(([from = 'main', into = 'staging']) => ({ kind: 'sync' as const, from, into })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(branchPair, fc.boolean())
      .map(([[from = 'main', into = 'staging'], stale]) => ({ kind: 'promote' as const, from, into, stale })),
  },
);

/** What one call did, with every implementation-specific id removed. */
async function outcome(call: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await call();
    if (typeof result === 'object' && result !== null && 'status' in result) {
      const paths: unknown = Reflect.get(result, 'paths');
      return paths === undefined ? { status: result.status } : { status: result.status, paths };
    }
    return { ok: true };
  } catch (error) {
    return { error: readGatewayError(error)?.code ?? String(error) };
  }
}

async function apply(gateway: GitGateway, op: Operation): Promise<unknown> {
  if (op.kind === 'commit') {
    return outcome(() =>
      gateway.commit({
        repo: REPO,
        branch: op.branch,
        actions: op.actions,
        message: `op ${op.key}`,
        author: AUTHOR,
        idempotencyKey: op.key,
        ...(op.startBranch ? { startBranch: op.branch === 'main' ? 'staging' : 'main' } : {}),
      }),
    );
  }
  if (op.kind === 'sync')
    return outcome(() => gateway.syncBranch({ repo: REPO, from: op.from, into: op.into }));
  const head = (await gateway.log({ repo: REPO, ref: op.from, limit: 2 }).catch(() => null))?.commits;
  const sha = (op.stale ? head?.[1] : head?.[0])?.sha ?? '0'.repeat(40);
  return outcome(() => gateway.promote({ repo: REPO, from: op.from, into: op.into, sha }));
}

/** A branch's files (path, mode and blob id — git's blob ids in both implementations) and its history size. */
async function snapshot(gateway: GitGateway, branch: string): Promise<unknown> {
  const head = await gateway.resolveRef({ repo: REPO, ref: branch });
  if (head === null) return null;
  const listing = await gateway.listTree({ repo: REPO, ref: branch, recursive: true });
  const log = await gateway.log({ repo: REPO, ref: branch, limit: 500 });
  return {
    entries: listing?.entries.map(({ path: at, type, mode, sha }) => ({
      at,
      type,
      mode,
      sha: type === 'blob' ? sha : '',
    })),
    messages: log.commits.map((commit) => commit.message.trimEnd()).toSorted(),
    merges: log.commits.filter((commit) => commit.parents.length === 2).length,
  };
}

/** The same starting point in both: main with every file but "d", staging one commit ahead of it. */
async function seedBoth(gateway: GitGateway): Promise<void> {
  await gateway.createRepo({ repo: REPO });
  const files = ['a.md', 'b.md', 'd/c.md', 'd/e/f.md'];
  const base = { repo: REPO, author: AUTHOR, message: 'seed' };
  await gateway.commit({
    ...base,
    branch: 'main',
    idempotencyKey: 'seed-main',
    actions: files.map((at) => ({ action: 'create' as const, path: at, content: 'x' })),
  });
  await gateway.commit({
    ...base,
    branch: 'staging',
    startBranch: 'main',
    idempotencyKey: 'seed-staging',
    actions: [{ action: 'update', path: 'b.md', content: 'y' }],
  });
}

describe('the gateway against the contract oracle', () => {
  it('gives the same outcome, files and history as the in-memory reference for any sequence of calls', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 10 }), async (operations) => {
        const oracle = createReferenceGateway();
        const { gateway } = memoryGateway();
        for (const implementation of [oracle, gateway]) await seedBoth(implementation);
        for (const op of operations) {
          const expected = await apply(oracle, op);
          expect(await apply(gateway, op)).toEqual(expected);
          for (const branch of BRANCHES)
            expect(await snapshot(gateway, branch)).toEqual(await snapshot(oracle, branch));
        }
      }),
      { numRuns: 80 },
    );
  }, 120_000);
});
