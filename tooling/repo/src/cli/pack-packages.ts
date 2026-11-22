// SPDX-License-Identifier: Apache-2.0
// Packs every public package whose version is not on npm yet, ready for the publish step:
//   bun tooling/repo/src/cli/pack-packages.ts --tag <latest|next> --out <dir>
// Writes one tarball per package (`bun pm pack`, which resolves workspace: ranges) and plan.json,
// in publish order. Build the packages first. Publishing is publish-packages.ts, which reads
// only this directory and so runs without `bun install`.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { assertDistTag, PACKED_PLAN_FILE, type PackedPlan } from '../packed-plan.ts';
import { planPublish } from '../publish-plan.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { listWorkspacePackages } from '../workspace.ts';

const { values } = parseArgs({ options: { tag: { type: 'string' }, out: { type: 'string' } } });
if (values.tag === undefined || values.out === undefined) {
  console.error('usage: pack-packages.ts --tag <dist-tag> --out <dir>');
  process.exit(2);
}
const tag = assertDistTag(values.tag);
const outDir = resolve(values.out);
mkdirSync(outDir, { recursive: true });
if (readdirSync(outDir).length > 0) {
  console.error(`${outDir} is not empty; pack into a fresh directory.`);
  process.exit(1);
}

// A package that has never been published answers E404 here, which reads as "not published".
const isPublished = (name: string, version: string): boolean =>
  spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' }).stdout.trim() === version;

const targets = planPublish(listWorkspacePackages(REPO_ROOT), isPublished);
const packages = targets.map((target) => {
  // Each package packs into its own scratch directory, so the tarball found is this package's.
  const scratch = mkdtempSync(join(tmpdir(), 'git-gateway-pack-'));
  execFileSync('bun', ['pm', 'pack', '--destination', scratch, '--quiet'], {
    cwd: join(REPO_ROOT, target.dir),
    stdio: 'inherit',
  });
  const tarball = readdirSync(scratch).find((file) => file.endsWith('.tgz'));
  if (tarball === undefined) throw new Error(`${target.name}: bun pm pack produced no tarball`);
  renameSync(join(scratch, tarball), join(outDir, tarball));
  return { ...target, tarball };
});
const plan: PackedPlan = { tag, packages };
writeFileSync(join(outDir, PACKED_PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);

if (packages.length === 0) console.log('Every public package is already on npm at its current version.');
for (const { name, version } of packages) console.log(`${name}@${version}  (${tag})`);
console.log(`Packed ${packages.length} package(s) into ${outDir}.`);
