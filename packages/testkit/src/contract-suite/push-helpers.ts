// SPDX-License-Identifier: Apache-2.0
import { assertEqual, BehaviourFailure } from '@leed-ai/git-gateway-contract/behaviour/assertions';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import type { ReportStatus } from '@leed-ai/git-gateway-core/schemas/report-status';

import type { BackendContext } from './backend-case.ts';
import { fixtureCommit, type FixtureCommit } from './backend-fixtures.ts';

/** Pushes one ref update (and the objects it needs) through a write remote; returns the report. */
export async function pushRef(
  context: BackendContext,
  ref: string,
  oldSha: string,
  newSha: string,
  objects: readonly GitObject[] = [],
): Promise<ReportStatus> {
  const client = await context.client('write');
  return client.push([{ oldSha, newSha, ref }], objects);
}

/** Fails unless the report says the pack unpacked and `ref` was updated. */
export function expectAccepted(report: ReportStatus, ref: string): void {
  assertEqual(report, { unpack: 'ok', refs: [{ ref, status: 'ok' }] }, `push to ${ref} accepted`);
}

/** Fails unless the report refused `ref`; returns the reason the host gave. */
export function expectRefused(report: ReportStatus, ref: string): string {
  const status = report.refs.find((entry) => entry.ref === ref);
  if (status?.status !== 'ng') {
    throw new BehaviourFailure(`expected the push to ${ref} to be refused, got ${JSON.stringify(report)}`);
  }
  return status.reason;
}

/** Pushes a commit as a new branch and fails unless it was accepted. */
export async function pushNewBranch(
  context: BackendContext,
  branch: string,
  commit: FixtureCommit,
): Promise<void> {
  expectAccepted(
    await pushRef(context, `refs/heads/${branch}`, ZERO_SHA, commit.sha, commit.objects),
    `refs/heads/${branch}`,
  );
}

/** Creates the case's repository and pushes one commit to "main"; returns that commit. */
export async function seedRepo(
  context: BackendContext,
  files: Parameters<typeof fixtureCommit>[0] = { 'README.md': '# Seed\n' },
): Promise<FixtureCommit> {
  await context.backend.createRepo(context.repo, { defaultBranch: 'main' });
  const commit = await fixtureCommit(files);
  await pushNewBranch(context, 'main', commit);
  return commit;
}

/** The objects a child commit adds on top of its parent (everything not already pushed). */
export function newObjects(child: FixtureCommit, parent: FixtureCommit): GitObject[] {
  const known = new Set(parent.objects.map((object) => object.sha));
  return child.objects.filter((object) => !known.has(object.sha));
}
