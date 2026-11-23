// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import { parse } from 'yaml';

import { isPublic } from '../src/manifest.ts';
import { PEER_POLICY } from '../src/peer-policy.ts';
import { REPO_ROOT } from '../src/repo-root.ts';
import { readWorkflowFiles } from '../src/workflow-files.ts';
import { listWorkspacePackages } from '../src/workspace.ts';

/** The packages the epic plan fixes, published as `@leed-ai/git-gateway-<pkg>` from `packages/<pkg>`. */
const PUBLISHED = [
  'auth-jwt',
  'backend-artifacts',
  'backend-gitlab',
  'contract',
  'core',
  'testkit',
  'worker',
];

const packages = listWorkspacePackages(REPO_ROOT);
const publicPackages = packages.filter(({ dir, manifest }) => dir !== '.' && isPublic(manifest));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordAt = (value: unknown, ...keys: string[]): Record<string, unknown> => {
  let current: unknown = value;
  for (const key of keys) current = isRecord(current) ? current[key] : undefined;
  return isRecord(current) ? current : {};
};

describe('published packages', () => {
  it('are exactly the seven @leed-ai/git-gateway-<pkg> packages, each in packages/<pkg>', () => {
    expect(publicPackages.map(({ dir, manifest }) => [dir, manifest.name])).toEqual(
      PUBLISHED.map((pkg) => [`packages/${pkg}`, `@leed-ai/git-gateway-${pkg}`]),
    );
  });

  it('keeps the root, tooling and examples private', () => {
    const others = packages.filter(({ dir }) => !dir.startsWith('packages/'));
    expect(others.length).toBeGreaterThanOrEqual(4);
    for (const { dir, manifest } of others) expect([dir, manifest.private]).toEqual([dir, true]);
  });

  it.each(PUBLISHED)('%s is Apache-2.0, versioned, ships a LICENSE and publishes publicly', (pkg) => {
    const dir = join(REPO_ROOT, 'packages', pkg);
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(recordAt(manifest)['license']).toBe('Apache-2.0');
    expect(recordAt(manifest)['version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(recordAt(manifest, 'publishConfig')).toMatchObject({ access: 'public', provenance: true });
    expect(existsSync(join(dir, 'LICENSE'))).toBe(true);
  });

  // npm trusted publishing and provenance both require repository.url to name this repository exactly.
  it.each(PUBLISHED)('%s names this repository, which trusted publishing matches exactly', (pkg) => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
    );
    expect(recordAt(manifest, 'repository')).toEqual({
      type: 'git',
      url: 'git+https://github.com/leed-ai/git-gateway.git',
      directory: `packages/${pkg}`,
    });
  });

  it('declare only policy peers, by their policy range, and never as runtime dependencies', () => {
    for (const { dir, manifest } of publicPackages) {
      const policyPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
        ([peer]) => peer in PEER_POLICY,
      );
      expect([dir, policyPeers]).toEqual([dir, policyPeers.map(([peer]) => [peer, PEER_POLICY[peer]])]);
      for (const peer of Object.keys(PEER_POLICY)) {
        expect([dir, manifest.dependencies?.[peer]]).toEqual([dir, undefined]);
      }
    }
  });
});

describe('turbo task graph', () => {
  const turbo: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8'));
  const task = (name: string): Record<string, unknown> => recordAt(turbo, 'tasks', name);

  it('builds upstream packages before any test task', () => {
    for (const name of ['test', 'test:conformance', 'test:contract']) {
      expect(task(name)['dependsOn']).toContain('^build');
    }
  });

  it('never caches the real-git and live-backend legs', () => {
    expect(task('test:conformance')['cache']).toBe(false);
    expect(task('test:contract')['cache']).toBe(false);
  });

  it('passes contract secrets through without hashing them into the cache key', () => {
    const hashed = JSON.stringify(task('test:contract')['env'] ?? []);
    expect(hashed).not.toMatch(/TOKEN|GITLAB|CLOUDFLARE|ARTIFACTS/);
    expect(task('test:contract')['passThroughEnv']).toEqual(
      expect.arrayContaining(['GITLAB_*', 'CLOUDFLARE_*', 'ARTIFACTS_*']),
    );
  });
});

describe('repository tools test cache', () => {
  const local: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'tooling/repo/turbo.json'), 'utf8'));
  const inputs = recordAt(local, 'tasks', 'test')['inputs'];

  it('hashes every repository file these tests read, so turbo never serves a stale pass', () => {
    expect(recordAt(local)['extends']).toEqual(['//']);
    expect(inputs).toEqual(
      expect.arrayContaining([
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/.github/**',
        '$TURBO_ROOT$/turbo.json',
        '$TURBO_ROOT$/package.json',
        '$TURBO_ROOT$/packages/*/package.json',
        '$TURBO_ROOT$/packages/*/LICENSE',
        '$TURBO_ROOT$/examples/*/package.json',
        '$TURBO_ROOT$/tooling/*/package.json',
      ]),
    );
  });
});

describe('test workflow sharding', () => {
  const source = readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8');
  const document: unknown = parse(source);
  const shards = recordAt(document, 'jobs', 'unit', 'strategy', 'matrix')['shard'];

  it('lists the shards as 1..n on one line', () => {
    expect(Array.isArray(shards)).toBe(true);
    const list = Array.isArray(shards) ? shards : [];
    expect(list.length).toBeGreaterThan(0);
    expect(list).toEqual(list.map((_, index) => index + 1));
    expect(source.split('\n').filter((line) => /^\s*shard:/.test(line))).toHaveLength(1);
  });

  it('derives the shard total from the matrix size, never a hard-coded count', () => {
    expect(source).not.toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/\d/);
    expect(source).toContain('--shard=${{ matrix.shard }}/${{ strategy.job-total }}');
  });

  it('runs only affected packages on a pull request', () => {
    expect(source).toContain("github.event_name == 'pull_request' && '--affected'");
  });

  it('always runs the repository tool tests on a pull request, which --affected cannot select', () => {
    const steps = recordAt(document, 'jobs', 'unit')['steps'];
    const step = (Array.isArray(steps) ? steps : []).find(
      (candidate) => isRecord(candidate) && candidate['name'] === 'Repository tool tests',
    );
    expect(step).toMatchObject({ if: "github.event_name == 'pull_request'" });
    expect(String(isRecord(step) ? step['run'] : '')).toContain(
      'turbo run test --filter=@leed-ai/git-gateway-repo-tools',
    );
  });
});

describe('fork safety across every workflow', () => {
  const files = readWorkflowFiles(REPO_ROOT);

  it('gives no fork-reachable workflow a workflow-level secret', () => {
    for (const { path, document } of files) {
      expect([path, JSON.stringify(recordAt(document, 'env'))]).not.toEqual([
        path,
        expect.stringContaining('secrets.'),
      ]);
    }
  });

  it('never hands a reusable workflow inherited secrets', () => {
    for (const { path, document } of files) {
      for (const job of Object.values(recordAt(document, 'jobs'))) {
        expect([path, recordAt({ job }, 'job')['secrets']]).not.toEqual([path, 'inherit']);
      }
    }
  });
});
