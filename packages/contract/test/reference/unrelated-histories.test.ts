// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { readGatewayError } from '../../src/gateway-error.ts';
import { referenceSyncBranch } from '../../src/reference/branch-methods.ts';
import { referenceCommit } from '../../src/reference/commit-method.ts';
import { referenceCreateRepo } from '../../src/reference/lifecycle-methods.ts';
import type { ReferenceContext } from '../../src/reference/repo-state.ts';
import { GatewayConfig } from '../../src/schemas/gateway-config.ts';

// The RPC API cannot create a second root commit (only a push can), so this rule is checked
// against the reference's internals rather than in the behaviour suite.
describe('syncBranch on unrelated histories', () => {
  it('fails with unrelated_histories', async () => {
    const context: ReferenceContext = {
      config: GatewayConfig.parse({}),
      now: () => new Date(),
      repos: new Map(),
    };
    await referenceCreateRepo(context, { repo: 'r' });
    const commit = (branch: string, key: string) =>
      referenceCommit(context, {
        repo: 'r',
        branch,
        message: 'root',
        author: { name: 'A', email: 'a@example.com' },
        idempotencyKey: key,
        actions: [{ action: 'create', path: `${branch}.md`, content: branch }],
      });
    await commit('main', 'one');
    const branches = context.repos.get('r')?.branches ?? new Map<string, string>();
    const mainHead = branches.get('main') ?? '';
    branches.clear();
    await commit('orphan', 'two');
    branches.set('main', mainHead);

    const thrown = await referenceSyncBranch(context, { repo: 'r', from: 'orphan', into: 'main' }).catch(
      (error: unknown) => error,
    );
    expect(readGatewayError(thrown)).toEqual({
      code: 'unrelated_histories',
      message: 'orphan and main share no history',
      details: { from: 'orphan', into: 'main' },
    });
  });
});
