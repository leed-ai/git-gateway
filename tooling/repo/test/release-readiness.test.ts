// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { type CheckoutState, pendingChangesets, releaseProblems } from '../src/release-readiness.ts';

const ready: CheckoutState = {
  branch: 'main',
  dirty: [],
  fetched: true,
  behind: 0,
  pendingChangesets: [],
  npmUser: 'someone',
  ghAuthenticated: true,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pendingChangesets', () => {
  it('lists changeset files but not the README or the config', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-'));
    roots.push(root);
    mkdirSync(join(root, '.changeset'));
    for (const name of ['README.md', 'config.json', 'b-change.md', 'a-change.md']) {
      writeFileSync(join(root, '.changeset', name), '');
    }
    expect(pendingChangesets(root)).toEqual(['a-change.md', 'b-change.md']);
  });

  it('is empty without a .changeset directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-'));
    roots.push(root);
    expect(pendingChangesets(root)).toEqual([]);
  });
});

describe('releaseProblems', () => {
  it('passes a clean, current main with npm and GitHub sessions', () => {
    expect(releaseProblems(ready, { publishing: true })).toEqual([]);
  });

  it('reports every problem at once', () => {
    const state: CheckoutState = {
      branch: 'feature',
      dirty: ['a.ts'],
      fetched: true,
      behind: 2,
      pendingChangesets: ['x.md'],
      npmUser: null,
      ghAuthenticated: false,
    };
    expect(releaseProblems(state, { publishing: true })).toHaveLength(6);
  });

  it('holds a dry run to the tree but not to the sessions or the branch', () => {
    const state = { ...ready, branch: 'feature', npmUser: null, ghAuthenticated: false, fetched: false };
    expect(releaseProblems(state, { publishing: false })).toEqual([]);
    expect(releaseProblems({ ...state, pendingChangesets: ['x.md'] }, { publishing: false })).toEqual([
      expect.stringContaining('merge the "chore: release packages" pull request first'),
    ]);
  });

  it('refuses when git status could not be read, rather than reading it as clean', () => {
    expect(releaseProblems({ ...ready, dirty: null }, { publishing: false })).toEqual([
      'git status failed, so the working tree cannot be checked',
    ]);
  });
});
