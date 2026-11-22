// SPDX-License-Identifier: Apache-2.0
import type { ChangedPath, PushedCommit } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import type { StorageBackend } from '@leed-ai/git-gateway-contract/storage/storage-backend';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { decodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';
import type { GitTreeEntry } from '@leed-ai/git-gateway-core/schemas/git-object';

import type { PushedObjects } from './pushed-objects.ts';
import { ChangeSink, diffTrees, type TreeChange } from './tree-diff.ts';
import { Uncheckable, type ReadBudget } from './uncheckable.ts';

/** Where changed paths are computed from, and the bounds on computing them. */
export interface ChangedPathSources {
  readonly repo: string;
  readonly backend: Pick<StorageBackend, 'readCommit' | 'readTree' | 'readBlob'>;
  readonly objects: PushedObjects;
  readonly budget: ReadBudget;
  readonly maxChangedPaths: number;
}

const SUBMODULE = '160000';

/**
 * Computes, for each update of a push, the commits it brings (those of the pushed pack reachable
 * from its new id) and the paths each changes. Trees and commits come from the pack first and
 * from storage otherwise, each storage call counted against the budget; reads are shared across
 * updates. Throws {@link Uncheckable} when something cannot be read or a bound is passed.
 */
export class ChangedPaths {
  readonly #sources: ChangedPathSources;
  readonly #sink: ChangeSink;
  readonly #trees = new Map<string, Promise<readonly GitTreeEntry[]>>();
  readonly #commitTrees = new Map<string, Promise<string>>();
  readonly #sizes = new Map<string, Promise<number>>();

  constructor(sources: ChangedPathSources) {
    this.#sources = sources;
    this.#sink = new ChangeSink(sources.maxChangedPaths);
  }

  /** The new commits an update brings, newest first, with their changes. */
  async commitsOf(update: RefUpdate): Promise<PushedCommit[]> {
    if (update.newSha === ZERO_SHA) return [];
    const { commits } = this.#sources.objects;
    const result: PushedCommit[] = [];
    const seen = new Set([update.newSha]);
    const queue = [update.newSha];
    for (let sha = queue.shift(); sha !== undefined; sha = queue.shift()) {
      const commit = commits.get(sha);
      if (commit === undefined) continue;
      if (commit.parents === null) throw new Uncheckable(`commit ${sha} has a header git reads differently`);
      result.push({
        sha,
        parents: [...commit.parents],
        changes: await this.#changesOf(commit.tree, commit.parents),
      });
      for (const parent of commit.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return result;
  }

  /**
   * A commit's changes: against its parent, the empty tree for a root, and for a merge only the
   * paths that differ from every parent (the first parent's view of each).
   */
  async #changesOf(tree: string, parents: readonly string[]): Promise<ChangedPath[]> {
    const lookup = async (sha: string) => this.#tree(sha);
    const [first, ...others] = parents;
    let changes = await diffTrees(
      lookup,
      first === undefined ? null : await this.#treeOf(first),
      tree,
      this.#sink,
    );
    for (const other of others) {
      const paths = new Set(
        (await diffTrees(lookup, await this.#treeOf(other), tree, this.#sink)).map((c) => c.path),
      );
      changes = changes.filter((change) => paths.has(change.path));
    }
    const sorted = changes.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return Promise.all(sorted.map(async (change) => ({ ...change, size: await this.#sizeOf(change) })));
  }

  async #sizeOf(change: TreeChange): Promise<number | null> {
    if (change.newSha === null || change.newMode === SUBMODULE) return null;
    const sha = change.newSha;
    const inPack = this.#sources.objects.blobSizes.get(sha);
    if (inPack !== undefined) return inPack;
    return this.#cached(this.#sizes, sha, async () => {
      this.#sources.budget.spend();
      const blob = await this.#sources.backend.readBlob(this.#sources.repo, sha);
      if (blob === null) throw new Uncheckable(`blob ${sha} is in neither the pushed pack nor storage`);
      return blob.length;
    });
  }

  async #treeOf(commitSha: string): Promise<string> {
    const inPack = this.#sources.objects.commits.get(commitSha);
    if (inPack !== undefined) return inPack.tree;
    return this.#cached(this.#commitTrees, commitSha, async () => {
      this.#sources.budget.spend();
      const commit = await this.#sources.backend.readCommit(this.#sources.repo, commitSha);
      if (commit === null)
        throw new Uncheckable(`commit ${commitSha} is in neither the pushed pack nor storage`);
      return commit.tree;
    });
  }

  async #tree(sha: string): Promise<readonly GitTreeEntry[]> {
    return this.#cached(this.#trees, sha, async () => {
      const data = this.#sources.objects.trees.get(sha);
      if (data !== undefined) {
        try {
          return decodeTree(data, sha);
        } catch (error) {
          if (isCoreError(error)) throw new Uncheckable(`tree ${sha} could not be read (${error.message})`);
          throw error;
        }
      }
      this.#sources.budget.spend();
      const entries = await this.#sources.backend.readTree(this.#sources.repo, sha);
      if (entries === null) throw new Uncheckable(`tree ${sha} is in neither the pushed pack nor storage`);
      return entries.map(({ name, mode, sha: id }) => ({ name, mode, sha: id }));
    });
  }

  async #cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let found = cache.get(key);
    if (found === undefined) {
      found = load();
      cache.set(key, found);
    }
    return found;
  }
}
