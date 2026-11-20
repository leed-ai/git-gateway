// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { trackedFiles } from '../src/tracked-files.ts';
import { readWorkflowFiles } from '../src/workflow-files.ts';
import { findWorkflowViolations, triggersOf } from '../src/workflow-policy.ts';

const roots: string[] = [];
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'repo-files-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const git = (root: string, ...args: string[]): void => {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  });
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trackedFiles', () => {
  it('lists tracked and untracked files but never ignored ones', () => {
    const root = fixture({
      '.gitignore': 'dist/\n*.log\n',
      'src/tracked.ts': '',
      'src/new file.ts': '',
      'dist/out.js': '',
      'debug.log': '',
    });
    git(root, 'init', '--quiet', '.');
    git(root, 'add', '.gitignore', 'src/tracked.ts');
    expect(trackedFiles(root).toSorted()).toEqual(['.gitignore', 'src/new file.ts', 'src/tracked.ts']);
  });

  it('fails when the directory does not exist, rather than listing nothing', () => {
    const root = fixture({ 'a.ts': '' });
    expect(() => trackedFiles(join(root, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('readWorkflowFiles', () => {
  it('parses workflows (.yml and .yaml) and composite actions, sorted by path', () => {
    const root = fixture({
      '.github/workflows/b.yaml': 'on: push\npermissions: {}\njobs: {}\n',
      '.github/workflows/a.yml': 'on: [pull_request]\npermissions: {}\njobs: {}\n',
      '.github/actions/setup/action.yml': 'runs:\n  using: composite\n  steps: []\n',
      '.github/workflows/notes.md': 'not a workflow',
      '.github/actions/setup/README.md': 'not an action',
    });
    const files = readWorkflowFiles(root);
    expect(files.map(({ path }) => path)).toEqual([
      '.github/actions/setup/action.yml',
      '.github/workflows/a.yml',
      '.github/workflows/b.yaml',
    ]);
    expect(files.map(({ document }) => triggersOf(document))).toEqual([[], ['pull_request'], ['push']]);
  });

  it('reads a bare on: key as the trigger list, so the policy sees pull_request_target', () => {
    const root = fixture({
      '.github/workflows/danger.yml': 'on:\n  pull_request_target:\npermissions: {}\njobs: {}\n',
    });
    expect(findWorkflowViolations(readWorkflowFiles(root))).toEqual([
      {
        path: '.github/workflows/danger.yml',
        message: 'trigger pull_request_target runs fork code with secrets; use pull_request',
      },
    ]);
  });

  it('returns nothing when the repository has no .github directory', () => {
    expect(readWorkflowFiles(fixture({ 'README.md': '' }))).toEqual([]);
  });

  it('fails on a workflow that is not valid YAML', () => {
    const root = fixture({ '.github/workflows/broken.yml': 'on: [push\n' });
    expect(() => readWorkflowFiles(root)).toThrow(/end with a \]/);
  });
});
