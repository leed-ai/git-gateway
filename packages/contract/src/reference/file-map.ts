// SPDX-License-Identifier: Apache-2.0

/** One file of the in-memory model: its bytes, executable bit and blob id. */
export interface StoredFile {
  readonly bytes: Uint8Array;
  readonly executable: boolean;
  readonly sha: string;
}

/** A snapshot of a repository: every file by full path. Directories are implied by paths. */
export type FileMap = ReadonlyMap<string, StoredFile>;

/** Every proper parent directory of a path, shallowest first: `a/b/c` → `a`, `a/b`. */
export function parentDirectories(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/** True when some file lies beneath `path`, i.e. it is a directory of the snapshot. */
export function isDirectory(files: FileMap, path: string): boolean {
  const prefix = `${path}/`;
  for (const key of files.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/** The shallowest parent of `path` that is a file, or undefined when none is. */
export function fileParent(files: FileMap, path: string): string | undefined {
  return parentDirectories(path).find((parent) => files.has(parent));
}

/** True when two stored files have the same content and mode. */
export function sameFile(a: StoredFile | undefined, b: StoredFile | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.sha === b.sha && a.executable === b.executable;
}
