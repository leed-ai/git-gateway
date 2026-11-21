// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '../../src/git-gateway.ts';
import { readGatewayError } from '../../src/gateway-error.ts';
import { steppingClock } from '../../src/reference/clock.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';
import type { CommitActionInput } from '../../src/schemas/commit-action.ts';

// Shared set-up for the reference edge-case tests: a seeded repository "r" on a stepping clock.

export const AUTHOR = { name: 'Ada', email: 'ada@example.com' };
const SEED = { 'docs/a.md': 'a\n', 'top.txt': 'top\n', 'bin/run.sh': '#!/bin/sh\n' };

let keyCounter = 0;
export const key = () => `edge-${++keyCounter}`;

/** The gateway error code a call rejects with, or undefined when it resolves. */
export async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  return readGatewayError(thrown)?.code;
}

export function commit(gateway: GitGateway, actions: CommitActionInput[], branch = 'main', repo = 'r') {
  return gateway.commit({ repo, branch, author: AUTHOR, message: 'm', idempotencyKey: key(), actions });
}

export async function seeded(): Promise<GitGateway> {
  const gateway = createReferenceGateway({ now: steppingClock() });
  await gateway.createRepo({ repo: 'r' });
  await commit(
    gateway,
    Object.entries(SEED).map(([path, content]) => ({ action: 'create' as const, path, content })),
  );
  return gateway;
}
