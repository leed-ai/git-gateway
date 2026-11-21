// SPDX-License-Identifier: Apache-2.0
import type { TreeEntry } from '../schemas/tree-entry.ts';
import { byteOrder } from './bytes.ts';
import { parentDirectories, type FileMap } from './file-map.ts';
import { modelSha } from './hash.ts';

/** Every directory of a snapshot with its entries, and the root tree id. */
export interface TreeIndex {
  readonly rootSha: string;
  /** Directory path ('' for the root) → its direct entries, sorted by path in byte order. */
  readonly directories: ReadonlyMap<string, readonly TreeEntry[]>;
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const depth = (path: string): number => (path === '' ? 0 : path.split('/').length);

/** Builds the directory index of a snapshot, computing each tree id from its entries bottom-up. */
export async function buildTreeIndex(files: FileMap): Promise<TreeIndex> {
  const children = new Map<string, Map<string, TreeEntry>>([['', new Map()]]);
  const childMap = (dir: string): Map<string, TreeEntry> => {
    let map = children.get(dir);
    if (map === undefined) {
      map = new Map();
      children.set(dir, map);
    }
    return map;
  };
  for (const [path, file] of files) {
    for (const dir of parentDirectories(path)) childMap(dir);
    childMap(dirOf(path)).set(path, {
      path,
      name: nameOf(path),
      type: 'blob',
      mode: file.executable ? '100755' : '100644',
      sha: file.sha,
    });
  }
  const deepestFirst = [...children.keys()].toSorted((a, b) => depth(b) - depth(a) || byteOrder(a, b));
  const directories = new Map<string, readonly TreeEntry[]>();
  let rootSha = '';
  for (const dir of deepestFirst) {
    const entries = [...(children.get(dir)?.values() ?? [])].toSorted((a, b) => byteOrder(a.path, b.path));
    directories.set(dir, entries);
    const sha = await modelSha('tree', entries.map((e) => `${e.mode} ${e.name} ${e.sha}`).join('\n'));
    if (dir === '') rootSha = sha;
    else childMap(dirOf(dir)).set(dir, { path: dir, name: nameOf(dir), type: 'tree', mode: '040000', sha });
  }
  return { rootSha, directories };
}

/** Every entry beneath a directory ('' for the root), sorted by full path in byte order. */
export function entriesBeneath(index: TreeIndex, dir: string, recursive: boolean): TreeEntry[] {
  const direct = index.directories.get(dir) ?? [];
  if (!recursive) return [...direct];
  const all: TreeEntry[] = [];
  const visit = (entries: readonly TreeEntry[]): void => {
    for (const entry of entries) {
      all.push(entry);
      if (entry.type === 'tree') visit(index.directories.get(entry.path) ?? []);
    }
  };
  visit(direct);
  return all.toSorted((a, b) => byteOrder(a.path, b.path));
}
