// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { findPolicyViolations, type PackageWithImports } from '../src/dependency-policy.ts';
import type { PackageManifest } from '../src/manifest.ts';

const pkg = (manifest: PackageManifest, imports: string[] = [], dir = 'packages/x'): PackageWithImports => ({
  dir,
  manifest,
  sourceImports: new Set(imports),
});

const messages = (...packages: PackageWithImports[]): string[] =>
  findPolicyViolations(packages).map(({ message }) => message);

describe('findPolicyViolations', () => {
  it('accepts peers declared by policy range with a latest devDependency', () => {
    const manifest = {
      peerDependencies: { zod: '^4', hono: '^4', cloudflare: '^5' },
      peerDependenciesMeta: { cloudflare: { optional: true } },
      devDependencies: { zod: '^4.6.7', hono: '^4.13.19', cloudflare: '^5.2.0' },
    };
    expect(messages(pkg(manifest, ['zod', 'hono', 'cloudflare']))).toEqual([]);
  });

  it('rejects a peer listed under dependencies or optionalDependencies', () => {
    expect(
      messages(pkg({ dependencies: { zod: '^4.6.7' } }), pkg({ optionalDependencies: { hono: '^4' } })),
    ).toEqual([
      'zod is listed in dependencies; it must be a peer dependency (^4)',
      'hono is listed in optionalDependencies; it must be a peer dependency (^4)',
    ]);
  });

  it('rejects exact pins in any dependency field', () => {
    const manifest = {
      peerDependencies: { zod: '^4' },
      devDependencies: { zod: '4.6.7', other: '=1.2.3', fine: '~1.2.3' },
    };
    expect(messages(pkg(manifest))).toEqual([
      'devDependencies.zod is exact-pinned to "4.6.7"; use a range',
      'devDependencies.other is exact-pinned to "=1.2.3"; use a range',
    ]);
  });

  it('rejects a peer range other than the policy major range', () => {
    const manifest = {
      peerDependencies: { cloudflare: '^5.2.0' },
      devDependencies: { cloudflare: '^5.2.0' },
    };
    expect(messages(pkg(manifest))).toEqual([
      'peerDependencies.cloudflare is "^5.2.0"; the policy range is "^5"',
    ]);
  });

  it('rejects source that imports a peer the package does not declare', () => {
    expect(messages(pkg({ devDependencies: { hono: '^4.13.19' } }, ['hono']))).toEqual([
      'source imports hono but peerDependencies does not declare it (^4)',
    ]);
  });

  it('does not require the private root to declare peers', () => {
    expect(messages(pkg({ private: true, devDependencies: { zod: '^4.6.7' } }, ['zod'], '.'))).toEqual([]);
  });

  it('requires a declared peer to be installed as a devDependency', () => {
    expect(messages(pkg({ peerDependencies: { zod: '^4' } }, ['zod']))).toEqual([
      'peer zod is not a devDependency, so tests would not install the latest version',
    ]);
  });

  it('rejects peerDependenciesMeta for an undeclared peer', () => {
    expect(messages(pkg({ peerDependenciesMeta: { hono: { optional: true } } }))).toEqual([
      'peerDependenciesMeta names hono, which is not a peer dependency',
    ]);
  });

  it('reports both the exact pin and the policy range for an exact-pinned peer', () => {
    const manifest = { peerDependencies: { zod: '4.6.7' }, devDependencies: { zod: '^4.6.7' } };
    expect(messages(pkg(manifest, ['zod']))).toEqual([
      'peerDependencies.zod is exact-pinned to "4.6.7"; use a range',
      'peerDependencies.zod is "4.6.7"; the policy range is "^4"',
    ]);
  });

  it('still rejects a peer in the root manifest dependencies', () => {
    expect(messages(pkg({ private: true, dependencies: { hono: '^4' } }, [], '.'))).toEqual([
      'hono is listed in dependencies; it must be a peer dependency (^4)',
    ]);
  });

  it('accepts ranges and protocol specs that are not exact pins', () => {
    const manifest = {
      dependencies: { a: '^1.2.3', b: '~1.2.3', c: '>=1 <2', d: 'workspace:*', e: 'link:@leed-ai/x', f: '*' },
    };
    expect(messages(pkg(manifest))).toEqual([]);
  });

  it('ignores imports of packages outside the policy', () => {
    expect(messages(pkg({}, ['fast-check', '@leed-ai/git-gateway-core']))).toEqual([]);
  });

  it('reports every violation in a package, not just the first', () => {
    const manifest = {
      dependencies: { zod: '^4', hono: '4.0.0' },
      peerDependencies: { cloudflare: '^5.0.0' },
    };
    expect(messages(pkg(manifest))).toEqual([
      'dependencies.hono is exact-pinned to "4.0.0"; use a range',
      'zod is listed in dependencies; it must be a peer dependency (^4)',
      'hono is listed in dependencies; it must be a peer dependency (^4)',
      'peerDependencies.cloudflare is "^5.0.0"; the policy range is "^5"',
      'peer cloudflare is not a devDependency, so tests would not install the latest version',
    ]);
  });

  it('locates each violation by package directory', () => {
    expect(findPolicyViolations([pkg({ dependencies: { zod: '^4' } }, [], 'packages/core')])).toEqual([
      { dir: 'packages/core', message: 'zod is listed in dependencies; it must be a peer dependency (^4)' },
    ]);
  });
});
