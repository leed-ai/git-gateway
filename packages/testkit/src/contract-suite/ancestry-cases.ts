// SPDX-License-Identifier: Apache-2.0
import { assertEqual, expectGatewayError } from '@leed-ai/git-gateway-contract/behaviour/assertions';

import { backendCase, type BackendCase, type BackendContext } from './backend-case.ts';
import { fixtureCommit } from './backend-fixtures.ts';
import { expectAccepted, newObjects, pushNewBranch, pushRef, seedRepo } from './push-helpers.ts';

const GROUP = 'ancestry';
const MISSING = '0123456789abcdef0123456789abcdef01234567';

/** The optional isAncestor capability, or null when the backend does not offer it (the case passes). */
function capability(context: BackendContext) {
  const { backend } = context;
  if (backend.isAncestor === undefined) return null;
  return async (ancestor: string, descendant: string, repo = context.repo) =>
    backend.isAncestor?.(repo, ancestor, descendant);
}

/** isAncestor, for backends that offer it; a backend without it passes every case. */
export const ancestryCases: readonly BackendCase[] = [
  backendCase(GROUP, 'isAncestor answers as git merge-base --is-ancestor does', async (context) => {
    const isAncestor = capability(context);
    if (isAncestor === null) return;
    const root = await seedRepo(context, { 'a.txt': 'a\n' });
    const second = await fixtureCommit({ 'a.txt': 'a, revised\n' }, [root.sha], 'Second\n');
    expectAccepted(
      await pushRef(context, 'refs/heads/main', root.sha, second.sha, newObjects(second, root)),
      'refs/heads/main',
    );
    const side = await fixtureCommit({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, [root.sha], 'Side\n');
    const merge = await fixtureCommit(
      { 'a.txt': 'a, revised\n', 'b.txt': 'b\n' },
      [second.sha, side.sha],
      'Merge\n',
    );
    await pushNewBranch(context, 'topic', { ...merge, objects: [...side.objects, ...merge.objects] });
    assertEqual(await isAncestor(root.sha, second.sha), true, 'parent of a commit');
    assertEqual(await isAncestor(root.sha, merge.sha), true, 'grandparent through a merge');
    assertEqual(await isAncestor(side.sha, merge.sha), true, 'second parent of a merge');
    assertEqual(await isAncestor(merge.sha, merge.sha), true, 'a commit is its own ancestor');
    assertEqual(await isAncestor(second.sha, side.sha), false, 'siblings');
    assertEqual(await isAncestor(merge.sha, root.sha), false, 'a descendant is not an ancestor');
  }),
  backendCase(
    GROUP,
    'isAncestor is null for an unknown commit and repo_not_found for a missing repository',
    async (context) => {
      const isAncestor = capability(context);
      if (isAncestor === null) return;
      const root = await seedRepo(context);
      assertEqual(await isAncestor(MISSING, root.sha), null, 'unknown ancestor');
      assertEqual(await isAncestor(root.sha, MISSING), null, 'unknown descendant');
      await expectGatewayError(isAncestor(root.sha, root.sha, `${context.repo}-missing`), 'repo_not_found');
    },
  ),
];
