// SPDX-License-Identifier: Apache-2.0
import { isGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { FilePath, RepoName, Revision } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitAccess, GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { parseStorageInput } from '@leed-ai/git-gateway-contract/storage/storage-input';
import { StorageLogOptions, StorageRef } from '@leed-ai/git-gateway-contract/storage/storage-read';
import {
  CreateStorageRepoOptions,
  StorageRepoInfo,
} from '@leed-ai/git-gateway-contract/storage/storage-repo-info';
import type { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { z } from 'zod';

import {
  releaseHandle,
  type ArtifactsNamespaceBinding,
  type ArtifactsRepoHandle,
} from './artifacts-binding.ts';
import { artifactsErrorCode, toGatewayError } from './artifacts-errors.ts';
import { blobIdAt, isUnserializableBlob, readBlobOverGit } from './artifacts-git-reads.ts';
import { toContractCommit, toStorageTreeEntry } from './artifacts-mapping.ts';
import {
  ArtifactsCommit,
  ArtifactsCreateResult,
  ArtifactsRepoInfo,
  ArtifactsToken,
  ArtifactsTreeEntry,
} from './schemas/artifacts-binding-results.ts';

/** Options of an {@link ArtifactsBackend}. */
export interface ArtifactsBackendOptions {
  /** The Artifacts binding, `env.ARTIFACTS`. */
  readonly binding: ArtifactsNamespaceBinding;
  /** Lifetime of the tokens gitRemote() mints, in seconds: 60–31536000, default 300. */
  readonly tokenTtlSeconds?: number;
}

const TokenTtl = z.int().min(60).max(31_536_000);
/**
 * The name the binding resolves for a StorageRef. The live binding resolves short names ("main",
 * "v1", a commit id) and answers nothing for fully qualified ones ("refs/heads/main" → no commits),
 * so the "refs/heads/" or "refs/tags/" prefix is dropped. The binding then resolves the name as git
 * does a short name, so a tag and a branch sharing one name cannot be told apart.
 */
export function bindingRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|tags)\//, '');
}

const bytesOf = async (blob: Blob | null): Promise<Uint8Array | null> =>
  blob === null ? null : new Uint8Array(await blob.arrayBuffer());

/** Parses a host result; a mismatch means the host answered something the contract cannot use. */
function parseHost<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
}

/**
 * A {@link StorageBackend} over a Cloudflare Artifacts namespace, through the Workers binding:
 * repository lifecycle (create, info, delete), reads (readCommit, readTree, readBlob, readFile,
 * log) and per-call tokens for the repository's git remote. Artifacts has no write or ref API, so
 * every write is a git-receive-pack push to {@link gitRemote}; refs are resolved through the
 * binding's log. Every binding result is parsed with Zod; binding errors become GatewayErrors.
 * Where the binding cannot carry a Blob back (wrangler's remote binding under `wrangler dev`),
 * readBlob and readFile fall back to fetching the blob over the repository's git remote.
 */
export class ArtifactsBackend implements StorageBackend {
  readonly #binding: ArtifactsNamespaceBinding;
  readonly #ttl: number;

  constructor(options: ArtifactsBackendOptions) {
    this.#binding = options.binding;
    this.#ttl = TokenTtl.parse(options.tokenTtlSeconds ?? 300);
  }

