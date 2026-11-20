// SPDX-License-Identifier: Apache-2.0

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/** The npm package a bare import specifier names: `zod/v4` → `zod`, `@scope/pkg/x` → `@scope/pkg`. */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every npm package a source file imports or re-exports (static or dynamic), excluding `node:`/`cloudflare:` builtins. */
export function importedPackages(source: string): Set<string> {
  const packages = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const name = packageOfSpecifier(match[1] ?? '');
    if (name !== undefined) packages.add(name);
  }
  return packages;
}
