// SPDX-License-Identifier: Apache-2.0
// Creates a git tag and GitHub release for every package in a published plan, named as Changesets
// names them (`@leed-ai/git-gateway-core@0.2.0`), with that version's CHANGELOG section as notes:
//   bun tooling/repo/src/cli/create-releases.ts --from <dir> --target <commit>
// Uses `gh` with GH_TOKEN in CI or the operator's own login locally. A release that already
// exists is skipped, so it is safe to re-run. Imports Node builtins and builtins-only modules (no `bun install`).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { changelogSection, PACKED_PLAN_FILE, parsePackedPlan, releaseTag } from '../packed-plan.ts';
import { REPO_ROOT } from '../repo-root.ts';

const { values } = parseArgs({ options: { from: { type: 'string' }, target: { type: 'string' } } });
if (values.from === undefined || values.target === undefined || !/^[0-9a-f]{40}$/.test(values.target)) {
  console.error('usage: create-releases.ts --from <dir> --target <40-character commit sha>');
  process.exit(2);
}
const target = values.target;
const plan = parsePackedPlan(JSON.parse(readFileSync(join(resolve(values.from), PACKED_PLAN_FILE), 'utf8')));
const notesDir = mkdtempSync(join(tmpdir(), 'git-gateway-notes-'));

for (const pkg of plan.packages) {
  const tag = releaseTag(pkg);
  if (spawnSync('gh', ['release', 'view', tag], { stdio: 'ignore' }).status === 0) {
    console.log(`${tag}: release exists; skipped.`);
    continue;
  }
  const changelog = join(REPO_ROOT, pkg.dir, 'CHANGELOG.md');
  const section = existsSync(changelog)
    ? changelogSection(readFileSync(changelog, 'utf8'), pkg.version)
    : undefined;
  const notes = join(notesDir, `${pkg.tarball}.md`);
  writeFileSync(notes, `${section ?? `Published to npm as ${tag}.`}\n`);
  execFileSync('gh', ['release', 'create', tag, '--target', target, '--title', tag, '--notes-file', notes], {
    stdio: 'inherit',
  });
}
