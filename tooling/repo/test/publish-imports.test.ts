// SPDX-License-Identifier: Apache-2.0
// The publish job holds the npm OIDC credential and runs without `bun install`, so the scripts it
// and the release job run must import nothing but Node builtins, directly or through local modules.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { REPO_ROOT } from '../src/repo-root.ts';

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/** Every non-relative specifier a file imports, following relative imports transitively. */
function externalImports(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(file)) return found;
  seen.add(file);
  for (const [, specifier = ''] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    if (specifier.startsWith('.')) {
      for (const inner of externalImports(resolve(dirname(file), specifier), seen)) found.add(inner);
    } else found.add(specifier);
  }
  return found;
}

describe('scripts that run without bun install', () => {
  it.each(['publish-packages.ts', 'create-releases.ts', 'check-release-ready.ts'])(
    '%s imports Node builtins only',
    (script) => {
      const imports = [...externalImports(join(REPO_ROOT, 'tooling/repo/src/cli', script))];
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
    },
  );
});
