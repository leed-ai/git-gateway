// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '../git-gateway.ts';
import { GatewayConfig, type GatewayConfigInput } from '../schemas/gateway-config.ts';
import { referenceSyncBranch, referencePromote } from './branch-methods.ts';
import type { Clock } from './clock.ts';
import { referenceCommit } from './commit-method.ts';
import { referenceCreateRepo, referenceDeleteRepo, referenceMintReadToken } from './lifecycle-methods.ts';
import {
  referenceCommitExists,
  referenceListTree,
  referenceLog,
  referenceReadFile,
  referenceResolveRef,
} from './read-methods.ts';
import type { ReferenceContext } from './repo-state.ts';

/** Options for {@link createReferenceGateway}. */
export interface ReferenceGatewayOptions {
  /** Gateway configuration; every field has a default. */
  readonly config?: GatewayConfigInput;
  /** Source of commit dates, token expiry and the idempotency window; defaults to the system clock. */
  readonly now?: Clock;
}

/**
 * The in-memory reference implementation of {@link GitGateway}: every rule of the contract on
 * plain objects, no git objects and no I/O. Use it to develop and test consumers before (and
 * alongside) the real gateway, and as the oracle the real gateway is tested against. Blob ids are
 * git's; tree and commit ids are deterministic for a given clock (see `steppingClock`).
 */
export function createReferenceGateway(options: ReferenceGatewayOptions = {}): GitGateway {
  const context: ReferenceContext = {
    config: GatewayConfig.parse(options.config ?? {}),
    now: options.now ?? (() => new Date()),
    repos: new Map(),
  };
  return {
    commit: (input) => referenceCommit(context, input),
    readFile: (input) => referenceReadFile(context, input),
    listTree: (input) => referenceListTree(context, input),
    resolveRef: (input) => referenceResolveRef(context, input),
    log: (input) => referenceLog(context, input),
    commitExists: (input) => referenceCommitExists(context, input),
    syncBranch: (input) => referenceSyncBranch(context, input),
    promote: (input) => referencePromote(context, input),
    createRepo: (input) => referenceCreateRepo(context, input),
    deleteRepo: (input) => referenceDeleteRepo(context, input),
    mintReadToken: (input) => referenceMintReadToken(context, input),
  };
}
