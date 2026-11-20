// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

/** Any Zod 4 schema, classic or core. */
export type AnySchema = z.core.$ZodType;

/** A schema reached from its parent, with the path segment that leads to it. */
export interface ChildSchema {
  readonly segment: string;
  readonly schema: AnySchema;
  /** Whether the child must carry its own description (false for structural sides such as intersections). */
  readonly requiresDescription: boolean;
}

/** A schema with its wrappers peeled off, plus the extra schemas a pipe leads to. */
export interface UnwrappedSchema {
  /** The schema itself, then each wrapped schema in turn; the last item is the core schema. */
  readonly chain: readonly AnySchema[];
  /** Output sides of pipes met while unwrapping; walked for structure but not for their own description. */
  readonly pipeOutputs: readonly AnySchema[];
}

/** Wrappers whose description may sit on the wrapper or on the schema it wraps. */
const INNER_TYPE_WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'nonoptional',
  'catch',
  'promise',
  'success',
]);

/** Kinds whose catch-all accepts anything, so a description adds nothing. */
const OPEN_CATCHALLS: ReadonlySet<string> = new Set(['never', 'unknown', 'any']);

/** True when the value is a Zod 4 schema (checked structurally, so a second Zod copy still counts). */
export function isSchema(value: unknown): value is AnySchema {
  if (typeof value !== 'object' || value === null || !('_zod' in value)) return false;
  const internals = value._zod;
  return typeof internals === 'object' && internals !== null && 'def' in internals;
}

/** The Zod kind of a schema, e.g. "object", "string", "union". */
export function kindOf(schema: AnySchema): string {
  return schema._zod.def.type;
}

const field = (schema: AnySchema, key: string): unknown => Reflect.get(schema._zod.def, key);

const schemaField = (schema: AnySchema, key: string): AnySchema | undefined => {
  const value = field(schema, key);
  return isSchema(value) ? value : undefined;
};

const schemaList = (schema: AnySchema, key: string): AnySchema[] => {
  const value = field(schema, key);
  return Array.isArray(value) ? value.filter(isSchema) : [];
};

const recordValues = (schema: AnySchema, key: string): [string, unknown][] => {
  const value = field(schema, key);
  return typeof value === 'object' && value !== null ? Object.entries(value) : [];
};

/** The schema a wrapper, lazy or pipe leads to, collecting pipe outputs on the way. */
function innerOf(schema: AnySchema, pipeOutputs: AnySchema[]): AnySchema | undefined {
  const kind = kindOf(schema);
  if (INNER_TYPE_WRAPPERS.has(kind)) return schemaField(schema, 'innerType');
  if (kind === 'lazy') {
    // Zod caches the getter's result on `_zod.innerType`; calling the getter again would build new instances forever.
    const target: unknown = Reflect.get(schema._zod, 'innerType');
    return isSchema(target) ? target : undefined;
  }
  if (kind === 'pipe') {
    const out = schemaField(schema, 'out');
    if (out !== undefined) pipeOutputs.push(out);
    return schemaField(schema, 'in');
  }
  return undefined;
}

/** Peels wrappers (optional, nullable, default, lazy, pipe input, …) down to the core schema. */
export function unwrap(schema: AnySchema): UnwrappedSchema {
  const chain: AnySchema[] = [schema];
  const pipeOutputs: AnySchema[] = [];
  const seen = new Set<AnySchema>([schema]);
  for (let next = innerOf(schema, pipeOutputs); next !== undefined && !seen.has(next);) {
    seen.add(next);
    chain.push(next);
    next = innerOf(next, pipeOutputs);
  }
  return { chain, pipeOutputs };
}

const required = (segment: string, schema: AnySchema): ChildSchema => ({
  segment,
  schema,
  requiresDescription: true,
});

const optionalChild = (segment: string, schema: AnySchema | undefined): ChildSchema[] =>
  schema === undefined ? [] : [required(segment, schema)];

const keyAndValue = (core: AnySchema): ChildSchema[] => [
  ...optionalChild('{key}', schemaField(core, 'keyType')),
  ...optionalChild('{value}', schemaField(core, 'valueType')),
];

/** The direct children of a core (already unwrapped) schema. */
export function childrenOf(core: AnySchema): ChildSchema[] {
  switch (kindOf(core)) {
    case 'object': {
      const fields = recordValues(core, 'shape').flatMap(([key, value]) =>
        isSchema(value) ? [required(`.${key}`, value)] : [],
      );
      const catchall = schemaField(core, 'catchall');
      if (catchall !== undefined && !OPEN_CATCHALLS.has(kindOf(catchall)))
        fields.push(required('.*', catchall));
      return fields;
    }
    case 'array':
      return optionalChild('[]', schemaField(core, 'element'));
    case 'set':
      return optionalChild('<value>', schemaField(core, 'valueType'));
    case 'tuple': {
      const items = schemaList(core, 'items').map((item, index) => required(`[${index}]`, item));
      const rest = schemaField(core, 'rest');
      return rest === undefined ? items : [...items, required('[...]', rest)];
    }
    case 'union':
      return schemaList(core, 'options').map((option, index) => required(`|${index}`, option));
    case 'intersection':
      return (['left', 'right'] as const).flatMap((side) => {
        const schema = schemaField(core, side);
        return schema === undefined ? [] : [{ segment: `&${side}`, schema, requiresDescription: false }];
      });
    case 'record':
    case 'map':
      return keyAndValue(core);
    default:
      return [];
  }
}

/** The member values of an enum, or of a literal with more than one value; empty for anything else. */
export function membersOf(core: AnySchema): string[] {
  const kind = kindOf(core);
  if (kind === 'enum') return recordValues(core, 'entries').map(([, value]) => String(value));
  if (kind === 'literal') {
    const values = field(core, 'values');
    return Array.isArray(values) && values.length > 1 ? values.map(String) : [];
  }
  return [];
}
