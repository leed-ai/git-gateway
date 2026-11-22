// SPDX-License-Identifier: Apache-2.0
// The first publish of a package, from a laptop: the one publish that cannot use CI, because npm
// attaches a trusted publisher only to a package that already exists. docs/RELEASING.md.
//
//   bun run release:local -- --dry-run   # build, pack and `npm publish --dry-run`; changes nothing
//   bun run release:local                # the same, then a typed confirmation, then publish
//
// Uses the `npm login` session (never a stored token) and publishes without provenance, which only
// a CI identity can sign. Afterwards it creates the git tags and GitHub releases with `gh`, exactly
// as the release workflow does.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { PACKED_PLAN_FILE, parsePackedPlan, releaseTag } from '../packed-plan.ts';
import { pendingChangesets, releaseProblems } from '../release-readiness.ts';
import { REPO_ROOT } from '../repo-root.ts';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dryRun = values['dry-run'];
const CONFIRMATION = 'publish';

/** Runs a command in the repository root with the terminal attached; exits on failure. */
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n\`${command} ${args.join(' ')}\` exited ${result.status ?? 'on a signal'}.`);
    process.exit(1);
  }
}

/** A command's trimmed output, or null when it fails. */
function capture(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const status = capture('git', ['status', '--porcelain']);
const fetched = capture('git', ['fetch', '--quiet', 'origin', 'main']) !== null;
const problems = releaseProblems(
  {
    branch: capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
    dirty: status === null ? null : status.split('\n').filter(Boolean),
    fetched,
    behind: fetched ? Number(capture('git', ['rev-list', '--count', 'HEAD..origin/main']) ?? '0') : 0,
    pendingChangesets: pendingChangesets(REPO_ROOT),
    npmUser: capture('npm', ['whoami']),
    ghAuthenticated: capture('gh', ['auth', 'status']) !== null,
  },
  { publishing: !dryRun },
);
if (problems.length > 0) {
  console.error('\nThis checkout is not ready to publish:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nBuilding the packages.');
run('bunx', ['turbo', 'run', 'build', '--filter=./packages/*']);

const outDir = mkdtempSync(join(tmpdir(), 'git-gateway-release-'));
console.log(`\nPacking every package not yet on npm into ${outDir}.`);
run('bun', ['tooling/repo/src/cli/pack-packages.ts', '--tag', 'latest', '--out', outDir]);
const plan = parsePackedPlan(JSON.parse(readFileSync(join(outDir, PACKED_PLAN_FILE), 'utf8')));
if (plan.packages.length === 0) {
  console.log('\nEvery package is already on npm at its current version. Nothing to publish.');
  process.exit(0);
}

console.log('\nAsking npm what it would publish (npm publish --dry-run).');
run('bun', ['tooling/repo/src/cli/publish-packages.ts', '--from', outDir, '--dry-run']);
console.log(`\nThis release publishes, under "latest":\n`);
for (const pkg of plan.packages) console.log(`  ${releaseTag(pkg)}`);
if (dryRun) {
  console.log('\nDry run: nothing was published, tagged or released.');
  process.exit(0);
}

console.log(
  '\nA published version is permanent: npm allows unpublishing for 72 hours, and a name and version can never be reused.',
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (
  await rl.question(`Type "${CONFIRMATION}" to publish to npm as ${capture('npm', ['whoami'])}: `)
).trim();
rl.close();
if (answer !== CONFIRMATION) {
  console.log('Stopped. Nothing was published.');
  process.exit(1);
}

run('bun', ['tooling/repo/src/cli/publish-packages.ts', '--from', outDir]);
const head = capture('git', ['rev-parse', 'HEAD']);
if (head === null) throw new Error('git rev-parse HEAD failed after publishing');
console.log('\nCreating the git tags and GitHub releases.');
run('bun', ['tooling/repo/src/cli/create-releases.ts', '--from', outDir, '--target', head]);
console.log('\nDone. Next: attach a trusted publisher to each new package (docs/RELEASING.md, step 3).');
