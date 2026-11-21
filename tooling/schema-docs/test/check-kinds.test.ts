// SPDX-License-Identifier: Apache-2.0
// Zod constructs the bootstrap tests do not otherwise reach. Every API used here exists in zod 4.0,
// so the nightly lowest-peer leg runs this file unchanged.
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { findDocumentationIssues, formatIssues } from '../src/check.ts';

const named = <T extends z.ZodType>(schema: T, id: string, examples: unknown[]): T =>
  schema.meta({ id, title: id, description: `The ${id} schema.`, examples });

const pathsOf = (schema: z.ZodType): string[] =>
  formatIssues(findDocumentationIssues([{ name: 'm#S', schema }])).map((line) => line.split(': ')[0] ?? '');

const issuesOf = (schema: z.ZodType): string[] =>
  formatIssues(findDocumentationIssues([{ name: 'm#S', schema }]));

describe('findDocumentationIssues on other Zod constructs', () => {
  it('requires a description on every discriminated union branch', () => {
    const schema = named(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a').describe('Branch a.') }).describe('The a branch.'),
        z.object({ kind: z.literal('b') }),
      ]),
      'kinds.Discriminated',
      [{ kind: 'a' }],
    );
    expect(pathsOf(schema)).toEqual(['m#S|1', 'm#S|1.kind']);
  });

  it('still requires a description on fields that are refined, branded or transformed', () => {
    const schema = named(
      z.object({
        refined: z.string().refine((value) => value.length > 0),
        branded: z.string().brand<'Ref'>(),
        transformed: z.string().transform((value) => value.length),
      }),
      'kinds.Checked',
      [{ refined: 'x', branded: 'y', transformed: 'z' }],
    );
    expect(pathsOf(schema)).toEqual(['m#S.refined', 'm#S.branded', 'm#S.transformed']);
  });

  it('accepts a description on a refined, branded or transformed field', () => {
    const schema = named(
      z.object({
        refined: z
          .string()
          .refine((value) => value.length > 0)
          .describe('Non-empty text.'),
        branded: z.string().brand<'Ref'>().describe('A ref name.'),
        transformed: z
          .string()
          .describe('Text, read as its length.')
          .transform((value) => value.length),
      }),
      'kinds.CheckedDescribed',
      [{ refined: 'x', branded: 'y', transformed: 'z' }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('accepts a description on any wrapper of a nullish field', () => {
    const schema = named(
      z.object({
        outer: z.string().nullish().describe('Outer.'),
        inner: z.string().describe('Inner.').nullish(),
      }),
      'kinds.Nullish',
      [{}],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('walks readonly arrays and arrays of unions down to their leaves', () => {
    const schema = named(
      z.object({
        list: z
          .array(z.union([z.string().describe('Text.'), z.number()]))
          .readonly()
          .describe('Mixed list.'),
      }),
      'kinds.Nested',
      [{ list: ['a', 1] }],
    );
    expect(pathsOf(schema)).toEqual(['m#S.list[]', 'm#S.list[]|1']);
  });

  it('treats a template literal as a leaf that needs only its own description', () => {
    const schema = named(
      z.object({ ref: z.templateLiteral(['refs/heads/', z.string()]).describe('A branch ref.') }),
      'kinds.Template',
      [{ ref: 'refs/heads/main' }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('reports an enumDescriptions value that is a list rather than a map', () => {
    const schema = named(
      z.object({
        mode: z
          .enum(['a', 'b'])
          .describe('Mode.')
          .meta({ enumDescriptions: ['First.', 'Second.'] }),
      }),
      'kinds.EnumList',
      [{ mode: 'a' }],
    );
    expect(issuesOf(schema)).toEqual([
      'm#S.mode: enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    ]);
  });

  it('requires descriptions again on an enum derived with exclude, which is a new schema', () => {
    const Mode = z.enum(['a', 'b', 'c']).meta({ enumDescriptions: { a: 'A.', b: 'B.', c: 'C.' } });
    const schema = named(
      z.object({ mode: Mode.exclude(['c']).describe('Mode without c.') }),
      'kinds.Excluded',
      [{ mode: 'a' }],
    );
    expect(issuesOf(schema)).toEqual([
      'm#S.mode: enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    ]);
  });

  it('reports an empty enum description as missing', () => {
    const schema = named(
      z.object({
        mode: z
          .enum(['a', 'b'])
          .describe('Mode.')
          .meta({ enumDescriptions: { a: 'A.', b: ' ' } }),
      }),
      'kinds.EnumBlank',
      [{ mode: 'a' }],
    );
    expect(issuesOf(schema)).toEqual(['m#S.mode: enum member "b" has no description']);
  });

  it('reads a description given through .meta() on a field', () => {
    const schema = named(
      z.object({ a: z.string().meta({ description: 'Through meta.' }) }),
      'kinds.MetaDescription',
      [{ a: 'x' }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('lets a field re-describe a named schema without counting it as a second id', () => {
    const Sha = named(z.string().length(40).describe('A SHA-1.'), 'kinds.Sha', ['a'.repeat(40)]);
    const schema = named(
      z.object({ head: Sha.describe('The new head.'), base: Sha.describe('The old base.') }),
      'kinds.TwoShas',
      [{ head: 'a'.repeat(40), base: 'b'.repeat(40) }],
    );
    expect(issuesOf(schema)).toEqual([]);
  });

  it('reports every gap in a schema reached from several exported entries only once', () => {
    const Shared = z.object({ bare: z.string() }).describe('Shared.');
    const issues = formatIssues(
      findDocumentationIssues([
        { name: 'a.ts#A', schema: named(z.object({ s: Shared }), 'kinds.EntryA', [{ s: { bare: 'x' } }]) },
        { name: 'b.ts#B', schema: named(z.object({ s: Shared }), 'kinds.EntryB', [{ s: { bare: 'x' } }]) },
      ]),
    );
    expect(issues).toEqual(['a.ts#A.s.bare: missing description: add .describe() or .meta({ description })']);
  });
});