  async createRepo(name: string, options: CreateStorageRepoOptions = {}): Promise<StorageRepoInfo> {
    const repo = parseStorageInput(RepoName, name);
    const { defaultBranch } = parseStorageInput(CreateStorageRepoOptions, options);
    try {
      const created = parseHost(
        ArtifactsCreateResult,
        await this.#binding.create(repo, { setDefaultBranch: defaultBranch }),
      );
      return await this.#withRepo(repo, 'createRepo', async (handle) => {
        // The initial write token is never handed out; revoking it is hygiene, so a failure to
        // revoke (the token then simply expires) does not fail the creation.
        await handle.revokeToken(created.token).catch(() => false);
        return this.#info(parseHost(ArtifactsRepoInfo, await handle.info()));
      });
    } catch (error) {
      throw toGatewayError(repo, 'createRepo', error);
    }
  }

  async deleteRepo(name: string): Promise<void> {
    const repo = parseStorageInput(RepoName, name);
    try {
      await this.#binding.delete(repo);
    } catch (error) {
      if (artifactsErrorCode(error) !== 'NOT_FOUND') throw toGatewayError(repo, 'deleteRepo', error);
    }
  }

  async repoInfo(name: string): Promise<StorageRepoInfo | null> {
    const repo = parseStorageInput(RepoName, name);
    try {
      return await this.#withRepo(repo, 'repoInfo', async (handle) =>
        this.#info(parseHost(ArtifactsRepoInfo, await handle.info())),
      );
    } catch (error) {
      if (isGatewayError(error, 'repo_not_found')) return null;
      throw error;
    }
  }

  async resolveRef(name: string, ref: string): Promise<string | null> {
    const repo = parseStorageInput(RepoName, name);
    const parsed = parseStorageInput(StorageRef, ref);
    return this.#withRepo(repo, 'resolveRef', async (handle) => {
      const [head] = z.array(ArtifactsCommit).parse(await handle.log({ ref: bindingRef(parsed), limit: 1 }));
      return head?.hash ?? null;
    });
  }

  async readCommit(name: string, sha: string): Promise<Commit | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#withRepo(repo, 'readCommit', async (handle) => {
      const metadata = await this.#readTyped(
        async () => handle.readCommit(id),
        [async () => handle.readBlob(id), async () => handle.readTree(id)],
      );
      return metadata === null ? null : toContractCommit(parseHost(ArtifactsCommit, metadata));
    });
  }

  async readTree(name: string, sha: string): Promise<StorageTreeEntry[] | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#withRepo(repo, 'readTree', async (handle) => {
      const entries = await this.#readTyped(
        async () => handle.readTree(id),
        [async () => handle.readBlob(id), async () => handle.readCommit(id)],
      );
      return entries === null ? null : z.array(ArtifactsTreeEntry).parse(entries).map(toStorageTreeEntry);
    });
  }

  async readBlob(name: string, sha: string): Promise<Uint8Array | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#withRepo(repo, 'readBlob', async (handle) => {
      try {
        return await bytesOf(await handle.readBlob(id));
      } catch (error) {
        if (!isUnserializableBlob(error)) throw error;
        return readBlobOverGit(await this.gitRemote(repo, 'read'), id);
      }
    });
  }

  async readFile(name: string, ref: string, path: string): Promise<Uint8Array | null> {
    const repo = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const file = parseStorageInput(FilePath, path);
    // A Revision is a commit id or a short branch name, which is what the binding resolves.
    return this.#withRepo(repo, 'readFile', async (handle) => {
      try {
        return await bytesOf(await handle.readFile({ ref: revision, path: file }));
      } catch (error) {
        if (!isUnserializableBlob(error)) throw error;
        const blob = await blobIdAt(handle, revision, file);
        return blob === null ? null : readBlobOverGit(await this.gitRemote(repo, 'read'), blob);
      }
    });
  }

  async log(name: string, ref: string, options: StorageLogOptions): Promise<Commit[]> {
    const repo = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const { limit, offset } = parseStorageInput(StorageLogOptions, options);
    return this.#withRepo(repo, 'log', async (handle) => {
      const commits = z.array(ArtifactsCommit).parse(await handle.log({ ref: revision, limit, offset }));
      return Promise.all(commits.map(toContractCommit));
    });
  }

  async gitRemote(name: string, access: string): Promise<GitRemote> {
    const repo = parseStorageInput(RepoName, name);
    const scope = parseStorageInput(GitAccess, access);
    return this.#withRepo(repo, 'gitRemote', async (handle) => {
      const [info, token] = await Promise.all([handle.info(), handle.createToken(scope, this.#ttl)]);
      const parsedToken = parseHost(ArtifactsToken, token);
      return GitRemote.parse({
        url: parseHost(ArtifactsRepoInfo, info).remote,
        headers: { Authorization: `Bearer ${parsedToken.plaintext}` },
        expiresAt: new Date(parsedToken.expiresAt).toISOString(),
      });
    });
  }

  /** Runs `work` with a handle on the repository, releasing it after; failures become GatewayErrors. */
  async #withRepo<T>(
    repo: string,
    what: string,
    work: (handle: ArtifactsRepoHandle) => Promise<T>,
  ): Promise<T> {
    let handle: ArtifactsRepoHandle;
    try {
      handle = await this.#binding.get(repo);
    } catch (error) {
      throw toGatewayError(repo, what, error);
    }
    try {
      return await work(handle);
    } catch (error) {
      throw toGatewayError(repo, what, error);
    } finally {
      releaseHandle(handle);
    }
  }

  /**
   * Reads an object of one kind. The binding answers null for a missing id but throws
   * INTERNAL_ERROR when the id names an object of another kind; that case is null too, told apart
   * from a real failure by the object being readable as one of the other kinds (`probes`).
   */
  async #readTyped(
    read: () => Promise<unknown>,
    probes: readonly (() => Promise<unknown>)[],
  ): Promise<unknown> {
    try {
      return await read();
    } catch (error) {
      if (artifactsErrorCode(error) !== 'INTERNAL_ERROR') throw error;
      for (const probe of probes) {
        // A Blob that could not be carried back (wrangler's remote binding) was still found.
        const found = await probe().catch((probeError: unknown) =>
          isUnserializableBlob(probeError) ? true : null,
        );
        if (found !== null) return null;
      }
      throw error;
    }
  }

  #info(info: ArtifactsRepoInfo): StorageRepoInfo {
    return StorageRepoInfo.parse({
      name: info.name,
      defaultBranch: info.defaultBranch,
      createdAt: new Date(info.createdAt).toISOString(),
    });
  }
}
