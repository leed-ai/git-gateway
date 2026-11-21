// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

// Consumers (the CMS via `bun link`) import each module by its own subpath. Every source module
// must be exported, each export must point at a real source file, and the built paths must mirror it.

const root = join(import.meta.dirname, '..', '..');
const ModuleExport = z.object({ source: z.string(), types: z.string(), default: z.string() }).strict();
const Manifest = z.object({
  exports: z.record(z.string(), z.union([z.string(), ModuleExport])),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
const pkg = Manifest.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));

function sourceModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceModules(path);
    return entry.name.endsWith('.ts') ? [relative(join(root, 'src'), path).replace(/\.ts$/, '')] : [];
  });
}

/** The module exports, without the `./package.json` passthrough. */
const moduleExports = Object.entries(pkg.exports).filter(
  (entry): entry is [string, z.infer<typeof ModuleExport>] => typeof entry[1] !== 'string',
);

describe('package exports', () => {
  it('exposes package.json as-is', () => {
    expect(pkg.exports['./package.json']).toBe('./package.json');
  });

  it('exports every source module under its own subpath', () => {
    const exported = moduleExports.map(([key]) => key.replace(/^\.\//, ''));
    expect(exported.toSorted()).toEqual(sourceModules(join(root, 'src')).toSorted());
  });

  it.each(moduleExports)('%s points at its source and mirrored build files', (key, target) => {
    const module = key.replace(/^\.\//, '');
    expect(target).toEqual({
      source: `./src/${module}.ts`,
      types: `./dist/${module}.d.ts`,
      default: `./dist/${module}.js`,
    });
    expect(existsSync(join(root, target.source))).toBe(true);
  });

  it('has zod ^4 as its only peer and no runtime dependencies', () => {
    expect(pkg.peerDependencies).toEqual({ zod: '^4' });
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
