// SPDX-License-Identifier: Apache-2.0
// The release workflow is the only thing npm trusts to publish, so its shape is held here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { grantsIdToken } from '../src/oidc-policy.ts';
import { REPO_ROOT } from '../src/repo-root.ts';
import { requiredClauses } from '../src/workflow-condition.ts';
import { readWorkflowFiles } from '../src/workflow-files.ts';
import { triggersOf } from '../src/workflow-policy.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
const recordAt = (value: unknown, ...keys: string[]): Record<string, unknown> => {
  const found = at(value, ...keys);
  return isRecord(found) ? found : {};
};

const files = readWorkflowFiles(REPO_ROOT);
const release = files.find(({ path }) => path === '.github/workflows/release.yml')?.document;
const jobs = recordAt(release, 'jobs');

describe('npm publishing', () => {
  it('reads no npm token anywhere: trusted publishing (OIDC) only', () => {
    for (const { path, document } of files) {
      expect([path, JSON.stringify(document)]).not.toEqual([
        path,
        expect.stringMatching(/NPM_TOKEN|NODE_AUTH_TOKEN/),
      ]);
    }
  });

  it('comes from one workflow file, because a trusted publisher names exactly one', () => {
    expect(existsSync(join(REPO_ROOT, '.github/workflows/snapshot.yml'))).toBe(false);
    const oidc = files.flatMap(({ path, document }) =>
      Object.entries(recordAt(document, 'jobs'))
        .filter(([, job]) => grantsIdToken(at(job, 'permissions')))
        .map(([name]) => `${path}#${name}`),
    );
    expect(oidc).toEqual(['.github/workflows/release.yml#publish']);
  });

  it('snapshots on every push to main and releases by hand, dry run by default', () => {
    expect(triggersOf(release).toSorted()).toEqual(['push', 'workflow_dispatch']);
    expect(at(release, 'on', 'push', 'branches')).toEqual(['main']);
    expect(at(release, 'on', 'workflow_dispatch', 'inputs', 'dry_run', 'default')).toBe(true);
    expect(at(release, 'on', 'workflow_dispatch', 'inputs', 'mode', 'options')).toEqual([
      'release',
      'snapshot',
    ]);
  });

  it('publishes from a job pinned to npm-publish, gated on the NPM_PUBLISHING variable', () => {
    const publish = jobs['publish'];
    expect(at(publish, 'environment')).toBe('npm-publish');
    expect(at(publish, 'permissions')).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(at(publish, 'needs')).toBe('pack');
    expect(requiredClauses(String(at(publish, 'if')))).toEqual(
      expect.arrayContaining(["vars.NPM_PUBLISHING == 'true'", "github.ref == 'refs/heads/main'"]),
    );
  });

  it('verifies and packs in a read-only job without an OIDC token', () => {
    expect(at(jobs['pack'], 'permissions')).toEqual({ contents: 'read' });
    const runs = JSON.stringify(at(jobs['pack'], 'steps'));
    for (const command of ['bun run verify', 'bun run test:contract', 'pack-packages.ts', '--dry-run']) {
      expect(runs).toContain(command);
    }
  });

  it('tags and releases only after a latest publish has succeeded', () => {
    const releases = jobs['github-releases'];
    expect(at(releases, 'needs')).toEqual(['pack', 'publish']);
    expect(at(releases, 'permissions')).toEqual({ contents: 'write' });
    expect(requiredClauses(String(at(releases, 'if')))).toContain("needs.pack.outputs.tag == 'latest'");
  });
});
