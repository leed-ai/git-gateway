// SPDX-License-Identifier: Apache-2.0
// Runs a Turbo task, failing when no package defines it: `turbo run` of a task nobody defines
// exits 0 having run nothing, which would let a required CI check pass without a single test.
import { execFileSync } from 'node:child_process';

import { REPO_ROOT } from '../repo-root.ts';

const [task, ...rest] = process.argv.slice(2);
if (task === undefined) {
  console.error('usage: run-required-task.ts <turbo-task> [turbo args...]');
  process.exit(2);
}

interface PlannedTask {
  readonly taskId: string;
  readonly task: string;
  readonly command: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPlannedTask = (value: unknown): value is PlannedTask =>
  isRecord(value) &&
  typeof value['taskId'] === 'string' &&
  typeof value['task'] === 'string' &&
  typeof value['command'] === 'string';

const dry: unknown = JSON.parse(
  execFileSync('bunx', ['turbo', 'run', task, '--dry=json', ...rest], { cwd: REPO_ROOT, encoding: 'utf8' }),
);
const planned = isRecord(dry) && Array.isArray(dry['tasks']) ? dry['tasks'].filter(isPlannedTask) : [];
const defined = planned.filter((entry) => entry.task === task && entry.command !== '<NONEXISTENT>');
if (defined.length === 0) {
  console.error(`No package defines the "${task}" task: refusing to pass having run nothing.`);
  process.exit(1);
}
console.log(`Running "${task}" in ${defined.map((entry) => entry.taskId).join(', ')}.`);
execFileSync('bunx', ['turbo', 'run', task, ...rest], { cwd: REPO_ROOT, stdio: 'inherit' });
