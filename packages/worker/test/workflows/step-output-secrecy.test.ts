// SPDX-License-Identifier: Apache-2.0
import { readGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';
import type { z } from 'zod';

import { CommitStepResult, CommitWorkflowParams } from '../../src/workflows/commit-workflow-schemas.ts';
import { runCommitWorkflow } from '../../src/workflows/run-commit-workflow.ts';
import { runSyncWorkflow } from '../../src/workflows/run-sync-workflow.ts';
import { SyncStepResult } from '../../src/workflows/sync-workflow-schemas.ts';
import { CapturingBackend, stringsIn } from '../helpers/capturing-backend.ts';
import { FakeStepRunner, FatalStepError, markFatal } from '../helpers/fake-workflow.ts';
import { AUTHOR, key, memoryGateway, seed, write } from '../helpers/memory-gateway.ts';

const REPO = 'secrecy';
const SECRET_CONTENT = 'TOP-SECRET-FILE-CONTENT the step must never store';
const SECRET_MESSAGE = 'Confidential commit message';
/** Every field name a step result may carry. */
const RESULT_KEYS = new Set(['status', 'sha', 'head', 'paths', 'base', 'fromHead', 'intoHead']);

/** Every object field name a step result schema can produce, across every branch. */
function fieldNames(schema: { readonly options: readonly z.ZodObject[] }): string[] {
  return schema.options.flatMap((option) => Object.keys(option.shape));
}

describe('Workflow step outputs', () => {
  it('can only ever hold ids, statuses and paths (by schema)', () => {
    expect(new Set(fieldNames(CommitStepResult))).toEqual(new Set(['status', 'sha', 'head']));
    expect(new Set(fieldNames(SyncStepResult))).toEqual(
      new Set(['status', 'head', 'paths', 'base', 'fromHead', 'intoHead']),
    );
  });

  it('never contain file content, a message or a credential (committed, crashed, replayed, noop, synced, conflicted)', async () => {
    const backend = new CapturingBackend();
    const { gateway, context } = memoryGateway({}, backend);
    await seed(gateway, REPO, { 'shared.md': 'base\n' });
    const runner = new FakeStepRunner();
    const commit = (idempotencyKey: string, content: string) =>
      CommitWorkflowParams.parse({
        repo: REPO,
        branch: 'main',
        message: SECRET_MESSAGE,
        author: AUTHOR,
        idempotencyKey,
        actions: [
          { action: 'upsert', path: 'secret.md', content },
          {
            action: 'create',
            path: `binary-${idempotencyKey}.bin`,
            content: btoa(content),
            encoding: 'base64',
          },
        ],
      });

    const crashKey = key('crash');
    runner.crashAfterNextRun('commit');
    await runCommitWorkflow(context, commit(crashKey, SECRET_CONTENT), runner, markFatal).catch(
      () => undefined,
    );
    await runCommitWorkflow(context, commit(crashKey, SECRET_CONTENT), runner, markFatal);
    await runCommitWorkflow(context, commit(key(), `${SECRET_CONTENT} 2`), new FakeStepRunner(), markFatal);
    const noop = {
      ...commit(key(), SECRET_CONTENT),
      actions: [{ action: 'update' as const, path: 'shared.md', content: 'base\n' }],
    };
    const noopRunner = new FakeStepRunner();
    await runCommitWorkflow(context, noop, noopRunner, markFatal);

    await write(
      gateway,
      REPO,
      'staging',
      { 'shared.md': `${SECRET_CONTENT} staging` },
      { startBranch: 'main' },
    );
    const syncRunner = new FakeStepRunner();
    const fromHead = (await gateway.resolveRef({ repo: REPO, ref: 'main' }))?.sha ?? '';
    await runSyncWorkflow(
      context,
      { repo: REPO, from: 'main', into: 'staging', fromHead },
      syncRunner,
      markFatal,
    );
    await write(gateway, REPO, 'main', { 'shared.md': `${SECRET_CONTENT} main` });
    const conflictRunner = new FakeStepRunner();
    await runSyncWorkflow(
      context,
      { repo: REPO, from: 'main', into: 'staging', fromHead },
      conflictRunner,
      markFatal,
    );

    const outputs = [runner, noopRunner, syncRunner, conflictRunner].flatMap((entry) => entry.outputs);
    expect(outputs.length).toBeGreaterThanOrEqual(5);
    expect(backend.credentials.length).toBeGreaterThan(0);
    const forbidden = [
      SECRET_CONTENT,
      btoa(SECRET_CONTENT),
      SECRET_MESSAGE,
      'Bearer',
      ...backend.credentials,
    ];
    for (const text of stringsIn(outputs)) {
      for (const secret of forbidden) expect(text).not.toContain(secret);
    }
    expect(stringsIn(outputs).every((text) => /^[a-z_]+$|^[0-9a-f]{40}$|\.md$/.test(text))).toBe(true);
  });
});

describe('Workflow step result schemas', () => {
  const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
  const result = fc.oneof(
    fc.record({ status: fc.constantFrom('committed', 'replayed'), sha }),
    fc.record({ status: fc.constant('noop'), head: fc.option(sha, { nil: null }) }),
  );
  const syncResult = fc.oneof(
    fc.record({ status: fc.constantFrom('up_to_date', 'fast_forward', 'merged'), head: sha }),
    fc.record({
      status: fc.constant('conflict'),
      paths: fc.constant(['shared.md']),
      base: sha,
      fromHead: sha,
      intoHead: sha,
    }),
  );
  const extraKey = fc.oneof(
    fc.constantFrom('content', 'token', 'message', 'credential', 'actions', 'authorization'),
    fc.string({ minLength: 1, maxLength: 12 }).filter((name) => !RESULT_KEYS.has(name)),
  );

  it('refuse any field beyond ids, statuses and paths, so content or a token can never be stored', () => {
    fc.assert(
      fc.property(result, syncResult, extraKey, fc.string(), (commitValue, syncValue, extra, value) => {
        expect(CommitStepResult.safeParse(commitValue).success).toBe(true);
        expect(SyncStepResult.safeParse(syncValue).success).toBe(true);
        expect(CommitStepResult.safeParse({ ...commitValue, [extra]: value }).success).toBe(false);
        expect(SyncStepResult.safeParse({ ...syncValue, [extra]: value }).success).toBe(false);
      }),
    );
  });
});

/** Every string a stopped instance would persist: the error message and its GatewayError body. */
async function persistedBy(run: Promise<unknown>): Promise<string[]> {
  const thrown: unknown = await run.then(
    () => {
      throw new Error('expected the instance to stop');
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(FatalStepError);
  return [String(Reflect.get(Object(thrown), 'message')), ...stringsIn(readGatewayError(thrown))];
}

describe('Errors that stop a Workflow instance', () => {
  it('never carry file content, the commit message or a credential', async () => {
    const backend = new CapturingBackend();
    const { gateway, context } = memoryGateway({}, backend);
    const head = await seed(gateway, REPO, { 'shared.md': 'base\n' });
    const base = {
      repo: REPO,
      branch: 'main',
      message: SECRET_MESSAGE,
      author: AUTHOR,
      idempotencyKey: key('fatal'),
    };
    const persisted = [
      // Invalid params: the payload carries content but the author is not a valid identity.
      ...(await persistedBy(
        runCommitWorkflow(
          context,
          {
            ...base,
            author: { name: '', email: 'not an email' },
            actions: [{ action: 'upsert', path: 'secret.md', content: SECRET_CONTENT }],
          },
          new FakeStepRunner(),
          markFatal,
        ),
      )),
      // A broken rule inside the step: creating a path that already exists.
      ...(await persistedBy(
        runCommitWorkflow(
          context,
          { ...base, actions: [{ action: 'create', path: 'shared.md', content: SECRET_CONTENT }] },
          new FakeStepRunner(),
          markFatal,
        ),
      )),
      // A stale expected head inside the step.
      ...(await persistedBy(
        runCommitWorkflow(
          context,
          {
            ...base,
            expectedHead: 'f'.repeat(40),
            actions: [{ action: 'upsert', path: 'secret.md', content: SECRET_CONTENT }],
          },
          new FakeStepRunner(),
          markFatal,
        ),
      )),
    ];
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(persisted.length).toBeGreaterThan(3);
    for (const text of persisted) {
      for (const secret of [SECRET_CONTENT, btoa(SECRET_CONTENT), SECRET_MESSAGE, ...backend.credentials]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
