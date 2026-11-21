// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { applyActions } from '../../src/reference/apply-actions.ts';
import { utf8 } from '../../src/reference/bytes.ts';
import type { StoredFile } from '../../src/reference/file-map.ts';
import { blobSha } from '../../src/reference/hash.ts';
import { readGatewayError } from '../../src/gateway-error.ts';
import { CommitAction } from '../../src/schemas/commit-action.ts';

const segment = fc.constantFrom('a', 'b', 'c', 'docs', 'x.md', 'y.md');
const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
const action = fc.oneof(
  fc.record({ action: fc.constant('create'), path, content: fc.string({ maxLength: 4 }) }),
  fc.record({ action: fc.constant('update'), path, content: fc.string({ maxLength: 4 }) }),
  fc.record({ action: fc.constant('upsert'), path, content: fc.string({ maxLength: 4 }) }),
  fc.record({ action: fc.constant('delete'), path }),
  fc
    .record({ action: fc.constant('move'), path, previousPath: path })
    .filter((a) => a.path !== a.previousPath),
  fc.record({ action: fc.constant('chmod'), path, executeFilemode: fc.boolean() }),
);

async function stored(content: string): Promise<StoredFile> {
  const bytes = utf8(content);
  return { bytes, executable: false, sha: await blobSha(bytes) };
}

describe('applyActions (property)', () => {
  it('leaves every untouched file byte-for-byte as it was, and never leaves a file beneath a file', async () => {
    const base = new Map([
      ['untouched/keep.md', await stored('keep')],
      ['docs/x.md', await stored('x')],
    ]);
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 6 }), async (raw) => {
        const actions = raw.map((entry) => CommitAction.parse(entry));
        const outcome = await applyActions(base, actions).then(
          (next) => ({ next, code: undefined }),
          (thrown: unknown) => ({ next: undefined, code: readGatewayError(thrown)?.code }),
        );
        const next = outcome.next ?? base;
        expect(next.get('untouched/keep.md')).toBe(base.get('untouched/keep.md'));
        const fileUnderFile = [...next.keys()].filter((key) =>
          key
            .split('/')
            .slice(0, -1)
            .some((_, i, parts) => next.has(parts.slice(0, i + 1).join('/'))),
        );
        expect(fileUnderFile).toEqual([]);
        expect(
          outcome.next !== undefined || /^path_(exists|not_found|conflict)$/.test(outcome.code ?? ''),
        ).toBe(true);
        expect(base.size).toBe(2);
      }),
    );
  });
});
