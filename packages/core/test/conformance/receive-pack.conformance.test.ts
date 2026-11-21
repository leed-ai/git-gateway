// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommitActionInput } from '@leed-ai/git-gateway-contract/schemas/commit-action';
import { afterAll, describe, expect, it } from 'vite-plus/test';

import { streamOf, readAllBytes } from '../../src/bytes.ts';
import { buildCommit } from '../../src/commit/build-commit.ts';
import { findIdempotentCommit } from '../../src/idempotency/find-idempotent-commit.ts';
import { mergeTrees } from '../../src/merge/merge-trees.ts';
import { createCommit } from '../../src/objects/commit-object.ts';
import { writePack } from '../../src/pack/write-pack.ts';
import { encodeReceivePackRequest } from '../../src/receive-pack/encode-request.ts';
import { parseReceivePackRequest } from '../../src/receive-pack/parse-request.ts';
import { decodePktLines } from '../../src/pkt-line/decode.ts';
import {
  parseReportStatus,
  reportStatusFraming,
  type SideBandMode,
} from '../../src/receive-pack/report-status.ts';
import type { ReceivePackCommand } from '../../src/schemas/receive-pack.ts';
import type { ReportStatus } from '../../src/schemas/report-status.ts';
import { GIT, GitSandbox, repositoryReader } from '../helpers/git.ts';

const ZERO = '0'.repeat(40);
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };
const sandbox = new GitSandbox();
afterAll(() => sandbox.dispose());

/** Sends a request to `git receive-pack --stateless-rpc`, as the smart-HTTP endpoint would. */
function receivePack(repo: string, body: Uint8Array, sideBand: SideBandMode = 'none'): ReportStatus {
  const result = sandbox.run(['receive-pack', '--stateless-rpc', repo], { input: body });
  expect(result.status).toBe(0);
  return parseReportStatus(result.stdout, { sideBand });
}

let commitCount = 0;

