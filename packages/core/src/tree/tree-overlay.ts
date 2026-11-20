// SPDX-License-Identifier: Apache-2.0
import type { FileMode } from '@leed-ai/git-gateway-contract/schemas/tree-entry';

import { createObject } from '../objects/hash-object.ts';
import { encodeTree } from '../objects/tree-object.ts';
import type { GitObject, GitTreeEntry } from '../schemas/git-object.ts';
import { EMPTY_TREE_SHA, loadTree, type TreeReader } from './tree-reader.ts';

/** What a path names in the edited tree. */
export type PathState =
  | { readonly kind: 'missing' }
  /** A non-directory entry: a regular or executable file, a symbolic link or a submodule. */
  | { readonly kind: 'file'; readonly entry: GitTreeEntry }
  | { readonly kind: 'directory' }
  /** A proper parent of the path is a non-directory entry, at `at`. */
  | { readonly kind: 'blocked'; readonly at: string };

/** The outcome of writing an overlay. */
export interface WrittenTree {
  /** Id of the new root tree. */
  readonly tree: string;
  /** The tree objects that did not exist before, deepest first. */
  readonly objects: readonly GitObject[];
  /** Every id the rewritten trees reference, so callers can tell which new blobs are still used. */
  readonly referenced: ReadonlySet<string>;
}

interface DirNode {
  /** Id the directory had before editing; null for a directory the edit created. */
  readonly originalSha: string | null;
  /** The directory's entries by name, loaded on first use. */
  entries: Map<string, GitTreeEntry> | null;
  /** Subdirectories that have been loaded or created, by name. */
  readonly children: Map<string, DirNode>;
  dirty: boolean;
}

const newNode = (originalSha: string | null): DirNode => ({
  originalSha,
  entries: originalSha === null ? new Map() : null,
  children: new Map(),
  dirty: false,
});

const isTree = (entry: GitTreeEntry): boolean => entry.mode === '040000';

/**
 * A copy-on-write view of a git tree for editing. Only the directories along the paths it is
 * asked about are read (through the {@link TreeReader}); writing re-encodes only directories that
 * changed, copying every untouched entry as it was read, and leaves untouched subtrees as they are.
 */
export class TreeOverlay {
  readonly #reader: TreeReader;
  readonly #root: DirNode;

  /** `rootSha` is the tree to edit, or null to start from an empty tree. */
  constructor(reader: TreeReader, rootSha: string | null) {
    this.#reader = reader;
    this.#root = newNode(rootSha === EMPTY_TREE_SHA ? null : rootSha);
  }

  /** What `path` currently names. */
  async stat(path: string): Promise<PathState> {
    const segments = path.split('/');
    let node = this.#root;
    for (const [index, segment] of segments.entries()) {
      const entry = (await this.#entries(node)).get(segment);
      const isLast = index === segments.length - 1;
      if (entry === undefined) return { kind: 'missing' };
      if (!isTree(entry)) {
        return isLast
          ? { kind: 'file', entry }
          : { kind: 'blocked', at: segments.slice(0, index + 1).join('/') };
      }
      if (isLast) return { kind: 'directory' };
      node = await this.#child(node, segment, entry);
    }
    return { kind: 'missing' };
  }

  /**
   * Points `path` at a blob, symbolic link or submodule, creating missing parent directories and
   * replacing whatever entry the name had. The caller checks first that no parent is a file.
   */
  async set(path: string, mode: Exclude<FileMode, '040000'>, sha: string): Promise<void> {
    const segments = path.split('/');
    const name = segments.pop() ?? path;
    let node = this.#root;
    node.dirty = true;
    for (const segment of segments) {
      const entries = await this.#entries(node);
      const entry = entries.get(segment);
      if (entry === undefined) {
        const created = newNode(null);
        entries.set(segment, { name: segment, mode: '040000', sha: EMPTY_TREE_SHA });
        node.children.set(segment, created);
        node = created;
      } else if (isTree(entry)) {
        node = await this.#child(node, segment, entry);
      } else {
        throw new Error(`TreeOverlay.set: a parent of ${path} is not a directory`);
      }
      node.dirty = true;
    }
    (await this.#entries(node)).set(name, { name, mode, sha });
    node.children.delete(name);
  }

  /** Removes the entry at `path`; directories left empty disappear with it. No-op when absent. */
  async remove(path: string): Promise<void> {
    const segments = path.split('/');
    const name = segments.pop() ?? path;
    const trail: { node: DirNode; name: string }[] = [];
    let node = this.#root;
    for (const segment of segments) {
      const entry = (await this.#entries(node)).get(segment);
      if (entry === undefined || !isTree(entry)) return;
      trail.push({ node, name: segment });
      node = await this.#child(node, segment, entry);
    }
    const entries = await this.#entries(node);
    if (!entries.delete(name)) return;
    node.children.delete(name);
    node.dirty = true;
    for (const step of trail) step.node.dirty = true;
    for (let at = trail.pop(); at !== undefined; at = trail.pop()) {
      const child = at.node.children.get(at.name);
      if (child?.entries?.size !== 0) break;
      at.node.children.delete(at.name);
      (await this.#entries(at.node)).delete(at.name);
    }
  }

  /** Encodes every changed directory bottom-up and returns the new root id and the new trees. */
  async write(): Promise<WrittenTree> {
    const objects: GitObject[] = [];
    const referenced = new Set<string>();
    const tree = await this.#writeNode(this.#root, objects, referenced);
    return { tree, objects, referenced };
  }

  async #writeNode(node: DirNode, objects: GitObject[], referenced: Set<string>): Promise<string> {
    if (!node.dirty) return node.originalSha ?? EMPTY_TREE_SHA;
    const entries = await this.#entries(node);
    for (const [name, child] of node.children) {
      if (!child.dirty) continue;
      const entry = entries.get(name);
      if (entry !== undefined)
        entries.set(name, { ...entry, sha: await this.#writeNode(child, objects, referenced) });
    }
    for (const entry of entries.values()) referenced.add(entry.sha);
    const object = await createObject('tree', encodeTree([...entries.values()]));
    if (object.sha !== node.originalSha) objects.push(object);
    return object.sha;
  }

  async #entries(node: DirNode): Promise<Map<string, GitTreeEntry>> {
    if (node.entries === null) {
      const loaded = await loadTree(this.#reader, node.originalSha ?? EMPTY_TREE_SHA);
      node.entries = new Map(loaded.map((entry) => [entry.name, entry]));
    }
    return node.entries;
  }

  async #child(node: DirNode, name: string, entry: GitTreeEntry): Promise<DirNode> {
    let child = node.children.get(name);
    if (child === undefined) {
      child = newNode(entry.sha === EMPTY_TREE_SHA ? null : entry.sha);
      node.children.set(name, child);
    }
    await this.#entries(child);
    return child;
  }
}
