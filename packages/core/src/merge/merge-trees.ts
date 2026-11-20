// SPDX-License-Identifier: Apache-2.0
import { byteOrder } from '@leed-ai/git-gateway-contract/reference/bytes';

import { createObject } from '../objects/hash-object.ts';
import { encodeTree } from '../objects/tree-object.ts';
import type { GitObject, GitTreeEntry } from '../schemas/git-object.ts';
import { MergeTreesInput, type TreeMergeResult } from '../schemas/tree-merge.ts';
import { EMPTY_TREE_SHA, loadTree, type TreeReader } from '../tree/tree-reader.ts';

type Entry = GitTreeEntry | undefined;

/** A directory taken whole from one side, or merged from all three. */
type DirPick = { readonly sha: string } | { readonly node: MergeNode };

/** A merged directory. A name may hold both a file and a directory until conflicts are known. */
interface MergeNode {
  readonly files: Map<string, GitTreeEntry>;
  readonly dirs: Map<string, DirPick>;
  /** Ids the three sides had for this directory; a merged tree equal to one of them is not new. */
  readonly sources: ReadonlySet<string>;
}

const same = (a: Entry, b: Entry): boolean =>
  a === undefined || b === undefined ? a === b : a.mode === b.mode && a.sha === b.sha;
const isTree = (entry: Entry): boolean => entry?.mode === '040000';
const fileOf = (entry: Entry): Entry => (isTree(entry) ? undefined : entry);
const treeOf = (entry: Entry): string | undefined => (isTree(entry) ? entry?.sha : undefined);
const join = (prefix: string, name: string): string => (prefix === '' ? name : `${prefix}/${name}`);

/** The three-way pick: the side that changed, or undefined when both changed differently. */
function pick<T>(base: T, ours: T, theirs: T, equal: (a: T, b: T) => boolean): { value: T } | undefined {
  if (equal(ours, theirs) || equal(theirs, base)) return { value: ours };
  if (equal(ours, base)) return { value: theirs };
  return undefined;
}

class TreeMerger {
  readonly conflicts = new Set<string>();

  constructor(readonly reader: TreeReader) {}

  async entries(sha: string | undefined): Promise<Map<string, GitTreeEntry>> {
    const list = sha === undefined ? [] : await loadTree(this.reader, sha);
    return new Map(list.map((entry) => [entry.name, entry]));
  }

  async mergeDir(prefix: string, base?: string, ours?: string, theirs?: string): Promise<MergeNode> {
    const [b, o, t] = await Promise.all([this.entries(base), this.entries(ours), this.entries(theirs)]);
    const sources = new Set([base, ours, theirs].filter((sha) => sha !== undefined));
    const node: MergeNode = { files: new Map(), dirs: new Map(), sources };
    for (const name of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
      await this.mergeName(node, join(prefix, name), name, b.get(name), o.get(name), t.get(name));
    }
    return node;
  }

  async mergeName(node: MergeNode, path: string, name: string, b: Entry, o: Entry, t: Entry): Promise<void> {
    const whole = pick(b, o, t, same);
    if (whole !== undefined) {
      const entry = whole.value;
      if (entry !== undefined && isTree(entry)) node.dirs.set(name, { sha: entry.sha });
      else if (entry !== undefined) node.files.set(name, entry);
      return;
    }
    // Both sides changed this name differently: merge its file part and its directory part apart.
    const file = pick(fileOf(b), fileOf(o), fileOf(t), same);
    if (file === undefined) this.conflicts.add(path);
    else if (file.value !== undefined) node.files.set(name, file.value);
    const tree = pick(treeOf(b), treeOf(o), treeOf(t), (x, y) => x === y);
    const dir: DirPick | undefined =
      tree === undefined
        ? { node: await this.mergeDir(path, treeOf(b), treeOf(o), treeOf(t)) }
        : tree.value === undefined
          ? undefined
          : { sha: tree.value };
    if (dir === undefined) return;
    node.dirs.set(name, dir);
    const hasFile = file === undefined || file.value !== undefined;
    if (!hasFile) return;
    // A file (or a conflicted file) where the merge also has a directory conflicts with every file beneath.
    const beneath = await this.filesBeneath(path, dir);
    if (beneath.length === 0) return;
    this.conflicts.add(path);
    for (const below of beneath) this.conflicts.add(below);
  }

  async filesBeneath(prefix: string, dir: DirPick): Promise<string[]> {
    const found: string[] = [];
    if ('sha' in dir) {
      for (const entry of (await this.entries(dir.sha)).values()) {
        const path = join(prefix, entry.name);
        if (isTree(entry)) found.push(...(await this.filesBeneath(path, { sha: entry.sha })));
        else found.push(path);
      }
      return found;
    }
    for (const name of dir.node.files.keys()) found.push(join(prefix, name));
    for (const [name, child] of dir.node.dirs)
      found.push(...(await this.filesBeneath(join(prefix, name), child)));
    return found;
  }

  /** Writes a conflict-free merged directory; returns its id, or null when it is empty. */
  async materialize(node: MergeNode, objects: GitObject[]): Promise<string | null> {
    const entries: GitTreeEntry[] = [...node.files.values()];
    for (const [name, dir] of node.dirs) {
      const sha = 'sha' in dir ? dir.sha : await this.materialize(dir.node, objects);
      if (sha !== null) entries.push({ name, mode: '040000', sha });
    }
    if (entries.length === 0) return null;
    const object = await createObject('tree', encodeTree(entries));
    if (!node.sources.has(object.sha)) objects.push(object);
    return object.sha;
  }
}

/**
 * File-level three-way merge of two trees against their merge base, reading only directories
 * whose ids differ between the sides. A path changed on one side only takes that side; a path
 * changed identically on both takes either; a path changed differently on both (content, mode,
 * or delete against modify) is a conflict, as is a file where the merged result has a directory
 * — then the file and every merged path beneath it are reported. Same rules as the contract's
 * reference merge, so the two agree on every input.
 */
export async function mergeTrees(input: MergeTreesInput, reader: TreeReader): Promise<TreeMergeResult> {
  const { base, ours, theirs } = MergeTreesInput.parse(input);
  if (ours === theirs || theirs === base) return { status: 'merged', tree: ours, objects: [] };
  if (ours === base) return { status: 'merged', tree: theirs, objects: [] };
  const merger = new TreeMerger(reader);
  const root = await merger.mergeDir('', base, ours, theirs);
  if (merger.conflicts.size > 0) {
    return { status: 'conflict', paths: [...merger.conflicts].toSorted(byteOrder) };
  }
  const objects: GitObject[] = [];
  const tree = await merger.materialize(root, objects);
  if (tree !== null) return { status: 'merged', tree, objects };
  // Everything was deleted: the result is the empty tree, which cannot come from materialize.
  // It is a new object only when none of the inputs already is the empty tree.
  const emptyTreeObjects = [base, ours, theirs].includes(EMPTY_TREE_SHA)
    ? []
    : [await createObject('tree', new Uint8Array(0))];
  return { status: 'merged', tree: EMPTY_TREE_SHA, objects: emptyTreeObjects };
}
