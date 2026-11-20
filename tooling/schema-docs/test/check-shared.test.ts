// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { findDocumentationIssues, formatIssues } from '../src/check.ts';

const named = <T extends z.ZodType>(schema: T, id: string, examples: unknown[]): T =>
  schema.meta({ id, title: id, description: `The ${id} schema.`, examples });

const issuesOf = (schema: z.ZodType, name = 'm#S'): string[] =>
  formatIssues(findDocumentationIssues([{ name, schema }]));

describe('findDocumentationIssues on schemas reached more than once', () => {
  it('walks the output of every pipe when two exported pipes share one input', () => {
    const Text = z.string().describe('JSON text.');
    const First = named(
      Text.pipe(z.transform((text: string): unknown => JSON.parse(text))).pipe(
        z.object({ id: z.string().describe('Identifier.') }),
      ),
      'check.SharedInputFirst',
      ['{"id":"a"}'],
    );
    const Second = named(
      Text.pipe(z.transform((text: string): unknown => JSON.parse(text))).pipe(
        z.object({ name: z.string() }),
      ),
      'check.SharedInputSecond',
      ['{"name":"a"}'],
    );
    const issues = formatIssues(
      findDocumentationIssues([
        { name: 'm#First', schema: First },
        { name: 'm#Second', schema: Second },
      ]),
    );
    expect(issues).toEqual([
      'm#Second>out.name: missing description: add .describe() or .meta({ description })',
    ]);
  });

  it('checks enum descriptions on every use of a shared enum', () => {
    const Axis = z.enum(['x', 'y']);
    const schema = named(
      z.object({
        a: Axis.describe('Documented use.').meta({ enumDescriptions: { x: 'Across.', y: 'Down.' } }),
        b: Axis.describe('Undocumented use.'),
      }),
      'check.SharedEnum',
      [{ a: 'x', b: 'y' }],
    );
    expect(issuesOf(schema)).toEqual([
      'm#S.b: enum members are not described: add .meta({ enumDescriptions: { <member>: "…" } })',
    ]);
  });

  it('stops at a pipe whose output leads back to itself', () => {
    const Loop: z.ZodType<unknown, string> = named(
      z
        .string()
        .describe('Text.')
        .pipe(z.lazy((): z.ZodType<unknown, string> => Loop)),
      'check.PipeLoop',
      [],
    );
    expect(() => findDocumentationIssues([{ name: 'm#Loop', schema: Loop }])).not.toThrow();
  });
});
