// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

import { CommitExistsInput, CommitExistsOutput } from './rpc/commit-exists.ts';
import { CommitInput, CommitOutput } from './rpc/commit.ts';
import { ListTreeInput, ListTreeOutput } from './rpc/list-tree.ts';
import { LogInput, LogOutput } from './rpc/log.ts';
import { MintReadTokenInput, MintReadTokenOutput } from './rpc/mint-read-token.ts';
import { PromoteInput, PromoteOutput } from './rpc/promote.ts';
import { ReadFileInput, ReadFileOutput } from './rpc/read-file.ts';
import {
  CreateRepoInput,
  CreateRepoOutput,
  DeleteRepoInput,
  DeleteRepoOutput,
} from './rpc/repo-lifecycle.ts';
import { ResolveRefInput, ResolveRefOutput } from './rpc/resolve-ref.ts';
import { SyncBranchInput, SyncBranchOutput } from './rpc/sync-branch.ts';

/**
 * The input and output schema of every RPC method. An implementation parses each input with its
 * schema before acting and returns a value its output schema accepts; failures are thrown as
 * {@link GatewayError}s.
 */
export const RPC_SCHEMAS = {
  commit: { input: CommitInput, output: CommitOutput },
  readFile: { input: ReadFileInput, output: ReadFileOutput },
  listTree: { input: ListTreeInput, output: ListTreeOutput },
  resolveRef: { input: ResolveRefInput, output: ResolveRefOutput },
  log: { input: LogInput, output: LogOutput },
  commitExists: { input: CommitExistsInput, output: CommitExistsOutput },
  syncBranch: { input: SyncBranchInput, output: SyncBranchOutput },
  promote: { input: PromoteInput, output: PromoteOutput },
  createRepo: { input: CreateRepoInput, output: CreateRepoOutput },
  deleteRepo: { input: DeleteRepoInput, output: DeleteRepoOutput },
  mintReadToken: { input: MintReadTokenInput, output: MintReadTokenOutput },
} as const;

/** The name of an RPC method. */
export type RpcMethod = keyof typeof RPC_SCHEMAS;

/** What a caller passes to an RPC method (defaults optional). */
export type RpcInput<M extends RpcMethod> = z.input<(typeof RPC_SCHEMAS)[M]['input']>;
/** What an implementation works with after parsing the input (defaults applied). */
export type RpcParsedInput<M extends RpcMethod> = z.output<(typeof RPC_SCHEMAS)[M]['input']>;
/** What an RPC method resolves to. */
export type RpcOutput<M extends RpcMethod> = z.output<(typeof RPC_SCHEMAS)[M]['output']>;

/**
 * The git-gateway RPC API, reached over a Workers service binding. Every method's signature is
 * the inferred type of its schemas in {@link RPC_SCHEMAS}; errors are thrown as GatewayErrors.
 */
export interface GitGateway {
  /** A multi-file commit to one branch, built without a clone; idempotent by key. */
  commit(input: RpcInput<'commit'>): Promise<RpcOutput<'commit'>>;
  /** One file at a branch or commit, or null when no file is at the path. */
  readFile(input: RpcInput<'readFile'>): Promise<RpcOutput<'readFile'>>;
  /** A directory listing at a branch or commit, or null when the path is not a directory. */
  listTree(input: RpcInput<'listTree'>): Promise<RpcOutput<'listTree'>>;
  /** The commit a branch names, or null when it does not exist. */
  resolveRef(input: RpcInput<'resolveRef'>): Promise<RpcOutput<'resolveRef'>>;
  /** A page of history reachable from a branch or commit. */
  log(input: RpcInput<'log'>): Promise<RpcOutput<'log'>>;
  /** Whether a commit exists, optionally reachable from a branch. */
  commitExists(input: RpcInput<'commitExists'>): Promise<RpcOutput<'commitExists'>>;
  /** Bring one branch up to date with another without rewriting it. */
  syncBranch(input: RpcInput<'syncBranch'>): Promise<RpcOutput<'syncBranch'>>;
  /** Fast-forward one branch to the head of another, never merging or forcing. */
  promote(input: RpcInput<'promote'>): Promise<RpcOutput<'promote'>>;
  /** Create an empty repository. */
  createRepo(input: RpcInput<'createRepo'>): Promise<RpcOutput<'createRepo'>>;
  /** Permanently delete a repository. */
  deleteRepo(input: RpcInput<'deleteRepo'>): Promise<RpcOutput<'deleteRepo'>>;
  /** A short-lived credential that can read one repository through the gateway. */
  mintReadToken(input: RpcInput<'mintReadToken'>): Promise<RpcOutput<'mintReadToken'>>;
}
