// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { WorkflowFile } from './workflow-policy.ts';

/** Every workflow and composite action under `.github/`, parsed. */
export function readWorkflowFiles(rootDir: string): WorkflowFile[] {
  const paths = [
    ...globSync('.github/workflows/*.{yml,yaml}', { cwd: rootDir }),
    ...globSync('.github/actions/*/action.{yml,yaml}', { cwd: rootDir }),
  ].toSorted();
  return paths.map((path) => ({
    path,
    document: parse(readFileSync(join(rootDir, path), 'utf8')) as unknown,
  }));
}
