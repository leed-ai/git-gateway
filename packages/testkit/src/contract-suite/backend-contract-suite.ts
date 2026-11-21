// SPDX-License-Identifier: Apache-2.0
import type { TestRegistrar } from '@leed-ai/git-gateway-contract/behaviour/behaviour-suite';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

import { clientFactory, type BackendCase, type HostBehaviour } from './backend-case.ts';
import { contentCases } from './content-cases.ts';
import { lifecycleCases } from './lifecycle-cases.ts';
import { pushCases } from './push-cases.ts';
import { readCases } from './read-cases.ts';
import { transportCases } from './transport-cases.ts';

/** Every case of the storage backend contract, grouped by area. */
export const BACKEND_CASES: readonly BackendCase[] = [
  ...lifecycleCases,
  ...transportCases,
  ...readCases,
  ...pushCases,
  ...contentCases,
];

/** How to run the backend contract suite against one backend. */
export interface BackendSuiteOptions {
  /** Suite title; default "StorageBackend contract". */
  readonly name?: string;
  /** Returns the backend under test; called once per case. */
  readonly createBackend: () => StorageBackend | Promise<StorageBackend>;
  /** How the host treats what the contract leaves to it. */
  readonly behaviour: HostBehaviour;
  /** Sends requests to the backend's git remotes; default the global fetch. */
  readonly fetch?: FetchLike;
  /** Prefix of every repository name the cases create; default "contract". Keep it short. */
  readonly repoPrefix?: string;
  /** Size of the large-file case's file; default 5 MiB. */
  readonly largeFileBytes?: number;
  /** Delete each case's repository when it ends; default true. */
  readonly cleanup?: boolean;
  /**
   * Which cases to register; default every case. For a backend mode that cannot run a whole group,
   * such as names that createRepo refuses, which the lifecycle group creates.
   */
  readonly include?: (entry: BackendCase) => boolean;
}

let runCounter = 0;

/** Runs one case against a fresh backend and a repository name no other case uses. */
export async function runBackendCase(entry: BackendCase, options: BackendSuiteOptions): Promise<void> {
  runCounter += 1;
  const backend = await options.createBackend();
  const repo = `${options.repoPrefix ?? 'contract'}-${runCounter}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await entry.run({
      backend,
      repo,
      behaviour: options.behaviour,
      largeFileBytes: options.largeFileBytes ?? 5 * 1024 * 1024,
      client: clientFactory(backend, repo, options.fetch),
    });
  } finally {
    if (options.cleanup !== false) await backend.deleteRepo(repo);
  }
}

/**
 * Registers the storage backend contract suite with a test framework: one test per case, grouped
 * by area. Every backend runs it unchanged — the in-memory backend, the Artifacts local binding
 * and a disposable GitLab project — declaring only how its host treats non-fast-forward pushes
 * and read credentials.
 *
 *   registerBackendContractSuite({ describe, it }, {
 *     createBackend: () => backend,
 *     fetch: backend.fetch,
 *     behaviour: { nonFastForward: 'accepted', readRemoteCannotPush: true },
 *   });
 */
export function registerBackendContractSuite(test: TestRegistrar, options: BackendSuiteOptions): void {
  const included = BACKEND_CASES.filter((entry) => options.include?.(entry) ?? true);
  const groups = Map.groupBy(included, (entry) => entry.group);
  test.describe(options.name ?? 'StorageBackend contract', () => {
    for (const [group, cases] of groups) {
      test.describe(group, () => {
        for (const entry of cases) test.it(entry.name, () => runBackendCase(entry, options));
      });
    }
  });
}