/** Builds a commit on a branch of a real repository, reading its trees through cat-file, and pushes it. */
async function commitAndPush(
  repo: string,
  branch: string,
  actions: CommitActionInput[],
  options: { base?: string | null; sideBand?: SideBandMode; key?: string } = {},
): Promise<{ sha: string; report: ReportStatus }> {
  const reader = repositoryReader(sandbox, repo);
  const resolved = sandbox.run(['--git-dir', repo, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  const current = resolved.status === 0 ? new TextDecoder().decode(resolved.stdout).trim() : null;
  const headSha = options.base === undefined ? current : options.base;
  const base =
    headSha === null
      ? null
      : { sha: headSha, tree: sandbox.text(['--git-dir', repo, 'rev-parse', `${headSha}^{tree}`]) };
  commitCount += 1;
  const built = await buildCommit(
    {
      branch,
      base,
      // A branch that does not exist yet is created (all-zero old id); otherwise the push names the base.
      oldSha: current === null ? null : headSha,
      actions,
      message: `Change ${commitCount}`,
      author: ADA,
      idempotencyKey: options.key ?? `key-${commitCount}`,
      date: new Date(Date.UTC(2026, 10, 20, 9, commitCount)).toISOString(),
    },
    reader,
  );
  if (built.status !== 'ready') throw new Error('expected a commit');
  const sideBand = options.sideBand ?? 'none';
  const capabilities = sideBand === 'none' ? ['report-status'] : ['report-status', sideBand];
  const body = encodeReceivePackRequest({
    commands: [built.refUpdate],
    capabilities,
    pack: await writePack(built.objects),
  });
  return { sha: built.commit.sha, report: receivePack(repo, body, sideBand) };
}

describe(`pushes to ${GIT} receive-pack`, () => {
  const repo = sandbox.bare('push.git');

  it('creates a branch with a root commit', async () => {
    const { sha, report } = await commitAndPush(repo, 'main', [
      { action: 'create', path: 'README.md', content: '# Site\n' },
      { action: 'create', path: 'content/about.md', content: 'About\n' },
      { action: 'create', path: 'scripts/build.sh', content: '#!/bin/sh\n' },
      { action: 'chmod', path: 'scripts/build.sh', executeFilemode: true },
    ]);
    expect(report).toEqual({ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] });
    expect(sandbox.text(['--git-dir', repo, 'rev-parse', 'main'])).toBe(sha);
    expect(sandbox.text(['--git-dir', repo, 'ls-tree', 'main', 'scripts/build.sh'])).toMatch(/^100755 blob /);
  });

  it('commits on top of the head, reading only what it needs, with side-band framing', async () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13);
    const { sha, report } = await commitAndPush(
      repo,
      'main',
      [
        { action: 'update', path: 'content/about.md', content: 'About us\n' },
        {
          action: 'create',
          path: 'assets/logo.png',
          content: btoa(String.fromCodePoint(...png)),
          encoding: 'base64',
        },
        { action: 'move', previousPath: 'README.md', path: 'docs/README.md' },
      ],
      { sideBand: 'side-band-64k' },
    );
    expect(report.unpack).toBe('ok');
    expect(sandbox.text(['--git-dir', repo, 'rev-parse', 'main^'])).toBe(
      sandbox.text(['--git-dir', repo, 'rev-parse', `${sha}^`]),
    );
    expect(sandbox.run(['--git-dir', repo, 'cat-file', 'blob', 'main:assets/logo.png']).stdout).toEqual(png);
    expect(sandbox.text(['--git-dir', repo, 'show', 'main:docs/README.md'])).toBe('# Site');
    expect(sandbox.run(['--git-dir', repo, 'fsck', '--strict', '--no-dangling']).status).toBe(0);
  });

  it('gets a bare report when asking for plain side-band, which receive-pack never advertises', async () => {
    const reader = repositoryReader(sandbox, repo);
    const head = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const built = await buildCommit(
      {
        branch: 'main',
        base: { sha: head, tree: sandbox.text(['--git-dir', repo, 'rev-parse', 'main^{tree}']) },
        oldSha: head,
        actions: [{ action: 'create', path: 'side-band.md', content: 'small packets\n' }],
        message: 'Plain side-band',
        author: ADA,
        idempotencyKey: 'plain-side-band',
        date: '2026-11-20T09:59:00.000Z',
      },
      reader,
    );
    if (built.status !== 'ready') throw new Error('expected a commit');
    const body = encodeReceivePackRequest({
      commands: [built.refUpdate],
      capabilities: ['report-status', 'side-band'],
      pack: await writePack(built.objects),
    });
    const result = sandbox.run(['receive-pack', '--stateless-rpc', repo], { input: body });
    const framing = reportStatusFraming(['report-status']);
    expect(parseReportStatus(result.stdout, framing)).toEqual({
      unpack: 'ok',
      refs: [{ ref: 'refs/heads/main', status: 'ok' }],
    });
    expect(
      decodePktLines(result.stdout).every((packet) => packet.type !== 'data' || packet.payload[0] !== 1),
    ).toBe(true);
  });

  it('pushes a commit dated at the epoch, which git fsck accepts', async () => {
    const head = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const epoch = { ...ADA, date: '1970-01-01T00:00:00.000Z' };
    const { object, commit } = await createCommit({
      tree: sandbox.text(['--git-dir', repo, 'rev-parse', 'main^{tree}']),
      parents: [head],
      author: epoch,
      committer: epoch,
      message: 'Dated at the epoch\n',
    });
    const report = receivePack(
      repo,
      encodeReceivePackRequest({
        commands: [{ oldSha: ZERO, newSha: commit.sha, ref: 'refs/heads/epoch' }],
        pack: await writePack([object]),
      }),
    );
    expect(report.refs).toEqual([{ ref: 'refs/heads/epoch', status: 'ok' }]);
    expect(sandbox.text(['--git-dir', repo, 'log', '-1', '--format=%at %ct', 'epoch'])).toBe('0 0');
    expect(sandbox.run(['--git-dir', repo, 'fsck', '--strict', '--no-dangling']).status).toBe(0);
  });

  it('is refused when the head moved, and nothing is overwritten', async () => {
    const before = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const stale = sandbox.text(['--git-dir', repo, 'rev-parse', 'main^']);
    const { report } = await commitAndPush(
      repo,
      'main',
      [{ action: 'create', path: 'late.md', content: 'x' }],
      { base: stale },
    );
    expect(report.refs).toEqual([{ ref: 'refs/heads/main', status: 'ng', reason: expect.any(String) }]);
    expect(sandbox.text(['--git-dir', repo, 'rev-parse', 'main'])).toBe(before);
  });

  it('finds an earlier commit by its idempotency key in the real history', async () => {
    const { sha } = await commitAndPush(repo, 'main', [{ action: 'create', path: 'once.md', content: '1' }], {
      key: 'cms:once',
    });
    await commitAndPush(repo, 'main', [{ action: 'create', path: 'later.md', content: '2' }]);
    const found = await findIdempotentCommit(
      {
        head: sandbox.text(['--git-dir', repo, 'rev-parse', 'main']),
        key: 'cms:once',
        window: { maxCommits: 10, maxAgeSeconds: 3600 },
        now: '2026-11-20T10:00:00.000Z',
      },
      repositoryReader(sandbox, repo),
    );
    expect(found?.sha).toBe(sha);
  });

  it('pushes a merge commit built by mergeTrees', async () => {
    const fork = sandbox.text(['--git-dir', repo, 'rev-parse', 'main']);
    const ours = await commitAndPush(repo, 'main', [{ action: 'create', path: 'ours.md', content: 'o' }]);
    const theirs = await commitAndPush(
      repo,
      'staging',
      [{ action: 'create', path: 'theirs.md', content: 't' }],
      { base: fork },
    );
    const tree = (sha: string): string => sandbox.text(['--git-dir', repo, 'rev-parse', `${sha}^{tree}`]);
    const merged = await mergeTrees(
      { base: tree(fork), ours: tree(ours.sha), theirs: tree(theirs.sha) },
      repositoryReader(sandbox, repo),
    );
    if (merged.status !== 'merged') throw new Error('expected a clean merge');
    const signature = { ...ADA, date: '2026-11-20T11:00:00.000Z' };
    const { object, commit } = await createCommit({
      tree: merged.tree,
      parents: [ours.sha, theirs.sha],
      author: signature,
      committer: signature,
      message: 'Merge staging into main\n',
    });
    const command: ReceivePackCommand = { oldSha: ours.sha, newSha: commit.sha, ref: 'refs/heads/main' };
    const report = receivePack(
      repo,
      encodeReceivePackRequest({ commands: [command], pack: await writePack([...merged.objects, object]) }),
    );
    expect(report.refs).toEqual([{ ref: 'refs/heads/main', status: 'ok' }]);
    expect(sandbox.text(['--git-dir', repo, 'ls-tree', '--name-only', 'main']).split('\n')).toEqual(
      expect.arrayContaining(['ours.md', 'theirs.md']),
    );
    expect(sandbox.run(['--git-dir', repo, 'fsck', '--strict', '--no-dangling']).status).toBe(0);
  });

  it('deletes a branch with a pack-less request', () => {
    const head = sandbox.text(['--git-dir', repo, 'rev-parse', 'staging']);
    const report = receivePack(
      repo,
      encodeReceivePackRequest({ commands: [{ oldSha: head, newSha: ZERO, ref: 'refs/heads/staging' }] }),
    );
    expect(report.refs).toEqual([{ ref: 'refs/heads/staging', status: 'ok' }]);
    expect(
      sandbox.run(['--git-dir', repo, 'rev-parse', '--verify', '-q', 'refs/heads/staging']).status,
    ).not.toBe(0);
  });
});

