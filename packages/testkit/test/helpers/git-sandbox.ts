// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitBinary } from '../../src/git-binary.ts';

/** What a git invocation produced. */
export interface GitRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A scratch directory with git isolated from the user's and the system's configuration. */
export class GitSandbox {
  readonly dir = mkdtempSync(join(tmpdir(), 'git-gateway-testkit-'));

  constructor() {
    writeFileSync(
      join(this.dir, '.gitconfig'),
      '[user]\n\tname = Conformance\n\temail = conformance@example.com\n[init]\n\tdefaultBranch = main\n',
    );
  }

  /**
   * Runs git in `cwd` (default the sandbox) with extra `-c` settings. Asynchronous, so an HTTP
   * server in this process keeps answering while git talks to it.
   */
  async run(
    args: readonly string[],
    options: { cwd?: string; config?: readonly string[] } = {},
  ): Promise<GitRun> {
    const config = (options.config ?? []).flatMap((setting) => ['-c', setting]);
    const child = spawn(gitBinary(), [...config, ...args], {
      cwd: options.cwd ?? this.dir,
      env: {
        PATH: process.env['PATH'],
        HOME: this.dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(this.dir, '.gitconfig'),
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, stdout, stderr };
  }

  /** Runs git and returns trimmed stdout, failing on a non-zero exit. */
  async ok(
    args: readonly string[],
    options: { cwd?: string; config?: readonly string[] } = {},
  ): Promise<string> {
    const result = await this.run(args, options);
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A path inside the sandbox. */
  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
