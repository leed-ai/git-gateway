// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { importedPackages } from './source-imports.ts';

const SHIPPED_SOURCE = 'src/**/*.{ts,mts,cts,js,mjs,cjs}';
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;

/** The npm packages imported by a package's shipped source under `src/`, test files excluded. */
export function shippedSourceImports(packageDir: string): Set<string> {
  const packages = new Set<string>();
  for (const file of globSync(SHIPPED_SOURCE, { cwd: packageDir })) {
    if (TEST_FILE.test(file)) continue;
    for (const name of importedPackages(readFileSync(join(packageDir, file), 'utf8'))) packages.add(name);
  }
  return packages;
}
