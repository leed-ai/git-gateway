// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { pinLowestPeers } from '../src/lowest-peers.ts';
import type { WorkspacePackage } from '../src/manifest.ts';
import { publishArguments } from '../src/packed-plan.ts';
import { orderByDependencies, planPublish } from '../src/publish-plan.ts';
import { snapshotChangeset } from '../src/snapshot-changeset.ts';

const packages: WorkspacePackage[] = [
  { dir: '.', manifest: { name: 'root', private: true } },
  { dir: 'packages/core', manifest: { name: '@leed-ai/git-gateway-core', version: '0.1.0' } },
  { dir: 'packages/worker', manifest: { name: '@leed-ai/git-gateway-worker', version: '0.1.0' } },
  { dir: 'examples/gateway', manifest: { name: 'example', version: '0.0.0', private: true } },
];

describe('pinLowestPeers', () => {
  it('pins installed peers to the floor of their declared range', () => {
    const manifest = {
      peerDependencies: { zod: '^4', cloudflare: '^5' },
      devDependencies: { zod: '^4.6.7', cloudflare: '^5.2.0', other: '^1.0.0' },
    };
    expect(pinLowestPeers(manifest).devDependencies).toEqual({
      zod: '4.0.0',
      cloudflare: '5.0.0',
      other: '^1.0.0',
    });
  });

  it('uses the policy range where the package installs a peer it does not declare', () => {
    expect(pinLowestPeers({ devDependencies: { hono: '^4.13.19' } }).devDependencies).toEqual({
      hono: '4.0.0',
    });
  });

  it('leaves a manifest without peers untouched', () => {
    const manifest = { devDependencies: { other: '^1.0.0' } };
    expect(pinLowestPeers(manifest)).toBe(manifest);
  });

  it('fails on a peer range it cannot floor', () => {
    expect(() =>
      pinLowestPeers({ peerDependencies: { zod: '^4 || ^5' }, devDependencies: { zod: '^4' } }),
    ).toThrow(/zod/);
  });
});

describe('snapshotChangeset', () => {
  it('bumps every public package by a patch', () => {
    expect(snapshotChangeset(packages)).toBe(
      '---\n"@leed-ai/git-gateway-core": patch\n"@leed-ai/git-gateway-worker": patch\n---\n\nSnapshot of main for the next dist-tag.\n',
    );
  });

  it('lists packages sorted by name whatever their directory order', () => {
    const reversed = [...packages].toReversed();
    expect(snapshotChangeset(reversed)).toBe(snapshotChangeset(packages));
  });

  it('refuses when there is nothing public', () => {
    expect(() => snapshotChangeset(packages.slice(0, 1))).toThrow(/no public packages/);
  });
});

describe('planPublish', () => {
  it('selects public packages whose version is not published yet', () => {
    const published = new Set(['@leed-ai/git-gateway-core@0.1.0']);
    expect(planPublish(packages, (name, version) => published.has(`${name}@${version}`))).toEqual([
      { dir: 'packages/worker', name: '@leed-ai/git-gateway-worker', version: '0.1.0' },
    ]);
  });

  it('never publishes the root, even when it is not marked private', () => {
    expect(planPublish([{ dir: '.', manifest: { name: 'root', version: '1.0.0' } }], () => false)).toEqual(
      [],
    );
  });

  it('asks the registry about exactly the public name and version pairs', () => {
    const asked: string[] = [];
    planPublish(packages, (name, version) => {
      asked.push(`${name}@${version}`);
      return true;
    });
    expect(asked).toEqual(['@leed-ai/git-gateway-core@0.1.0', '@leed-ai/git-gateway-worker@0.1.0']);
  });

  it('fails on a public package without a version', () => {
    expect(() => planPublish([{ dir: 'packages/x', manifest: { name: 'x' } }], () => false)).toThrow(
      /name and version/,
    );
  });
});

const pkg = (short: string, fields: Partial<WorkspacePackage['manifest']> = {}): WorkspacePackage => ({
  dir: `packages/${short}`,
  manifest: { name: `@leed-ai/git-gateway-${short}`, version: '0.1.0', ...fields },
});
const internal = (short: string): Record<string, string> => ({
  [`@leed-ai/git-gateway-${short}`]: 'workspace:*',
});
const namesOf = (list: readonly { readonly dir: string }[]): string[] =>
  list.map(({ dir }) => dir.replace('packages/', ''));

