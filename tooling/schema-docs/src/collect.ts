// SPDX-License-Identifier: Apache-2.0
import type { SchemaEntry } from './check.ts';
import { isSchema } from './zod-node.ts';

const LEADING_RELATIVE = /^(?:\.\.?\/)+/;

/**
 * Finds every Zod schema exported by a set of modules, such as the result of
 * `import.meta.glob('../src/**\/*.ts', { eager: true })`. Entries are named
 * `<module path>#<export name>`, sorted, and a schema exported twice is listed once.
 */
export function collectExportedSchemas(modules: Readonly<Record<string, unknown>>): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  const seen = new Set<unknown>();
  for (const modulePath of Object.keys(modules).toSorted()) {
    const namespace = modules[modulePath];
    if (typeof namespace !== 'object' || namespace === null) continue;
    const exported = Object.entries(namespace).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [exportName, value] of exported) {
      if (!isSchema(value) || seen.has(value)) continue;
      seen.add(value);
      entries.push({ name: `${modulePath.replace(LEADING_RELATIVE, '')}#${exportName}`, schema: value });
    }
  }
  return entries;
}
