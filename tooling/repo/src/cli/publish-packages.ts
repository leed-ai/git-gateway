// SPDX-License-Identifier: Apache-2.0
// Publishes every public package whose version is not on npm yet:
//   bun tooling/repo/src/cli/publish-packages.ts --tag <latest|next> [--dry-run]
// Packs with `bun pm pack` (which resolves workspace: ranges) and publishes the tarball with npm,
// adding --provenance inside GitHub Actions. Without NPM_TOKEN it publishes nothing.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { planPublish, publishArguments } from '../publish-plan.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { listWorkspacePackages } from '../workspace.ts';

const { values } = parseArgs({
  options: { tag: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
const tag = values.tag;
const dryRun = values['dry-run'];
if (tag === undefined) {
  console.error('usage: publish-packages.ts --tag <dist-tag> [--dry-run]');
  process.exit(2);
}
if (!dryRun && (process.env['NPM_TOKEN'] || process.env['NODE_AUTH_TOKEN'] || '') === '') {
  console.log('NPM_TOKEN is not set: nothing is published.');
  process.exit(0);
}

const isPublished = (name: string, version: string): boolean =>
  spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' }).stdout.trim() === version;

const targets = planPublish(listWorkspacePackages(REPO_ROOT), isPublished);
const provenance = process.env['GITHUB_ACTIONS'] === 'true';
for (const target of targets) {
  const outDir = mkdtempSync(join(tmpdir(), 'git-gateway-pack-'));
  execFileSync('bun', ['pm', 'pack', '--destination', outDir, '--quiet'], {
    cwd: join(REPO_ROOT, target.dir),
    stdio: 'inherit',
  });
  const tarball = readdirSync(outDir).find((file) => file.endsWith('.tgz'));
  if (tarball === undefined) throw new Error(`${target.name}: bun pm pack produced no tarball`);
  execFileSync('npm', publishArguments({ tarball: join(outDir, tarball), tag, provenance, dryRun }), {
    stdio: 'inherit',
  });
  // changesets/action reads these lines to create git tags and GitHub releases.
  if (!dryRun) console.log(`New tag: ${target.name}@${target.version}`);
}
console.log(
  targets.length === 0
    ? 'Every public package is already published.'
    : `Published ${targets.length} package(s).`,
);