describe(`requests from a real ${GIT} push client`, () => {
  it('parses the commands, capabilities and push options git sends, and replays the body exactly', async () => {
    const remote = sandbox.bare('capture.git');
    sandbox.text(['--git-dir', remote, 'config', 'receive.advertisePushOptions', 'true']);
    const capture = join(sandbox.dir, 'captured-request');
    const wrapper = sandbox.script(
      'capture-receive-pack',
      `tee "${capture}" | exec "${GIT}" receive-pack "$@"`,
    );
    const work = join(sandbox.dir, 'work');
    sandbox.text(['init', '--quiet', '--initial-branch=main', work]);
    sandbox.text(['-C', work, 'commit', '--quiet', '--allow-empty', '-m', 'first']);
    sandbox.text(['-C', work, 'tag', 'v1']);
    sandbox.text([
      '-C',
      work,
      'push',
      '--quiet',
      `--receive-pack=${wrapper}`,
      '-o',
      'ci.skip',
      '-o',
      'note=hello world',
      remote,
      'main',
      'v1',
    ]);
    const body = new Uint8Array(readFileSync(capture));
    const { request, body: replay } = await parseReceivePackRequest(
      streamOf(body.slice(0, 7), body.slice(7)),
    );
    const head = sandbox.text(['-C', work, 'rev-parse', 'main']);
    const tag = sandbox.text(['-C', work, 'rev-parse', 'v1']);
    expect(request.commands).toEqual([
      { oldSha: ZERO, newSha: head, ref: 'refs/heads/main' },
      { oldSha: ZERO, newSha: tag, ref: 'refs/tags/v1' },
    ]);
    expect(request.capabilities).toContain('push-options');
    expect(request.capabilities.some((c) => c === 'report-status' || c === 'report-status-v2')).toBe(true);
    expect(request.pushOptions).toEqual(['ci.skip', 'note=hello world']);
    expect(await readAllBytes(replay)).toEqual(body);
    expect(sandbox.text(['--git-dir', remote, 'rev-parse', 'main'])).toBe(head);
  });
});
