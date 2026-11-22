// SPDX-License-Identifier: Apache-2.0
import { isGatewayError } from '@leed-ai/git-gateway-contract/gateway-error';
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { FilePath, RepoName, Revision } from '@leed-ai/git-gateway-contract/schemas/names';
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { GitAccess, GitRemote } from '@leed-ai/git-gateway-contract/storage/git-remote';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import {
  repoExists,
  repoNotFound,
  storageUnavailable,
} from '@leed-ai/git-gateway-contract/storage/storage-errors';
import { parseStorageInput } from '@leed-ai/git-gateway-contract/storage/storage-input';
import { StorageLogOptions, StorageRef } from '@leed-ai/git-gateway-contract/storage/storage-read';
import {
  CreateStorageRepoOptions,
  StorageRepoInfo,
} from '@leed-ai/git-gateway-contract/storage/storage-repo-info';
import type { StorageTreeEntry } from '@leed-ai/git-gateway-contract/storage/storage-tree-entry';
import { GitHttpClient, type FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';
import { z } from 'zod';

import { GitLabApi, GitLabHttpError } from './gitlab-api.ts';
import { FrontedProjects, frontedLifecycleRefused } from './gitlab-fronted.ts';
import { readCommitsOverGit, readTreeOverGit } from './gitlab-git-reads.ts';
import { isAncestorOnGitLab } from './gitlab-merge-base.ts';
import { GitLabBackendConfig } from './schemas/gitlab-config.ts';
import { GitLabCommitSummary, GitLabGroup, GitLabProject, GitLabRef } from './schemas/gitlab-responses.ts';

/** Options of a {@link GitLabBackend}: its configuration and, optionally, how requests are sent. */
export type GitLabBackendOptions = GitLabBackendConfig & {
  /** Sends API and git requests; default the global fetch. */
  readonly fetch?: FetchLike;
};

const PAGE = 100;
const enc = encodeURIComponent;

/**
 * A {@link StorageBackend} over a GitLab instance, so the gateway can front repositories that
 * still live on GitLab. Each repository is a private project in one group. Lifecycle, refs,
 * blobs, files and history use the REST API (v4); commits and trees are read as git objects over
 * the smart-HTTP transport (GitLab's API reports neither tree ids nor raw messages), and writes
 * are git pushes to {@link gitRemote}. It offers the optional `isAncestor` capability through
 * GitLab's merge-base API, so the gateway proves fast-forwards in one call. Every API response is parsed with Zod.
 *
 * With `frontedProjects`, a reserved name `<prefix><projectId>` addresses an existing project by
 * id, wherever it lives under `frontedProjects.namespace`, so the gateway can front repositories
 * that predate it without moving them. Those names can be read and pushed but never created or
 * deleted.
 */
export class GitLabBackend implements StorageBackend {
  readonly #config: z.output<typeof GitLabBackendConfig>;
  readonly #api: GitLabApi;
  readonly #fetch: FetchLike;
  #namespaceId: number | undefined;
  readonly #fronted: FrontedProjects;

  constructor(options: GitLabBackendOptions) {
    const { fetch, ...config } = options;
    this.#config = GitLabBackendConfig.parse(config);
    this.#fetch = fetch ?? (async (request) => globalThis.fetch(request));
    this.#api = new GitLabApi(this.#config.baseUrl, this.#config.token, this.#fetch);
    this.#namespaceId = this.#config.namespaceId;
    this.#fronted = new FrontedProjects(this.#config.frontedProjects);
  }

  async createRepo(name: string, options: CreateStorageRepoOptions = {}): Promise<StorageRepoInfo> {
    const repo = parseStorageInput(RepoName, name);
    const { defaultBranch } = parseStorageInput(CreateStorageRepoOptions, options);
    if (this.#fronted.idOf(repo) !== null) throw frontedLifecycleRefused(repo, 'created');
    return this.#call(repo, 'createRepo', async () => {
      const namespaceId = await this.#resolveNamespaceId();
      try {
        const body = {
          name: repo,
          path: repo,
          namespace_id: namespaceId,
          default_branch: defaultBranch,
          visibility: 'private',
          initialize_with_readme: false,
        };
        return this.#info(
          await this.#api.json(GitLabProject, '/projects', { method: 'POST', body }),
          defaultBranch,
        );
      } catch (error) {
        if (
          error instanceof GitLabHttpError &&
          error.status === 400 &&
          /already been taken/i.test(error.detail)
        )
          throw repoExists(repo);
        throw error;
      }
    });
  }

  async deleteRepo(name: string): Promise<void> {
    const repo = parseStorageInput(RepoName, name);
    if (this.#fronted.idOf(repo) !== null) throw frontedLifecycleRefused(repo, 'deleted');
    await this.#call(repo, 'deleteRepo', async () => {
      const project = await this.#projectOrNull(repo);
      if (project === null) return;
      await this.#api.request(`/projects/${project.id}`, { method: 'DELETE' });
      // With delayed deletion the project is only marked (and renamed); remove it for good so the
      // name is free again. Instances without delayed deletion have already removed it.
      const marked = await this.#api.json(GitLabProject, `/projects/${project.id}`).catch(() => null);
      if (marked !== null) {
        await this.#api.request(`/projects/${project.id}`, {
          method: 'DELETE',
          query: { permanently_remove: true, full_path: marked.path_with_namespace },
        });
      }
    });
  }

  async repoInfo(name: string): Promise<StorageRepoInfo | null> {
    const repo = parseStorageInput(RepoName, name);
    return this.#call(repo, 'repoInfo', async () => {
      const project = await this.#projectOrNull(repo);
      return project === null ? null : this.#info(project, 'main', repo);
    });
  }

  async resolveRef(name: string, ref: string): Promise<string | null> {
    const repo = parseStorageInput(RepoName, name);
    const parsed = parseStorageInput(StorageRef, ref);
    const [kind, short] = parsed.startsWith('refs/tags/')
      ? ['tags', parsed.slice(10)]
      : ['branches', parsed.replace(/^refs\/heads\//, '')];
    return this.#call(repo, 'resolveRef', async () => {
      try {
        return (
          await this.#api.json(GitLabRef, `${await this.#projectPath(repo)}/repository/${kind}/${enc(short)}`)
        ).commit.id;
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404 && !error.projectMissing) return null;
        throw error;
      }
    });
  }

  async readCommit(name: string, sha: string): Promise<Commit | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#call(repo, 'readCommit', async () => {
      const found = await this.#api.bytesOrNull(`${await this.#projectPath(repo)}/repository/commits/${id}`);
      if (found === null) return null;
      const [commit] = await readCommitsOverGit(await this.#client(repo), [id]);
      return commit ?? null;
    });
  }

  async readTree(name: string, sha: string): Promise<StorageTreeEntry[] | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#call(repo, 'readTree', async () => readTreeOverGit(await this.#client(repo), id));
  }

  async readBlob(name: string, sha: string): Promise<Uint8Array | null> {
    const repo = parseStorageInput(RepoName, name);
    const id = parseStorageInput(Sha, sha);
    return this.#call(repo, 'readBlob', async () =>
      this.#api.bytesOrNull(`${await this.#projectPath(repo)}/repository/blobs/${id}/raw`),
    );
  }

  async readFile(name: string, ref: string, path: string): Promise<Uint8Array | null> {
    const repo = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const file = parseStorageInput(FilePath, path);
    return this.#call(repo, 'readFile', async () =>
      this.#api.bytesOrNull(`${await this.#projectPath(repo)}/repository/files/${enc(file)}/raw`, {
        ref: revision,
      }),
    );
  }

  async log(name: string, ref: string, options: StorageLogOptions): Promise<Commit[]> {
    const repo = parseStorageInput(RepoName, name);
    const revision = parseStorageInput(Revision, ref);
    const { limit, offset } = parseStorageInput(StorageLogOptions, options);
    return this.#call(repo, 'log', async () => {
      const shas = await this.#listFirstParents(repo, revision, offset + limit);
      return readCommitsOverGit(await this.#client(repo), shas.slice(offset, offset + limit));
    });
  }

  /** One merge-base API call: `ancestor` is an ancestor exactly when it is the merge base. */
  async isAncestor(name: string, ancestor: string, descendant: string): Promise<boolean | null> {
    const repo = parseStorageInput(RepoName, name);
    const older = parseStorageInput(Sha, ancestor);
    const newer = parseStorageInput(Sha, descendant);
    return this.#call(repo, 'isAncestor', async () =>
      isAncestorOnGitLab(this.#api, await this.#projectPath(repo), older, newer),
    );
  }

  async gitRemote(name: string, access: string): Promise<GitRemote> {
    const repo = parseStorageInput(RepoName, name);
    parseStorageInput(GitAccess, access);
    return this.#call(repo, 'gitRemote', async () => {
      const project = await this.#projectOrNull(repo);
      if (project === null) throw repoNotFound(repo);
      const basic = btoa(`${this.#config.gitUsername}:${this.#config.token}`);
      // GitLab access tokens are not scoped per request: read and write remotes carry the same
      // credential, and the gateway's own policy decides who may push.
      return GitRemote.parse({
        url: project.http_url_to_repo,
        headers: { Authorization: `Basic ${basic}` },
        expiresAt: null,
      });
    });
  }

  /** The ids along the first-parent chain from `revision`, newest first, at most `count`. */
  async #listFirstParents(repo: string, revision: string, count: number): Promise<string[]> {
    const shas: string[] = [];
    for (let page = 1; shas.length < count; page += 1) {
      let listed: GitLabCommitSummary[];
      try {
        const query = { ref_name: revision, first_parent: true, per_page: PAGE, page };
        listed = await this.#api.json(
          z.array(GitLabCommitSummary),
          `${await this.#projectPath(repo)}/repository/commits`,
          { query },
        );
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404 && !error.projectMissing) return [];
        throw error;
      }
      shas.push(...listed.map((commit) => commit.id));
      if (listed.length < PAGE) break;
    }
    return shas.slice(0, count);
  }

  async #client(repo: string): Promise<GitHttpClient> {
    return new GitHttpClient(await this.gitRemote(repo, 'read'), { fetch: this.#fetch });
  }

  /**
   * The API path of `repo`'s project. A fronted name is checked to lie under the fronted namespace
   * first (once per id), so a project elsewhere is repo_not_found rather than reachable by id.
   */
  async #projectPath(repo: string): Promise<string> {
    const id = this.#fronted.idOf(repo);
    if (id === null) return `/projects/${enc(`${this.#config.namespace}/${repo}`)}`;
    if (!this.#fronted.verified(id) && (await this.#projectOrNull(repo)) === null) throw repoNotFound(repo);
    return `/projects/${id}`;
  }

  async #projectOrNull(repo: string): Promise<GitLabProject | null> {
    const id = this.#fronted.idOf(repo);
    const path = id === null ? `/projects/${enc(`${this.#config.namespace}/${repo}`)}` : `/projects/${id}`;
    try {
      const project = await this.#api.json(GitLabProject, path);
      if (project.marked_for_deletion_on !== null && project.marked_for_deletion_on !== undefined)
        return null;
      if (id === null) return project;
      return this.#fronted.admits(id, project) ? project : null;
    } catch (error) {
      if (error instanceof GitLabHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async #resolveNamespaceId(): Promise<number> {
    this.#namespaceId ??= (await this.#api.json(GitLabGroup, `/groups/${enc(this.#config.namespace)}`)).id;
    return this.#namespaceId;
  }

  /** The StorageRepoInfo of `project`; a fronted project is named by the reserved `name` it was opened by. */
  #info(project: GitLabProject, fallbackBranch: string, name?: string): StorageRepoInfo {
    return StorageRepoInfo.parse({
      name: name !== undefined && this.#fronted.idOf(name) !== null ? name : project.path,
      defaultBranch: project.default_branch ?? fallbackBranch,
      createdAt: new Date(project.created_at).toISOString(),
    });
  }

  /** Runs one call: GatewayErrors pass through, a 404 for the project is repo_not_found, anything else storage_unavailable. */
  async #call<T>(repo: string, what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isGatewayError(error)) throw error;
      if (error instanceof GitLabHttpError && error.projectMissing) throw repoNotFound(repo);
      throw storageUnavailable(`GitLab ${what}`, error);
    }
  }
}
