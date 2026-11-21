// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';

import type { CommitReader } from '../../src/idempotency/find-idempotent-commit.ts';
import { decodeCommit } from '../../src/objects/commit-object.ts';
import { decodeTree } from '../../src/objects/tree-object.ts';
import type { GitTreeEntry } from '../../src/schemas/git-object.ts';
import type { TreeReader } from '../../src/tree/tree-reader.ts';

/** The git binary under test: `GIT_BINARY`, or `git` on the PATH. */
export const GIT = process.env['GIT_BINARY'] ?? 'git';

/** What a git invocation produced. */
export interface GitResult {
  readonly status: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/** A git environment isolated from the user's and the system's configuration. */
function isolatedEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

/** A scratch directory with helpers to run git inside it; call `dispose` when done. */
export class GitSandbox {
  readonly dir = mkdtempSync(join(tmpdir(), 'git-gateway-core-'));

  constructor() {
    writeFileSync(join(this.dir, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n');
  }

  /** Runs git; `input` is written to its stdin. */
  run(
    args: readonly string[],
    options: { input?: Uint8Array; cwd?: string; env?: Record<string, string> } = {},
  ): GitResult {
    const result = spawnSync(GIT, args, {
      cwd: options.cwd ?? this.dir,
      input: options.input,
      env: isolatedEnv(this.dir, options.env ?? {}),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, stdout: new Uint8Array(result.stdout), stderr: result.stderr.toString() };
  }

  /** Runs git and returns trimmed stdout, failing on a non-zero exit. */
  text(
    args: readonly string[],
    options: { input?: Uint8Array; cwd?: string; env?: Record<string, string> } = {},
  ): string {
    const result = this.run(args, options);
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
    return new TextDecoder().decode(result.stdout).trim();
  }

  /** Creates a bare repository and returns its path. */
  bare(name: string): string {
    const path = join(this.dir, name);
    this.text(['init', '--quiet', '--bare', '--initial-branch=main', path]);
    return path;
  }

  /** Writes an executable shell script and returns its path. */
  script(name: string, body: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A tree and commit reader over a real repository, through `git cat-file`. */
export function repositoryReader(sandbox: GitSandbox, repo: string): TreeReader & CommitReader {
  const read = (type: string, sha: string): Uint8Array | null => {
    const result = sandbox.run(['--git-dir', repo, 'cat-file', type, sha]);
    return result.status === 0 ? result.stdout : null;
  };
  return {
    async readTree(sha: string): Promise<readonly GitTreeEntry[] | null> {
      const data = read('tree', sha);
      return data === null ? null : decodeTree(data, sha);
    },
    async readCommit(sha: string): Promise<Commit | null> {
      const data = read('commit', sha);
      return data === null ? null : decodeCommit(sha, data);
    },
  };
}
