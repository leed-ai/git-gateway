// SPDX-License-Identifier: Apache-2.0
import { gatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { decodeCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import type { GitAccess, GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { repoNotFound } from '@leed-ai/git-gateway-contract/storage/storage-errors';

/** What a test backend records about each gitRemote() call. */
export interface MintedRemote {
  readonly repo: string;
  readonly access: GitAccess;
  readonly token: string;
}

const unused = async (): Promise<never> => {
  throw new Error('the smart-HTTP proxy does not call this');
};

/**
 * A storage backend for proxy tests: known repositories, commits by id (for ancestry), and a
 * fresh secret token for every gitRemote() call, recorded so tests can check one was minted per
 * request and never leaked.
 */
export class FakeBackend implements StorageBackend {
  readonly minted: MintedRemote[] = [];
  readonly commits = new Map<string, Commit>();
  /** Commit objects stored as raw content, decoded on every read as a real backend decodes them. */
  readonly rawCommits = new Map<string, Uint8Array>();
  readonly repos = new Set<string>(['site']);
  commitReads = 0;
  failRemote: Error | null = null;
  failReads = false;
  /** Milliseconds every commit read takes, as a slow host's would. */
  readDelayMs = 0;
  /** Questions asked of {@link isAncestor} once {@link answerAncestry} has turned it on. */
  ancestryQueries = 0;
  /** The optional capability; absent until {@link answerAncestry} is called. */
  isAncestor?: (repo: string, ancestor: string, descendant: string) => Promise<boolean | null>;

  createRepo = unused;
  deleteRepo = unused;
  repoInfo = unused;
  resolveRef = unused;
  readTree = unused;
  readBlob = unused;
  readFile = unused;
  log = unused;

  async readCommit(repo: string, sha: string): Promise<Commit | null> {
    this.commitReads += 1;
    if (this.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    if (this.failReads) throw gatewayError('storage_unavailable', 'down', { retryable: true });
    if (!this.repos.has(repo)) throw repoNotFound(repo);
    const raw = this.rawCommits.get(sha);
    if (raw !== undefined) return decodeCommit(sha, raw);
    return this.commits.get(sha) ?? null;
  }

  async gitRemote(repo: string, access: GitAccess): Promise<GitRemote> {
    if (this.failRemote !== null) throw this.failRemote;
    if (!this.repos.has(repo)) throw repoNotFound(repo);
    const token = `upstream-secret-${this.minted.length + 1}`;
    this.minted.push({ repo, access, token });
    return {
      url: `https://storage.test/git/${repo}.git`,
      headers: { Authorization: `Bearer ${token}` },
      expiresAt: '2026-11-20T10:00:00.000Z',
    };
  }

  /** Turns on the isAncestor capability, answered from the recorded commits without counting reads. */
  answerAncestry(): void {
    this.isAncestor = async (repo, ancestor, descendant) => {
      this.ancestryQueries += 1;
      if (this.failReads) throw gatewayError('storage_unavailable', 'down', { retryable: true });
      if (!this.repos.has(repo)) throw repoNotFound(repo);
      if (!this.commits.has(ancestor) || !this.commits.has(descendant)) return null;
      const queue = [descendant];
      const seen = new Set(queue);
      for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) {
        if (sha === ancestor) return true;
        for (const parent of this.commits.get(sha)?.parents ?? []) {
          if (!seen.has(parent)) {
            seen.add(parent);
            queue.push(parent);
          }
        }
      }
      return false;
    };
  }

  /** Records a commit with the given parents (other fields are fixed). */
  addCommit(sha: string, parents: readonly string[]): void {
    this.commits.set(sha, {
      sha,
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      parents: [...parents],
      author: { name: 'Ada', email: 'ada@example.com', date: '2026-11-20T09:00:00.000Z' },
      committer: { name: 'Ada', email: 'ada@example.com', date: '2026-11-20T09:00:00.000Z' },
      message: 'commit\n',
      idempotencyKey: null,
    });
  }
}
