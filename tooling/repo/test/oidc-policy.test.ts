// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { installsDependencies } from '../src/oidc-policy.ts';
import { findWorkflowViolations, type WorkflowFile } from '../src/workflow-policy.ts';

const GUARD = "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main'";
const RELEASE = '.github/workflows/release.yml';
const workflow = (document: Record<string, unknown>, path = RELEASE): WorkflowFile => ({
  path,
  document: { on: 'workflow_dispatch', permissions: { contents: 'read' }, ...document },
});
const messages = (...files: WorkflowFile[]): string[] =>
  findWorkflowViolations(files).map(({ message }) => message);
const publishJob = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  if: GUARD,
  environment: 'npm-publish',
  permissions: { contents: 'read', 'id-token': 'write' },
  steps: [
    { run: 'npm install --global npm@^11.5.1' },
    { run: 'bun tooling/repo/src/cli/publish-packages.ts' },
  ],
  ...fields,
});

describe('jobs holding id-token: write', () => {
  it('pass when guarded, pinned to an environment and installing nothing', () => {
    expect(messages(workflow({ jobs: { publish: publishJob() } }))).toEqual([]);
  });

  it('must be limited to this repository’s main branch', () => {
    expect(
      messages(workflow({ jobs: { publish: publishJob({ if: "github.ref == 'refs/heads/main'" }) } })),
    ).toEqual(['job "publish" holds id-token: write without an if: limiting it to leed-ai/git-gateway main']);
    expect(messages(workflow({ jobs: { publish: publishJob({ if: undefined }) } }))).toHaveLength(1);
  });

  it('must declare an environment', () => {
    expect(messages(workflow({ jobs: { publish: publishJob({ environment: undefined }) } }))).toEqual([
      'job "publish" holds id-token: write without an environment pinning the ref',
    ]);
    expect(
      messages(workflow({ jobs: { publish: publishJob({ environment: { name: 'npm-publish' } }) } })),
    ).toEqual([]);
  });

  it.each([
    [{ uses: './.github/actions/setup-toolchain' }],
    [{ run: 'bun install --frozen-lockfile' }],
    [{ run: 'echo hi\nnpm ci' }],
    [{ run: 'npm install left-pad' }],
  ])('must not install dependencies: %j', (step) => {
    expect(messages(workflow({ jobs: { publish: publishJob({ steps: [step] }) } }))).toEqual([
      'job "publish" holds id-token: write and installs dependencies; install, build and pack in another job',
    ]);
  });

  it('are counted under write-all too, and never granted workflow-wide', () => {
    expect(
      messages(
        workflow({ jobs: { publish: publishJob({ permissions: 'write-all', environment: undefined }) } }),
      ),
    ).toEqual(['job "publish" holds id-token: write without an environment pinning the ref']);
    expect(messages(workflow({ permissions: { 'id-token': 'write' }, jobs: {} }))).toEqual([
      'id-token: write must be granted per job, never in the top-level permissions',
    ]);
  });
});

describe('the npm-publish environment', () => {
  it('is used only by release.yml, the workflow file npm trusts', () => {
    expect(messages(workflow({ jobs: { publish: publishJob() } }, '.github/workflows/snapshot.yml'))).toEqual(
      ['job "publish" uses the npm-publish environment outside .github/workflows/release.yml'],
    );
  });
});

describe('installsDependencies', () => {
  it('allows upgrading npm itself, and nothing else', () => {
    expect(installsDependencies('npm install --global npm@^11.5.1')).toBe(false);
    expect(installsDependencies('npm i -g npm@11')).toBe(false);
    expect(installsDependencies('npm install --global npm@11 left-pad')).toBe(true);
    expect(installsDependencies('bun add x')).toBe(true);
    expect(installsDependencies('npm publish x.tgz')).toBe(false);
  });
});
