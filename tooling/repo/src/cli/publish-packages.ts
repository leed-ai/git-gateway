// SPDX-License-Identifier: Apache-2.0
// Publishes the tarballs pack-packages.ts wrote, in the plan's order:
//   bun tooling/repo/src/cli/publish-packages.ts --from <dir> [--dry-run]
//
// No token is read or checked. In GitHub Actions npm authenticates through trusted publishing
// (OIDC) and attaches provenance; on a laptop it uses the `npm login` session and publishes
// without provenance, which only a CI identity can sign. A version already on the registry is
// skipped, so re-running after a partial failure publishes only what is missing.
//
// Runs in the job that holds `id-token: write`, without `bun install`: it imports Node builtins
// and builtins-only modules (tooling/repo/test/publish-imports.test.ts holds that).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PACKED_PLAN_FILE, parsePackedPlan, publishArguments, releaseTag } from '../packed-plan.ts';

const { values } = parseArgs({
  options: { from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
if (values.from === undefined) {
  console.error('usage: publish-packages.ts --from <dir> [--dry-run]');
  process.exit(2);
}
const dir = resolve(values.from);
const dryRun = values['dry-run'];
const plan = parsePackedPlan(JSON.parse(readFileSync(join(dir, PACKED_PLAN_FILE), 'utf8')));
const provenance = process.env['GITHUB_ACTIONS'] === 'true' && !dryRun;

const isPublished = (name: string, version: string): boolean =>
  spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' }).stdout.trim() === version;

let published = 0;
for (const pkg of plan.packages) {
  if (!dryRun && isPublished(pkg.name, pkg.version)) {
    console.log(`${releaseTag(pkg)} is already on npm; skipped.`);
    continue;
  }
  const tarball = join(dir, pkg.tarball);
  execFileSync('npm', publishArguments({ tarball, tag: plan.tag, provenance, dryRun }), {
    stdio: 'inherit',
  });
  published += 1;
}
console.log(
  dryRun
    ? `Dry run: ${published} package(s) would be published under "${plan.tag}". Nothing was published.`
    : `Published ${published} package(s) under "${plan.tag}".`,
);
