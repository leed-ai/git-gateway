// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import { applyActions } from '@leed-ai/git-gateway-contract/reference/apply-actions';
import { CommitAction, type CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { applyCommitActions } from '../../src/actions/apply-commit-actions.ts';
import { arbitraryContent, arbitraryPath, arbitrarySnapshot } from '../helpers/arbitraries.ts';
import { MemoryStore } from '../helpers/memory-store.ts';
import { fileMapSignature, flattenSignature, toFileMap, toSnapshot } from '../helpers/reference-model.ts';

const action: fc.Arbitrary<CommitActionInput> = fc.oneof(
  fc.record({ action: fc.constant('create' as const), path: arbitraryPath, content: arbitraryContent }),
  fc.record({ action: fc.constant('update' as const), path: arbitraryPath, content: arbitraryContent }),
  fc.record({ action: fc.constant('upsert' as const), path: arbitraryPath, content: arbitraryContent }),
  fc.record({ action: fc.constant('delete' as const), path: arbitraryPath }),
  fc
    .record({
      action: fc.constant('move' as const),
      path: arbitraryPath,
      previousPath: arbitraryPath,
      content: fc.option(arbitraryContent, { nil: undefined }),
    })
    .filter((move) => move.path !== move.previousPath)
    .map(({ content, ...rest }) => (content === undefined ? rest : { ...rest, content })),
  fc.record({ action: fc.constant('chmod' as const), path: arbitraryPath, executeFilemode: fc.boolean() }),
);

/** What an implementation did: the resulting files, or the error code and details. */
type Outcome = { files: Map<string, string> } | { error: unknown };

async function outcome(run: () => Promise<Map<string, string>>): Promise<Outcome> {
  try {
    return { files: await run() };
  } catch (thrown) {
    const body = readGatewayError(thrown);
    if (body === null) throw thrown;
    return { error: { code: body.code, details: body.details } };
  }
}

describe('applyCommitActions against the contract reference model', () => {
  it('produces the same files or the same error for any snapshot and actions', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitrarySnapshot,
        fc.array(action, { minLength: 1, maxLength: 6 }),
        async (snapshot, actions) => {
          const parsed = actions.map((input) => CommitAction.parse(input));
          const expected = await outcome(async () =>
            fileMapSignature(await applyActions(await toFileMap(snapshot), parsed)),
          );
          const store = new MemoryStore();
          const root = await store.writeSnapshot(toSnapshot(snapshot));
          const actual = await outcome(async () => {
            const result = await applyCommitActions({ tree: root, actions }, store);
            // A no-op returns the base tree; a change never does.
            expect(result.status === 'noop' ? result.tree === root : result.tree !== root).toBe(true);
            store.put(result.status === 'changed' ? result.objects : []);
            return flattenSignature(store, result.tree);
          });
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 400 },
    );
  });
});
