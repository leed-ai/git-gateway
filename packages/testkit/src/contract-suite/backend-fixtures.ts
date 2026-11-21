// SPDX-License-Identifier: Apache-2.0
import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import { createCommit } from '@leed-ai/git-gateway-core/objects/commit-object';
import { createObject } from '@leed-ai/git-gateway-core/objects/hash-object';
import type { GitObject, GitTreeEntry } from '@leed-ai/git-gateway-core/schemas/git-object';
import { editTree } from '@leed-ai/git-gateway-core/tree/edit-tree';
import { decodeTree } from '@leed-ai/git-gateway-core/objects/tree-object';

/** A file of a fixture commit: bytes (or UTF-8 text) and mode. */
export interface FixtureFile {
  readonly content: Uint8Array | string;
  readonly mode?: '100644' | '100755' | '120000';
}

/** A commit built for a test, with every new object it needs. */
export interface FixtureCommit {
  readonly sha: string;
  readonly commit: Commit;
  /** The commit, its root tree, every subtree and every blob. */
  readonly objects: GitObject[];
}

const encoder = new TextEncoder();
const AUTHOR = { name: 'Contract Suite', email: 'contract@example.com' };
let clock = Date.parse('2026-01-01T00:00:00Z');

/** A fresh whole-second UTC date, one minute after the last, so histories have distinct dates. */
function nextDate(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

/**
 * Builds a commit of exactly `files` (path → content) with the given parents, entirely in
 * memory through the core encoders. Dates are whole seconds in UTC, so a backend that reads the
 * commit back can report it exactly.
 */
export async function fixtureCommit(
  files: Readonly<Record<string, FixtureFile | string>>,
  parents: readonly string[] = [],
  message = 'Contract suite commit\n',
): Promise<FixtureCommit> {
  const objects = new Map<string, GitObject>();
  const changes = [];
  for (const [path, file] of Object.entries(files)) {
    const spec = typeof file === 'string' ? { content: file } : file;
    const blob = await createObject(
      'blob',
      typeof spec.content === 'string' ? encoder.encode(spec.content) : spec.content,
    );
    objects.set(blob.sha, blob);
    changes.push({ op: 'set' as const, path, mode: spec.mode ?? '100644', sha: blob.sha });
  }
  const reader = {
    async readTree(sha: string): Promise<GitTreeEntry[] | null> {
      const object = objects.get(sha);
      return object?.type === 'tree' ? decodeTree(object.data, sha) : null;
    },
  };
  const edited = await editTree({ tree: null, changes }, reader);
  for (const object of edited.objects) objects.set(object.sha, object);
  const signature = { ...AUTHOR, date: nextDate() };
  const created = await createCommit({
    tree: edited.tree,
    parents: [...parents],
    author: signature,
    committer: signature,
    message,
  });
  return { sha: created.object.sha, commit: created.commit, objects: [created.object, ...objects.values()] };
}

/** Deterministic pseudo-random bytes (xorshift32), so a large binary fixture is reproducible. */
export function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

/** Every byte value 0–255, twice: the smallest file that exercises all of them. */
export const ALL_BYTES: Uint8Array = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
