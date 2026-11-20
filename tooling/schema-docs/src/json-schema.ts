// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { SchemaEntry } from './check.ts';
import { readMetadata } from './metadata.ts';
import { unwrap, type AnySchema } from './zod-node.ts';

/** A JSON Schema (draft 2020-12) document holding every named schema under `$defs`. */
export interface JsonSchemaDocument {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly $defs: Readonly<Record<string, unknown>>;
}

/** Which side of a transforming schema to describe: what it accepts, or what it produces. */
export type JsonSchemaSide = 'input' | 'output';

/** The id of the outermost named schema in a wrapper chain, if any. */
function idOf(schema: AnySchema): string | undefined {
  for (const node of unwrap(schema).chain) {
    const id = readMetadata(node)?.id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** A copy of a definition without the registry `id` some Zod 4 releases add; `id` is not a JSON Schema keyword. */
function withoutRegistryId(definition: unknown, id: string): unknown {
  if (typeof definition !== 'object' || definition === null || Reflect.get(definition, 'id') !== id) {
    return definition;
  }
  return Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'id'));
}

/**
 * The definitions one named schema contributes: its nested named schemas plus itself. Zod emits
 * a named root either as a `$ref` into `$defs` or inline beside `$defs`, depending on version.
 */
function definitionsOf(schema: AnySchema, id: string, io: JsonSchemaSide): Map<string, unknown> {
  // A node JSON Schema cannot express (transform output, date, bigint, custom, instanceof) becomes an
  // open schema that still carries the node's own metadata; description coverage is the walker's job.
  const generated: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }),
  };
  const nested = generated['$defs'];
  delete generated['$schema'];
  delete generated['$defs'];
  const nestedEntries = typeof nested === 'object' && nested !== null ? Object.entries(nested) : [];
  const definitions = new Map<string, unknown>(
    nestedEntries.map(([defId, definition]) => [defId, withoutRegistryId(definition, defId)]),
  );
  const isReference = Object.keys(generated).length === 1 && generated['$ref'] === `#/$defs/${id}`;
  if (!isReference) definitions.set(id, withoutRegistryId(generated, id));
  return definitions;
}

/**
 * Generates one JSON Schema document from the named schemas among the entries, with each
 * named schema (and every named schema nested in it) under `$defs`, keys sorted. Unnamed
 * entries are skipped; the documentation check reports them.
 */
export function buildJsonSchemaDocument(
  entries: readonly SchemaEntry[],
  io: JsonSchemaSide = 'output',
): JsonSchemaDocument {
  const defs = new Map<string, unknown>();
  for (const { name, schema } of entries) {
    const id = idOf(schema);
    if (id === undefined) continue;
    for (const [defId, definition] of definitionsOf(schema, id, io)) {
      const existing = defs.get(defId);
      if (existing !== undefined && !isDeepStrictEqual(existing, definition)) {
        throw new Error(`${name}: schema id "${defId}" generates two different JSON Schemas`);
      }
      defs.set(defId, definition);
    }
  }
  const sorted = Object.fromEntries([...defs.keys()].toSorted().map((id) => [id, defs.get(id)]));
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: sorted };
}
