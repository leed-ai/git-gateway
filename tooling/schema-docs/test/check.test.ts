// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { findDocumentationIssues, formatIssues } from '../src/check.ts';
import { duplicateIdsAllowed } from './duplicate-ids.ts';

const named = <T extends z.ZodType>(schema: T, id: string, examples: unknown[]): T =>
  schema.meta({ id, title: id, description: `The ${id} schema.`, examples });

const issuesOf = (schema: z.ZodType, name = 'm#S'): string[] =>
  formatIssues(findDocumentationIssues([{ name, schema }]));

describe('findDocumentationIssues', () => {
  it('accepts a fully documented object', () => {
    const schema = named(
      z.object({
        sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .describe('40-character lowercase hex SHA-1.'),
        limit: z.number().int().min(1).default(20).describe('Commits per page, 1 or more; 20 when absent.'),
        note: z.string().describe('Free text; absent when none was given.').optional(),
      }),
      'check.Documented',
      [{ sha: 'a'.repeat(40), limit: 5 }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('reports an exported schema that is not named', () => {
    expect(issuesOf(z.string().describe('A string.'))).toEqual([
      'm#S: exported schema is not named: add .meta({ id, title, description, examples })',
    ]);
  });

  it.skipIf(duplicateIdsAllowed)('relies on Zod to refuse a second schema with the same id', () => {
    named(z.string(), 'check.RefusedId', ['a']);
    expect(() => named(z.number(), 'check.RefusedId', [1])).toThrow(/already exists/);
  });

  it('reports a named schema missing its title, description and examples', () => {
    expect(issuesOf(z.string().meta({ id: 'check.Bare' }))).toEqual([
      'm#S: missing description: add .describe() or .meta({ description })',
      'm#S: named schema is missing a title',
      'm#S: named schema is missing a description',
      'm#S: named schema is missing examples',
    ]);
  });

  it('reports an example the schema rejects', () => {
    const [issue] = issuesOf(named(z.number().int(), 'check.BadExample', [1, 'two']));
    expect(issue).toMatch(/^m#S: example 1 does not match the schema: /);
  });

  it.skipIf(!duplicateIdsAllowed)('reports one id used by two schemas', () => {
    const first = named(z.string(), 'check.SameId', ['a']);
    const second = named(z.number(), 'check.SameId', [1]);
    const issues = formatIssues(
      findDocumentationIssues([
        { name: 'm#First', schema: first },
        { name: 'm#Second', schema: second },
      ]),
    );
    expect(issues).toEqual(['m#Second: schema id "check.SameId" is used by more than one schema']);
  });

  it('reports each undescribed field with its path', () => {
    const schema = named(
      z.object({
        described: z.string().describe('Has one.'),
        bare: z.object({ deep: z.number() }).describe('Nested.'),
      }),
      'check.Fields',
      [{ described: 'x', bare: { deep: 1 } }],
    );
    expect(issuesOf(schema)).toEqual([
      `m#S.bare.deep: missing description: add .describe() or .meta({ description })`,
    ]);
  });

  it('accepts a description on either side of a wrapper', () => {
    const schema = named(
      z.object({
        outer: z.string().optional().describe('On the wrapper.'),
        inner: z.string().describe('On the inner schema.').nullable(),
        piped: z
          .string()
          .describe('Input side of a pipe.')
          .transform((value) => value.length),
      }),
      'check.Wrappers',
      [{ inner: null, piped: 'abc' }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('requires a description on every union branch', () => {
    const schema = named(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a').describe('Branch a.') }).describe('The a branch.'),
        z.object({ kind: z.literal('b').describe('Branch b.') }),
      ]),
      'check.Union',
      [{ kind: 'a' }],
    );
    expect(issuesOf(schema)).toEqual([
      `m#S|1: missing description: add .describe() or .meta({ description })`,
    ]);
  });

  it('requires a description for every enum member', () => {
    const bare = named(z.enum(['read', 'write']), 'check.EnumBare', ['read']);
    expect(issuesOf(bare)).toEqual([
      'm#S: enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    ]);
    const partial = z.enum(['read', 'write']).meta({
      id: 'check.EnumPartial',
      title: 'EnumPartial',
      description: 'Access level.',
      examples: ['read'],
      enumDescriptions: { read: 'Fetch only.', admin: 'Not a member.' },
    });
    expect(issuesOf(partial)).toEqual([
      'm#S: enum member "write" has no description',
      'm#S: enumDescriptions names "admin", which is not a member',
    ]);
  });

  it('treats a multi-value literal as an enum', () => {
    const schema = named(z.literal(['a', 'b']), 'check.MultiLiteral', ['a']);
    expect(issuesOf(schema)).toHaveLength(1);
  });

  it('walks arrays, tuples, records, maps and sets', () => {
    const schema = named(
      z.object({
        list: z.array(z.string()).describe('A list.'),
        pair: z.tuple([z.string().describe('First.'), z.number()]).describe('A pair.'),
        byName: z.record(z.string().describe('A name.'), z.number()).describe('By name.'),
        lookup: z.map(z.string(), z.number().describe('Value.')).describe('A map.'),
        tags: z.set(z.string()).describe('Tags.'),
      }),
      'check.Collections',
      [{ list: [], pair: ['a', 1], byName: {}, lookup: new Map(), tags: new Set() }],
    );
    expect(issuesOf(schema).map((line) => line.split(':')[0])).toEqual([
      'm#S.list[]',
      'm#S.pair[1]',
      'm#S.byName{value}',
      'm#S.lookup{key}',
      'm#S.tags<value>',
    ]);
  });

  it('terminates on recursive schemas', () => {
    interface Tree {
      readonly children: Tree[];
    }
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ children: z.array(Tree).describe('Child nodes.') }).describe('A node.'),
    );
    const schema = named(z.object({ root: Tree.describe('The root.') }), 'check.Recursive', [
      { root: { children: [] } },
    ]);
    expect(issuesOf(schema)).toEqual([]);
  });

  it('only requires structural descriptions inside intersection sides', () => {
    const schema = named(
      z.intersection(z.object({ a: z.string().describe('A.') }), z.object({ b: z.number() })),
      'check.Intersection',
      [{ a: 'x', b: 1 }],
    );
    expect(issuesOf(schema)).toEqual([
      `m#S&right.b: missing description: add .describe() or .meta({ description })`,
    ]);
  });

  it('treats a whitespace-only description as missing', () => {
    const schema = named(z.object({ a: z.string().describe('   ') }), 'check.Blank', [{ a: 'x' }]);
    expect(issuesOf(schema)).toEqual([
      `m#S.a: missing description: add .describe() or .meta({ description })`,
    ]);
  });

  it('reports an empty or non-array examples list', () => {
    const empty = z.string().meta({ id: 'check.NoExamples', title: 'T', description: 'D.', examples: [] });
    expect(issuesOf(empty)).toEqual(['m#S: named schema is missing examples']);
    const scalar = z
      .string()
      .meta({ id: 'check.ScalarExamples', title: 'T', description: 'D.', examples: 'x' });
    expect(issuesOf(scalar)).toEqual(['m#S: named schema is missing examples']);
  });

  it('checks a nested named schema once, and not as a duplicate id when reused', () => {
    const Inner = z
      .object({ n: z.number().describe('A number.') })
      .meta({ id: 'check.ReusedInner', title: 'Inner', description: 'Inner.' });
    const schema = named(
      z.object({ first: Inner, second: Inner.optional().describe('Again, optional.') }),
      'check.ReusedOuter',
      [{ first: { n: 1 } }],
    );
    expect(issuesOf(schema)).toEqual(['m#S.first: named schema is missing examples']);
  });

  it('validates the examples of a nested named schema', () => {
    const Inner = named(z.number().int().describe('Whole.'), 'check.NestedBadExample', [1.5]);
    const schema = named(z.object({ inner: Inner }), 'check.NestedBadOuter', [{ inner: 1 }]);
    const issues = issuesOf(schema);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^m#S\.inner: example 0 does not match the schema: /);
  });

  it('reads enum descriptions from a wrapper around the enum', () => {
    const schema = named(
      z.object({
        mode: z
          .enum(['a', 'b'])
          .optional()
          .meta({ description: 'Mode; absent means a.', enumDescriptions: { a: 'First.', b: 'Second.' } }),
      }),
      'check.WrappedEnum',
      [{}],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('requires descriptions on enum keys of a record', () => {
    const schema = named(
      z.record(z.enum(['x', 'y']).describe('Axis.'), z.number().describe('Value.')).describe('By axis.'),
      'check.EnumKeys',
      [{ x: 1, y: 2 }],
    );
    expect(issuesOf(schema)).toEqual([
      'm#S{key}: enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    ]);
  });

  it('walks the fields of a pipe output without requiring a description on the output itself', () => {
    const schema = named(
      z
        .string()
        .describe('JSON text.')
        .pipe(z.transform((text: string): unknown => JSON.parse(text)))
        .pipe(z.object({ id: z.string() })),
      'check.PipeOutput',
      ['{"id":"a"}'],
    );
    expect(issuesOf(schema).map((line) => line.split(':')[0])).toEqual(['m#S>out.id']);
  });

  it('requires a description on a typed catch-all', () => {
    const schema = named(z.object({ a: z.string().describe('A.') }).catchall(z.number()), 'check.Catchall', [
      { a: 'x', b: 1 },
    ]);
    expect(issuesOf(schema)).toEqual([
      `m#S.*: missing description: add .describe() or .meta({ description })`,
    ]);
  });

  it('reports each exported entry under its own name', () => {
    const issues = formatIssues(
      findDocumentationIssues([
        { name: 'a.ts#One', schema: z.string() },
        { name: 'b.ts#Two', schema: z.number().describe('Described but unnamed.') },
      ]),
    );
    expect(issues).toEqual([
      'a.ts#One: exported schema is not named: add .meta({ id, title, description, examples })',
      'a.ts#One: missing description: add .describe() or .meta({ description })',
      'b.ts#Two: exported schema is not named: add .meta({ id, title, description, examples })',
    ]);
  });
});
