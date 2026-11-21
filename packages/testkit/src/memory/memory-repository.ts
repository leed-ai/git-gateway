// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { decodeCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { decodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';
import type { GitObject, GitTreeEntry } from '@leed-ai/git-gateway-core/schemas/git-object';

/** One repository held in memory: its objects, its refs and the branch HEAD names. */
export class MemoryRepository {
  readonly name: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  /** Every object by id. Objects are never removed, like a git repository before gc. */
  readonly objects = new Map<string, GitObject>();
  /** Every ref by full name ("refs/heads/main") to the id it names. */
  readonly refs = new Map<string, string>();
  /** Ids whose whole closure (everything they reach) is known to be present. */
  readonly #complete = new Set<string>();

  constructor(name: string, defaultBranch: string, createdAt: string) {
    this.name = name;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
  }

  /** The full name of the ref HEAD points at. */
  get headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** Stores objects; an id already present is kept as it is. */
  put(objects: readonly GitObject[]): void {
    for (const object of objects) if (!this.objects.has(object.sha)) this.objects.set(object.sha, object);
  }

  /** An object of a given type by id, or null. */
  object(sha: string, type?: GitObject['type']): GitObject | null {
    const object = this.objects.get(sha);
    return object === undefined || (type !== undefined && object.type !== type) ? null : object;
  }

  /** A commit by id, decoded, or null. */
  commit(sha: string): Commit | null {
    const object = this.object(sha, 'commit');
    return object === null ? null : decodeCommit(sha, object.data);
  }

  /** A tree's entries by id, decoded, or null. */
  tree(sha: string): GitTreeEntry[] | null {
    const object = this.object(sha, 'tree');
    return object === null ? null : decodeTree(object.data, sha);
  }

  /** The ids an object links to: a commit's tree and parents, a tree's entries (submodules excluded). */
  links(object: GitObject): string[] {
    if (object.type === 'commit') {
      const commit = decodeCommit(object.sha, object.data);
      return [commit.tree, ...commit.parents];
    }
    if (object.type === 'tree') {
      return decodeTree(object.data, object.sha)
        .filter((entry) => entry.mode !== '160000')
        .map((entry) => entry.sha);
    }
    return [];
  }

  /**
   * The ids of objects reachable from `starts` that are missing, stopping at objects already
   * known complete. Records every fully present closure as complete, so later checks are cheap.
   */
  missingFrom(starts: readonly string[]): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    const visited: string[] = [];
    const stack = [...starts];
    while (stack.length > 0) {
      const sha = stack.pop() ?? '';
      if (seen.has(sha) || this.#complete.has(sha)) continue;
      seen.add(sha);
      const object = this.objects.get(sha);
      if (object === undefined) {
        missing.push(sha);
        continue;
      }
      visited.push(sha);
      stack.push(...this.links(object));
    }
    if (missing.length === 0) for (const sha of visited) this.#complete.add(sha);
    return missing;
  }

  /** Every object reachable from `wants`, leaving out everything reachable from `haves`. */
  reachable(wants: readonly string[], haves: readonly string[]): GitObject[] {
    const excluded = this.#closure(
      haves.filter((sha) => this.objects.has(sha)),
      new Set(),
    );
    const included = this.#closure(wants, excluded);
    return [...included].flatMap((sha) => this.objects.get(sha) ?? []);
  }

  #closure(starts: readonly string[], stop: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const sha = stack.pop() ?? '';
      if (out.has(sha) || stop.has(sha)) continue;
      const object = this.objects.get(sha);
      if (object === undefined) continue;
      out.add(sha);
      stack.push(...this.links(object));
    }
    return out;
  }
}
