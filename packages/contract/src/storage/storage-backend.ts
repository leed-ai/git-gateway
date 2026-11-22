// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '../schemas/commit.ts';
import type { FilePath, RepoName, Revision } from '../schemas/names.ts';
import type { Sha } from '../schemas/sha.ts';
import type { GitAccess, GitRemote } from './git-remote.ts';
import type { StorageLogOptions, StorageRef } from './storage-read.ts';
import type { CreateStorageRepoOptions, StorageRepoInfo } from './storage-repo-info.ts';
import type { StorageTreeEntry } from './storage-tree-entry.ts';

/**
 * Where repositories are stored: Cloudflare Artifacts, GitLab, an in-memory test double. A
 * backend provides only what every git host provides — repository lifecycle, reads by id and by
 * ref, and a git smart-HTTP remote. Every write is a git-receive-pack push to that remote; a
 * backend never needs a commits or refs API.
 *
 * Conventions every implementation follows (the backend contract suite in
 * `@leed-ai/git-gateway-testkit` pins them):
 *
 * - Inputs are validated with the contract schemas; a bad value throws an `invalid_input`
 *   GatewayError before the host is called.
 * - Every call on a repository that does not exist throws `repo_not_found`, except
 *   {@link repoInfo} (null) and {@link deleteRepo} (no-op).
 * - A missing object, ref or path is `null` (an empty array for {@link log}), never an error.
 * - So is an id that names an object of another kind: {@link readCommit} of a tree or a blob,
 *   {@link readTree} of a commit or a blob, {@link readBlob} of a commit or a tree, and a
 *   revision naming a tree or a blob. Each read answers whether an object of its kind has that
 *   id, so a caller may try one kind after another; a backend whose host refuses such a read with
 *   an error maps that error to `null`, and only that error.
 * - A host failure throws `storage_unavailable`. Everything the host returns is parsed with Zod
 *   before it is handed back.
 */
export interface StorageBackend {
  /** Creates an empty repository. Throws `repo_exists` when the name is taken. */
  createRepo(name: RepoName, options?: CreateStorageRepoOptions): Promise<StorageRepoInfo>;
  /** Deletes a repository with all its refs and objects; deleting a missing one does nothing. */
  deleteRepo(name: RepoName): Promise<void>;
  /** The repository's description, or null when it does not exist. */
  repoInfo(name: RepoName): Promise<StorageRepoInfo | null>;

  /** The commit a ref names, or null when the ref does not exist (always null in an empty repository). */
  resolveRef(repo: RepoName, ref: StorageRef): Promise<Sha | null>;
  /** A commit by id, or null when no commit has that id (also when the id names a tree or a blob). */
  readCommit(repo: RepoName, sha: Sha): Promise<Commit | null>;
  /** One level of a tree by id, in stored order, or null when no tree has that id (also when it names a commit or a blob). */
  readTree(repo: RepoName, sha: Sha): Promise<StorageTreeEntry[] | null>;
  /** A blob's bytes by id, or null when no blob has that id (also when it names a commit or a tree). */
  readBlob(repo: RepoName, sha: Sha): Promise<Uint8Array | null>;
  /** A file's bytes at a revision, or null when the revision or the file does not exist. */
  readFile(repo: RepoName, ref: Revision, path: FilePath): Promise<Uint8Array | null>;
  /** The first-parent chain from a revision, newest first; empty when the revision does not exist. */
  log(repo: RepoName, ref: Revision, options: StorageLogOptions): Promise<Commit[]>;

  /**
   * Optional capability: whether `ancestor` is `descendant` itself or one of its ancestors, as
   * `git merge-base --is-ancestor` answers it, or null when either commit is not in the
   * repository. A backend implements it only when its host can answer in one or a few calls (a
   * merge-base API, say); the gateway then proves fast-forwards with it instead of walking
   * history one {@link readCommit} at a time, and falls back to that walk when it is absent.
   * Follows the same conventions as the reads: invalid ids are `invalid_input`, a missing
   * repository `repo_not_found`, a host failure `storage_unavailable`.
   */
  isAncestor?(repo: RepoName, ancestor: Sha, descendant: Sha): Promise<boolean | null>;

  /**
   * A freshly minted smart-HTTP remote for the repository: URL plus the headers that authorize
   * `access`. The credential is short-lived where the host allows it and must never reach a
   * git client.
   */
  gitRemote(repo: RepoName, access: GitAccess): Promise<GitRemote>;
}
