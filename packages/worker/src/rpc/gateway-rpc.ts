// SPDX-License-Identifier: Apache-2.0
import { RPC_SCHEMAS, type GitGateway } from '@leed-ai/git-gateway-contract/git-gateway';
import { runMethod } from '@leed-ai/git-gateway-contract/reference/run-method';
import { storageUnavailable } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';

import { gatewayPromote, gatewaySyncBranch } from './branch-methods.ts';
import { gatewayCommit } from './commit-method.ts';
import { gatewayContext, type GatewayOptions } from './gateway-context.ts';
import { gatewayCreateRepo, gatewayDeleteRepo, gatewayMintReadToken } from './lifecycle-methods.ts';
import {
  gatewayCommitExists,
  gatewayListTree,
  gatewayLog,
  gatewayReadFile,
  gatewayResolveRef,
} from './read-methods.ts';

/**
 * Runs a method's work so that a core error (an object the backend handed back that is missing or
 * malformed) is reported as storage_unavailable: storage cannot be trusted for this call.
 */
async function guarded<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (thrown) {
    if (isCoreError(thrown)) throw storageUnavailable(name, thrown);
    throw thrown;
  }
}

/**
 * The gateway's {@link GitGateway} over a storage backend: the methods the RPC entrypoint serves,
 * usable directly wherever a gateway is needed in-process (tests, a deployment's own Worker).
 * Every input is parsed with its contract schema before anything is read (invalid_input) and
 * every output with its schema before it is returned; errors are GatewayErrors.
 */
export function createGatewayRpc(options: GatewayOptions): GitGateway {
  const context = gatewayContext(options);
  const s = RPC_SCHEMAS;
  return {
    commit: (input) => runMethod(s.commit, input, (p) => guarded('commit', () => gatewayCommit(context, p))),
    readFile: (input) =>
      runMethod(s.readFile, input, (p) => guarded('readFile', () => gatewayReadFile(context, p))),
    listTree: (input) =>
      runMethod(s.listTree, input, (p) => guarded('listTree', () => gatewayListTree(context, p))),
    resolveRef: (input) =>
      runMethod(s.resolveRef, input, (p) => guarded('resolveRef', () => gatewayResolveRef(context, p))),
    log: (input) => runMethod(s.log, input, (p) => guarded('log', () => gatewayLog(context, p))),
    commitExists: (input) =>
      runMethod(s.commitExists, input, (p) => guarded('commitExists', () => gatewayCommitExists(context, p))),
    syncBranch: (input) =>
      runMethod(s.syncBranch, input, (p) => guarded('syncBranch', () => gatewaySyncBranch(context, p))),
    promote: (input) =>
      runMethod(s.promote, input, (p) => guarded('promote', () => gatewayPromote(context, p))),
    createRepo: (input) =>
      runMethod(s.createRepo, input, (p) => guarded('createRepo', () => gatewayCreateRepo(context, p))),
    deleteRepo: (input) =>
      runMethod(s.deleteRepo, input, (p) => guarded('deleteRepo', () => gatewayDeleteRepo(context, p))),
    mintReadToken: (input) =>
      runMethod(s.mintReadToken, input, (p) =>
        guarded('mintReadToken', () => gatewayMintReadToken(context, p)),
      ),
  };
}
