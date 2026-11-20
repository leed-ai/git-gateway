// SPDX-License-Identifier: Apache-2.0
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PackageManifest, type WorkspacePackage } from './manifest.ts';

/** Reads a package.json and parses it against {@link PackageManifest}; throws on a malformed manifest. */
export function readManifest(path: string): PackageManifest {
  return PackageManifest.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The root package plus every workspace package its `workspaces` globs match, sorted by directory. */
export function listWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const root = readManifest(join(rootDir, 'package.json'));
  const dirs = new Set<string>();
  for (const pattern of root.workspaces ?? []) {
    for (const match of globSync(`${pattern}/package.json`, { cwd: rootDir })) {
      dirs.add(dirname(match).split('\\').join('/'));
    }
  }
  const packages = [...dirs]
    .toSorted()
    .map((dir) => ({ dir, manifest: readManifest(join(rootDir, dir, 'package.json')) }));
  return [{ dir: '.', manifest: root }, ...packages];
}
