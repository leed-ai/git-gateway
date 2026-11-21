// SPDX-License-Identifier: Apache-2.0
import { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { FilePath, RepoName, Revision } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitAccess, GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { repoExists, repoNotFound } from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { parseStorageInput } from '@leed-ai/git-gateway-contract/storage/storage-input';
import { StorageLogOptions, StorageRef } from '@leed-ai/git-gateway-contract/storage/storage-read';
import {
  CreateStorageRepoOptions,
  StorageRepoInfo,
} from '@leed-ai/git-gateway-contract/storage/storage-repo-info';
import { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

import { fileAt, firstParentLog, resolveRevision } from './memory-reads.ts';
import { MemoryRepository } from './memory-repository.ts';
import { MemoryTokens } from './memory-tokens.ts';
import { serveSmartHttp } from './smart-http-server.ts';

/** Options of a {@link MemoryBackend}. */
export interface MemoryBackendOptions {
  /** Base URL of the git remotes it hands out; default "http://memory.git-gateway.invalid". */
  readonly baseUrl?: string;
  /** The clock for creation times and token expiry; default the system clock. */
  readonly now?: () => Date;
  /** Lifetime of the tokens gitRemote() mints, in seconds; default 300. */
  readonly tokenTtlSeconds?: number;
}

const TYPE_OF_MODE = { '040000': 'tree', '160000': 'commit' } as const;

/**
 * A complete {@link StorageBackend} held in memory, with a real git smart-HTTP server (protocol
 * v0/v1 upload-pack and receive-pack) in {@link handle}, so the git binary and the gateway can
 * push and fetch against it. Serve {@link handle} over HTTP for a git client, or pass
 * {@link fetch} wherever a FetchLike is taken.
 */
export class MemoryBackend implements StorageBackend {
  readonly #repos = new Map<string, MemoryRepository>();
  readonly #tokens: MemoryTokens;
  readonly #now: () => Date;
  readonly #ttl: number;
  #baseUrl: string;

  constructor(options: MemoryBackendOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#tokens = new MemoryTokens(this.#now);
    this.#ttl = options.tokenTtlSeconds ?? 300;
    this.#baseUrl = (options.baseUrl ?? 'http://memory.git-gateway.invalid').replace(/\/$/, '');
  }

  /** Sets the base URL of the remotes handed out from now on (e.g. once an HTTP server has a port). */
  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Answers a git smart-HTTP request for one of the repositories. */
  readonly handle = async (request: Request): Promise<Response> =>
    serveSmartHttp({ tokens: this.#tokens, repository: (name) => this.#repos.get(name) }, request);

  /** {@link handle} as a FetchLike, for clients that would otherwise call the network. */
  readonly fetch: FetchLike = async (request) => this.handle(request);

  async createRepo(name: string, options: CreateStorageRepoOptions = {}): Promise<StorageRepoInfo> {
    const repo = parseStorageInput(RepoName, name);
    const { defaultBranch } = parseStorageInput(CreateStorageRepoOptions, options);
    if (this.#repos.has(repo)) throw repoExists(repo);
    const created = new MemoryRepository(repo, defaultBranch, this.#now().toISOString());
    this.#repos.set(repo, created);
    return this.#info(created);
  }

  async deleteRepo(name: string): Promise<void> {
    const repo = parseStorageInput(RepoName, name);
    this.#repos.delete(repo);
    this.#tokens.revokeRepo(repo);
  }

  async repoInfo(name: string): Promise<StorageRepoInfo | null> {
    const repo = this.#repos.get(parseStorageInput(RepoName, name));
    return repo === undefined ? null : this.#info(repo);
  }

  async resolveRef(name: string, ref: string): Promise<string | null> {
    const repoName = parseStorageInput(RepoName, name);
    const parsed = parseStorageInput(StorageRef, ref);
    const repo = this.#require(repoName);
    return repo.refs.get(parsed.startsWith('refs/') ? parsed : `refs/heads/${parsed}`) ?? null;
  }

  async readCommit(name: string, sha: string): Promise<Commit | null> {
    const repoName = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    const commit = this.#require(repoName).commit(id);
    return commit === null ? null : Commit.parse(commit);
  }

  async readTree(name: string, sha: string): Promise<StorageTreeEntry[] | null> {
    const repoName = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    const entries = this.#require(repoName).tree(id);
    if (entries === null) return null;
    return entries.map((entry) =>
      StorageTreeEntry.parse({
        ...entry,
        type: entry.mode === '040000' || entry.mode === '160000' ? TYPE_OF_MODE[entry.mode] : 'blob',
      }),
    );
  }

  async readBlob(name: string, sha: string): Promise<Uint8Array | null> {
    const repoName = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    const blob = this.#require(repoName).object(id, 'blob');
    return blob === null ? null : blob.data.slice();
  }

  async readFile(name: string, ref: string, path: string): Promise<Uint8Array | null> {
    const repoName = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const file = parseStorageInput(FilePath, path);
    const repo = this.#require(repoName);
    const commit = resolveRevision(repo, revision);
    const data = commit === null ? null : fileAt(repo, commit, file);
    return data === null ? null : data.slice();
  }

  async log(name: string, ref: string, options: StorageLogOptions): Promise<Commit[]> {
    const repoName = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const { limit, offset } = parseStorageInput(StorageLogOptions, options);
    const repo = this.#require(repoName);
    const start = resolveRevision(repo, revision);
    return start === null
      ? []
      : firstParentLog(repo, start, limit, offset).map((commit) => Commit.parse(commit));
  }

  async gitRemote(name: string, access: string): Promise<GitRemote> {
    const repoName = parseStorageInput(RepoName, name);
    const level = parseStorageInput(GitAccess, access);
    const repo = this.#require(repoName);
    const minted = this.#tokens.mint(repo.name, level, this.#ttl);
    return GitRemote.parse({
      url: `${this.#baseUrl}/${repo.name}.git`,
      headers: { Authorization: `Bearer ${minted.token}` },
      expiresAt: minted.expiresAt.toISOString(),
    });
  }

  /** The repository `repo` (already parsed with RepoName, as every other argument must be first). */
  #require(repo: string): MemoryRepository {
    const found = this.#repos.get(repo);
    if (found === undefined) throw repoNotFound(repo);
    return found;
  }

  #info(repo: MemoryRepository): StorageRepoInfo {
    return StorageRepoInfo.parse({
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      createdAt: repo.createdAt,
    });
  }
}
