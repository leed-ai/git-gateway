// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { changelogSection, parsePackedPlan, releaseTag } from '../src/packed-plan.ts';

const entry = {
  dir: 'packages/core',
  name: '@leed-ai/git-gateway-core',
  version: '0.2.0',
  tarball: 'leed-ai-git-gateway-core-0.2.0.tgz',
};

describe('parsePackedPlan', () => {
  it('accepts a plan of this repository’s packages', () => {
    const snapshot = { ...entry, version: '0.2.1-next.20261122101500' };
    expect(parsePackedPlan({ tag: 'next', packages: [snapshot] })).toEqual({
      tag: 'next',
      packages: [snapshot],
    });
    expect(parsePackedPlan({ tag: 'latest', packages: [] })).toEqual({ tag: 'latest', packages: [] });
  });

  it.each([
    ['a tarball path', { tarball: '../../etc/x.tgz' }, /invalid tarball/],
    ['a tarball outside the directory', { tarball: '/tmp/x.tgz' }, /invalid tarball/],
    ['another scope', { name: '@other/git-gateway-core' }, /invalid name/],
    ['a directory outside packages/', { dir: 'tooling/repo' }, /invalid dir/],
    ['a version that is not semver', { version: 'latest' }, /invalid version/],
  ])('refuses %s', (_label, change, error) => {
    expect(() => parsePackedPlan({ tag: 'latest', packages: [{ ...entry, ...change }] })).toThrow(error);
  });

  it('refuses a malformed dist-tag, a missing list and a package listed twice', () => {
    expect(() => parsePackedPlan({ tag: '--otp=1', packages: [] })).toThrow(/invalid dist-tag/);
    expect(() => parsePackedPlan({ tag: 'latest' })).toThrow(/tag and a packages list/);
    expect(() => parsePackedPlan({ tag: 'latest', packages: [entry, entry] })).toThrow(/twice/);
  });
});

describe('releaseTag', () => {
  it('names a release the way Changesets tags it', () => {
    expect(releaseTag(entry)).toBe('@leed-ai/git-gateway-core@0.2.0');
  });
});

describe('changelogSection', () => {
  const changelog = [
    '# @leed-ai/git-gateway-core',
    '',
    '## 0.2.0',
    '',
    '### Minor Changes',
    '',
    '- abc123: Adds a thing.',
    '',
    '## 0.1.0',
    '',
    '- First release.',
    '',
  ].join('\n');

  it('returns the body under one version’s heading, up to the next version', () => {
    expect(changelogSection(changelog, '0.2.0')).toBe('### Minor Changes\n\n- abc123: Adds a thing.');
    expect(changelogSection(changelog, '0.1.0')).toBe('- First release.');
  });

  it('is undefined for a version with no section, and never matches a prefix', () => {
    expect(changelogSection(changelog, '0.3.0')).toBeUndefined();
    expect(changelogSection(changelog, '0.2')).toBeUndefined();
  });
});
