// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { hasText, readMetadata, type SchemaMetadata } from './metadata.ts';
import { childrenOf, membersOf, unwrap, type AnySchema } from './zod-node.ts';

/** An exported schema and the name it is reported under (e.g. `src/health.ts#HealthResponse`). */
export interface SchemaEntry {
  readonly name: string;
  readonly schema: AnySchema;
}

/** One documentation gap, located by a path such as `src/health.ts#HealthResponse.status`. */
export interface DocumentationIssue {
  readonly path: string;
  readonly problem: string;
}

interface WalkState {
  readonly issues: DocumentationIssue[];
  /** Core schemas whose children have been walked; a core is recursed into once. */
  readonly walked: Set<AnySchema>;
  /** Pipe outputs already walked; keyed on the output itself, so pipes sharing an input each get theirs walked. */
  readonly walkedOutputs: Set<AnySchema>;
  readonly named: Set<AnySchema>;
  readonly ids: Map<string, AnySchema>;
}

const MISSING_DESCRIPTION = 'missing description: add .describe() or .meta({ description })';
const NOT_NAMED = 'exported schema is not named: add .meta({ id, title, description, examples })';

function checkNamed(schema: AnySchema, meta: SchemaMetadata, path: string, state: WalkState): void {
  if (state.named.has(schema)) return;
  state.named.add(schema);
  const report = (problem: string): void => {
    state.issues.push({ path, problem });
  };
  const id = meta.id;
  if (!hasText(id)) report('named schema id must be a non-empty string');
  else {
    const holder = state.ids.get(id);
    if (holder !== undefined && holder !== schema)
      report(`schema id "${id}" is used by more than one schema`);
    state.ids.set(id, schema);
  }
  if (!hasText(meta.title)) report('named schema is missing a title');
  if (!hasText(meta.description)) report('named schema is missing a description');
  if (!Array.isArray(meta.examples) || meta.examples.length === 0) {
    report('named schema is missing examples');
    return;
  }
  meta.examples.forEach((example: unknown, index: number) => {
    const result = z.safeParse(schema, example);
    if (!result.success) {
      report(`example ${index} does not match the schema: ${z.prettifyError(result.error)}`);
    }
  });
}

function checkMembers(
  core: AnySchema,
  metas: readonly (SchemaMetadata | undefined)[],
  path: string,
  state: WalkState,
): void {
  const members = membersOf(core);
  if (members.length === 0) return;
  const holder = metas.find((meta) => meta?.enumDescriptions !== undefined)?.enumDescriptions;
  if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) {
    state.issues.push({
      path,
      problem: 'enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    });
    return;
  }
  for (const member of members) {
    if (!hasText(Reflect.get(holder, member))) {
      state.issues.push({ path, problem: `enum member "${member}" has no description` });
    }
  }
  for (const key of Object.keys(holder)) {
    if (!members.includes(key)) {
      state.issues.push({ path, problem: `enumDescriptions names "${key}", which is not a member` });
    }
  }
}

function walk(schema: AnySchema, path: string, requiresDescription: boolean, state: WalkState): void {
  const { chain, pipeOutputs } = unwrap(schema);
  const metas = chain.map(readMetadata);
  if (requiresDescription && !metas.some((meta) => hasText(meta?.description))) {
    state.issues.push({ path, problem: MISSING_DESCRIPTION });
  }
  chain.forEach((node, index) => {
    const meta = metas[index];
    if (meta?.id !== undefined) checkNamed(node, meta, path, state);
  });
  const core = chain.at(-1) ?? schema;
  // Enum descriptions may sit on any wrapper of this use, so members are checked on every use.
  checkMembers(core, metas, path, state);
  if (!state.walked.has(core)) {
    state.walked.add(core);
    for (const child of childrenOf(core)) {
      walk(child.schema, `${path}${child.segment}`, child.requiresDescription, state);
    }
  }
  pipeOutputs.forEach((output, index) => {
    if (state.walkedOutputs.has(output)) return;
    state.walkedOutputs.add(output);
    walk(output, `${path}>out${index === 0 ? '' : index}`, false, state);
  });
}

/**
 * Walks every entry and every schema nested inside it, and returns each documentation gap:
 * an exported schema that is not named, a named schema without id/title/description/examples
 * (or with examples it rejects), any node without a description, and enum members without one.
 */
export function findDocumentationIssues(entries: readonly SchemaEntry[]): DocumentationIssue[] {
  const state: WalkState = {
    issues: [],
    walked: new Set(),
    walkedOutputs: new Set(),
    named: new Set(),
    ids: new Map(),
  };
  for (const { name, schema } of entries) {
    if (!unwrap(schema).chain.some((node) => readMetadata(node)?.id !== undefined)) {
      state.issues.push({ path: name, problem: NOT_NAMED });
    }
    walk(schema, name, true, state);
  }
  return state.issues;
}

/** One line per issue, for readable test failures. */
export function formatIssues(issues: readonly DocumentationIssue[]): string[] {
  return issues.map(({ path, problem }) => `${path}: ${problem}`);
}
