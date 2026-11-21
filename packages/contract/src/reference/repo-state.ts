// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '../gateway-error.ts';
import type { Commit } from '../schemas/commit.ts';
import type { GatewayConfig } from '../schemas/gateway-config.ts';
import { Sha } from '../schemas/sha.ts';
import type { Clock } from './clock.ts';
import type { FileMap } from './file-map.ts';
import type { CommitLookup } from './history.ts';
import type { TreeIndex } from './tree-index.ts';

/** A commit of the in-memory model with the snapshot it records. */
export interface StoredCommit {
  readonly commit: Commit;
  readonly files: FileMap;
  readonly tree: TreeIndex;
}

/** One in-memory repository. */
export interface RepoState {
  readonly name: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly branches: Map<string, string>;
  readonly commits: Map<string, StoredCommit>;
  /** Tail of the queue that serializes writes to this repository. */
  lock: Promise<unknown>;
}

/** Everything the reference implementation's methods share. */
export interface ReferenceContext {
  readonly config: GatewayConfig;
  readonly now: Clock;
  readonly repos: Map<string, RepoState>;
}

/** The repository, or repo_not_found. */
export function requireRepo(context: ReferenceContext, name: string): RepoState {
  const repo = context.repos.get(name);
  if (repo === undefined)
    throw gatewayError('repo_not_found', `Repository not found: ${name}`, { repo: name });
  return repo;
}

/** A commit lookup over one repository. */
export function lookupIn(repo: RepoState): CommitLookup {
  return (sha) => repo.commits.get(sha)?.commit;
}

/** The commit a revision names (a commit id, or a branch's head), or undefined. */
export function resolveRevision(repo: RepoState, revision: string): StoredCommit | undefined {
  const sha = Sha.safeParse(revision).success ? revision : repo.branches.get(revision);
  return sha === undefined ? undefined : repo.commits.get(sha);
}

/** The commit a revision names, or ref_not_found. */
export function requireRevision(repo: RepoState, revision: string): StoredCommit {
  const stored = resolveRevision(repo, revision);
  if (stored === undefined)
    throw gatewayError('ref_not_found', `Ref not found: ${revision}`, { ref: revision });
  return stored;
}

/** The head of a branch, or ref_not_found. */
export function requireBranchHead(repo: RepoState, branch: string): string {
  const head = repo.branches.get(branch);
  if (head === undefined) throw gatewayError('ref_not_found', `Branch not found: ${branch}`, { ref: branch });
  return head;
}

/** Runs `work` after every earlier write to the repository has settled, so writes never interleave. */
export function withRepoLock<T>(repo: RepoState, work: () => Promise<T>): Promise<T> {
  const run = repo.lock.then(work, work);
  repo.lock = run.catch(() => undefined);
  return run;
}

/** The clone URL of a repository under the configured public base URL. */
export function remoteUrlOf(config: GatewayConfig, repo: string): string {
  // A scan from the end, not /\/+$/, which retries from every slash run (polynomial time).
  let end = config.publicBaseUrl.length;
  while (end > 0 && config.publicBaseUrl.charCodeAt(end - 1) === 47) end -= 1;
  return `${config.publicBaseUrl.slice(0, end)}/${repo}.git`;
}
