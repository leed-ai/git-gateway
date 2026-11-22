// SPDX-License-Identifier: Apache-2.0
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { parseReportStatus } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import { encodeReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/encode-request';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import {
  fixtureCommit,
  type FixtureCommit,
} from '@leed-ai/git-gateway-testkit/contract-suite/backend-fixtures';
import { describe, expect, it } from 'vite-plus/test';

import { policyGateway, REPO } from './helpers/policy-gateway.ts';
import { writeThinPack } from './helpers/thin-pack.ts';

const PAGE = Array.from({ length: 40 }, (_, line) => `Line ${line} of the page.\n`).join('');
const EDITED = PAGE.replace('Line 20 of the page.', 'Line 20 of the page, edited.');

const blobOf = (commit: FixtureCommit, content: string): GitObject => {
  const bytes = new TextEncoder().encode(content);
  const blob = commit.objects.find(
    (object) =>
      object.type === 'blob' &&
      object.data.length === bytes.length &&
      object.data.every((b, i) => b === bytes[i]),
  );
  if (blob === undefined) throw new Error('no such blob');
  return blob;
};

/**
 * A one-line edit to an existing file pushed as `git push` sends it: the commit and trees whole,
 * the edited file as a delta against the blob storage already has.
 */
async function thinEdit() {
  const gateway = await policyGateway({ 'docs/page.md': PAGE, 'README.md': '# Site\n' });
  const next = await fixtureCommit({ 'docs/page.md': EDITED, 'README.md': '# Site\n' }, [gateway.seed.sha]);
  const base = blobOf(gateway.seed, PAGE);
  const target = blobOf(next, EDITED);
  const whole = next.objects.filter(
    (object) => object.type !== 'blob' && !gateway.seed.objects.some((known) => known.sha === object.sha),
  );
  const pack = await writeThinPack(whole, [{ base, target }]);
  const push = async () => {
    const response = await gateway.app.request(`/${REPO}.git/git-receive-pack`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa('git:x')}` },
      body: encodeReceivePackRequest({
        commands: [{ ref: 'refs/heads/main', oldSha: gateway.seed.sha, newSha: next.sha }],
        capabilities: ['report-status'],
        pack,
      }),
    });
    return parseReportStatus(new Uint8Array(await response.arrayBuffer()), { sideBand: 'none' });
  };
  return { ...gateway, next, base, target, push };
}

describe('push policy over a thin pack', () => {
  it('checks a push whose pack deltas against a blob storage has, reading it as a tree first', async () => {
    const { push, policy, head, next, base, target, backend } = await thinEdit();
    const reads: string[] = [];
    const readTree = backend.readTree.bind(backend);
    const readBlob = backend.readBlob.bind(backend);
    backend.readTree = async (repo, sha) => (reads.push(`tree ${sha}`), readTree(repo, sha));
    backend.readBlob = async (repo, sha) => (reads.push(`blob ${sha}`), readBlob(repo, sha));

    const report = await push();

    expect(report.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(await head()).toBe(next.sha);
    // The base is asked for as a tree (null: it is a blob), then read as a blob.
    expect(reads.slice(0, 2)).toEqual([`tree ${base.sha}`, `blob ${base.sha}`]);
    expect(policy.inputs[0]?.updates[0]?.commits?.[0]?.changes).toEqual([
      {
        path: 'docs/page.md',
        change: 'modified',
        oldMode: '100644',
        newMode: '100644',
        oldSha: base.sha,
        newSha: target.sha,
        size: target.data.length,
      },
    ]);
  });

  it('still refuses, as uncheckable, when storage fails reading the base', async () => {
    const { push, policy, head, seed, backend } = await thinEdit();
    // An outage is not "no tree has that id": the gateway does not guess, it refuses.
    backend.readTree = async () => Promise.reject(storageUnavailable('readTree', new Error('down')));

    const report = await push();

    expect(report.refs[0]).toMatchObject({
      status: 'ng',
      reason: 'the push could not be checked; try again later',
    });
    expect(await head()).toBe(seed.sha);
    expect(policy.inputs).toHaveLength(0);
  });
});
