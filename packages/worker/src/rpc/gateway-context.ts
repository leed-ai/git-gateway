// SPDX-License-Identifier: Apache-2.0
import { GatewayConfig, type GatewayConfigInput } from '@leed-ai/git-gateway-contract/schemas/gateway-config';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

import type { CommitWorkflowParams } from '../workflows/commit-workflow-schemas.ts';
import { composeOnPush, type OnPushHook } from '../workflows/on-push.ts';
import type { SyncBranchWorkflowParams } from '../workflows/sync-workflow-schemas.ts';
import type { WorkflowStarter } from '../workflows/workflow-starter.ts';
import { ReadTokenSecret } from './read-token.ts';

/** How a deployment composes the RPC service and its Workflows. */
export interface GatewayOptions {
  /** Where the repositories live. */
  readonly backend: StorageBackend;
  /** Gateway configuration; every field has a default. */
  readonly config?: GatewayConfigInput;
  /** HMAC key read tokens are signed with (see {@link ReadTokenSecret}). */
  readonly readTokenSecret: string;
  /** How pushes reach the backend's git remote; default the global `fetch`. */
  readonly fetch?: FetchLike;
  /** The clock for commit dates, token expiry and the idempotency window; default the system clock. */
  readonly now?: () => Date;
  /** The CommitWorkflow binding commits are handed to when inline retries run out. */
  readonly commitWorkflow?: WorkflowStarter<CommitWorkflowParams>;
  /**
   * The SyncBranchWorkflow binding `config.syncRules` start instances of after every ref update
   * the RPC API pushes; required when there are sync rules.
   */
  readonly syncWorkflow?: WorkflowStarter<SyncBranchWorkflowParams>;
  /**
   * Called after every ref update the RPC API or its Workflows push (commits, syncs, promotions),
   * beside the sync rules, e.g. to send the event to a Queue. The write has
   * already happened, so a failure is reported to {@link onPushError} and does not fail the call.
   */
  readonly onPush?: OnPushHook;
  /** Receives onPush failures, e.g. to log or count them; default: they are dropped. */
  readonly onPushError?: (error: unknown) => void;
}

/** {@link GatewayOptions} validated, with defaults applied; what every method works with. */
export interface GatewayContext {
  readonly backend: StorageBackend;
  readonly config: GatewayConfig;
  readonly readTokenSecret: string;
  readonly fetch: FetchLike | undefined;
  readonly now: () => Date;
  readonly commitWorkflow: WorkflowStarter<CommitWorkflowParams> | undefined;
  /** The sync rules and the deployment's own hook, composed (see composeOnPush). */
  readonly onPush: OnPushHook | undefined;
  readonly onPushError: (error: unknown) => void;
}

/** The default onPush failure handler: the failure is dropped (the write itself succeeded). */
const ignorePushHookError = (): void => undefined;

/**
 * Validates options (the configuration and the secret, with Zod) and applies the defaults. Throws
 * a TypeError when sync rules are configured without a `syncWorkflow`.
 */
export function gatewayContext(options: GatewayOptions): GatewayContext {
  const config = GatewayConfig.parse(options.config ?? {});
  return {
    backend: options.backend,
    config,
    readTokenSecret: ReadTokenSecret.parse(options.readTokenSecret),
    fetch: options.fetch,
    now: options.now ?? (() => new Date()),
    commitWorkflow: options.commitWorkflow,
    onPush: composeOnPush({
      syncRules: config.syncRules,
      syncWorkflow: options.syncWorkflow,
      onPush: options.onPush,
    }),
    onPushError: options.onPushError ?? ignorePushHookError,
  };
}
