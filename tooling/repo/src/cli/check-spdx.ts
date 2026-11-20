// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../repo-root.ts';
import { hasSpdxHeader, needsSpdxHeader, SPDX_HEADER } from '../spdx.ts';
import { trackedFiles } from '../tracked-files.ts';

const files = trackedFiles(REPO_ROOT).filter(
  (path) => needsSpdxHeader(path) && existsSync(join(REPO_ROOT, path)),
);
const missing = files.filter((path) => !hasSpdxHeader(readFileSync(join(REPO_ROOT, path), 'utf8')));
if (missing.length > 0) {
  for (const path of missing) console.error(`${path}: first line must be "${SPDX_HEADER}"`);
  process.exit(1);
}
console.log(`SPDX headers: ${files.length} source files pass.`);