describe('publish order', () => {
  it('publishes an internal dependency before the packages that need it, whatever the directory order', () => {
    const list = [
      pkg('auth-jwt', { peerDependencies: { ...internal('contract'), zod: '^4' } }),
      pkg('contract', { peerDependencies: { zod: '^4' } }),
      pkg('core', { dependencies: internal('contract') }),
      pkg('worker', { dependencies: { ...internal('core'), ...internal('auth-jwt') } }),
      pkg('backend-gitlab', { optionalDependencies: internal('core') }),
    ];
    expect(namesOf(planPublish(list, () => false))).toEqual([
      'contract',
      'auth-jwt',
      'core',
      'worker',
      'backend-gitlab',
    ]);
  });

  it('ignores devDependencies, which consumers never install', () => {
    const list = [pkg('a', { devDependencies: internal('b') }), pkg('b')];
    expect(namesOf(orderByDependencies(list))).toEqual(['a', 'b']);
  });

  it('keeps an already published dependency out of the plan but still orders around it', () => {
    const list = [pkg('worker', { dependencies: internal('core') }), pkg('core'), pkg('testkit')];
    expect(namesOf(planPublish(list, (name) => name.endsWith('-core')))).toEqual(['worker', 'testkit']);
    expect(namesOf(planPublish(list, () => false))).toEqual(['core', 'worker', 'testkit']);
  });

  it('places every package after all of its internal dependencies for any directory order', () => {
    const list = [
      pkg('contract'),
      pkg('core', { dependencies: internal('contract') }),
      pkg('auth-jwt', { peerDependencies: internal('contract') }),
      pkg('worker', { dependencies: { ...internal('core'), ...internal('auth-jwt') } }),
      pkg('testkit', { peerDependencies: { ...internal('core'), ...internal('worker') } }),
    ];
    const permutations = (items: WorkspacePackage[]): WorkspacePackage[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
          );
    for (const order of permutations(list)) {
      const position = new Map(namesOf(orderByDependencies(order)).map((name, index) => [name, index]));
      for (const { manifest, dir } of order) {
        const deps = [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ];
        for (const dep of deps) {
          expect(position.get(dep.replace('@leed-ai/git-gateway-', ''))).toBeLessThan(
            position.get(dir.replace('packages/', '')) ?? -1,
          );
        }
      }
    }
  });

  it('refuses a dependency cycle', () => {
    const list = [pkg('a', { dependencies: internal('b') }), pkg('b', { peerDependencies: internal('a') })];
    expect(() => orderByDependencies(list)).toThrow(
      'dependency cycle between packages: @leed-ai/git-gateway-a -> @leed-ai/git-gateway-b -> @leed-ai/git-gateway-a',
    );
  });
});

describe('publishArguments', () => {
  it('publishes publicly under the dist-tag, stating provenance either way', () => {
    expect(publishArguments({ tarball: 'a.tgz', tag: 'next', provenance: true, dryRun: false })).toEqual([
      'publish',
      'a.tgz',
      '--access',
      'public',
      '--tag',
      'next',
      '--provenance',
    ]);
    expect(publishArguments({ tarball: 'a.tgz', tag: 'latest', provenance: false, dryRun: true })).toEqual([
      'publish',
      'a.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance=false',
      '--dry-run',
    ]);
  });

  it('keeps a tarball path with spaces as one argument', () => {
    const args = publishArguments({
      tarball: '/tmp/a b/c.tgz',
      tag: 'next',
      provenance: false,
      dryRun: false,
    });
    expect(args[1]).toBe('/tmp/a b/c.tgz');
  });

  it.each(['', 'Next', '1.0.0', 'next tag', '-next'])('rejects the dist-tag %j', (tag) => {
    expect(() => publishArguments({ tarball: 'a.tgz', tag, provenance: false, dryRun: false })).toThrow(
      /invalid dist-tag/,
    );
  });

  it('rejects a malformed dist-tag', () => {
    expect(() =>
      publishArguments({ tarball: 'a.tgz', tag: '--otp=1', provenance: false, dryRun: false }),
    ).toThrow(/invalid dist-tag/);
  });
});
