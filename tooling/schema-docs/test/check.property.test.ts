// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { findDocumentationIssues } from '../src/check.ts';

/** A generated schema shape; `described` says whether this node gets a description. */
type Shape =
  | { readonly kind: 'leaf'; readonly leaf: 'string' | 'number' | 'boolean'; readonly described: boolean }
  | { readonly kind: 'object'; readonly fields: readonly Shape[]; readonly described: boolean }
  | { readonly kind: 'array'; readonly element: Shape; readonly described: boolean }
  | { readonly kind: 'union'; readonly options: readonly Shape[]; readonly described: boolean }
  | { readonly kind: 'optional'; readonly inner: Shape; readonly described: boolean };

const { shape } = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({
      kind: fc.constant('leaf' as const),
      leaf: fc.constantFrom('string' as const, 'number' as const, 'boolean' as const),
      described: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant('object' as const),
      fields: fc.array(tie('shape'), { maxLength: 4 }),
      described: fc.boolean(),
    }),
    fc.record({ kind: fc.constant('array' as const), element: tie('shape'), described: fc.boolean() }),
    fc.record({
      kind: fc.constant('union' as const),
      options: fc.array(tie('shape'), { minLength: 2, maxLength: 3 }),
      described: fc.boolean(),
    }),
    fc.record({ kind: fc.constant('optional' as const), inner: tie('shape'), described: fc.boolean() }),
  ),
}));

function build(node: Shape): z.ZodType {
  let schema: z.ZodType;
  switch (node.kind) {
    case 'leaf':
      schema = node.leaf === 'string' ? z.string() : node.leaf === 'number' ? z.number() : z.boolean();
      break;
    case 'object':
      schema = z.object(Object.fromEntries(node.fields.map((field, index) => [`f${index}`, build(field)])));
      break;
    case 'array':
      schema = z.array(build(node.element));
      break;
    case 'union': {
      const [first, second, ...rest] = node.options;
      if (first === undefined || second === undefined)
        throw new Error('a generated union has two or more options');
      schema = z.union([build(first), build(second), ...rest.map(build)]);
      break;
    }
    case 'optional':
      schema = build(node.inner).optional();
      break;
  }
  return node.described ? schema.describe(`${node.kind} node`) : schema;
}

/** Whether a node, or any schema it wraps, carries a description. */
const unitDescribed = (node: Shape): boolean =>
  node.described || (node.kind === 'optional' && unitDescribed(node.inner));

/** The innermost node under a chain of optional wrappers. */
const coreOf = (node: Shape): Shape => (node.kind === 'optional' ? coreOf(node.inner) : node);

/** How many described-unit gaps the harness should report for this node and everything under it. */
function expectedGaps(node: Shape): number {
  const own = unitDescribed(node) ? 0 : 1;
  const core = coreOf(node);
  const children =
    core.kind === 'object'
      ? core.fields
      : core.kind === 'array'
        ? [core.element]
        : core.kind === 'union'
          ? core.options
          : [];
  return own + children.reduce((sum, child) => sum + expectedGaps(child), 0);
}

describe('findDocumentationIssues (properties)', () => {
  it('reports exactly one issue per undescribed node, wherever it sits', () => {
    fc.assert(
      fc.property(fc.array(shape, { minLength: 1, maxLength: 4 }), (fields) => {
        const root = z
          .object(Object.fromEntries(fields.map((field, index) => [`f${index}`, build(field)])))
          .describe('Generated root.');
        const issues = findDocumentationIssues([{ name: 'm#Root', schema: root }]);
        const gaps = issues.filter(({ problem }) => problem.startsWith('missing description'));
        expect(gaps).toHaveLength(fields.reduce((sum, field) => sum + expectedGaps(field), 0));
      }),
      { numRuns: 300 },
    );
  });

  it('reports nothing beyond naming once every node is described', () => {
    const describeAll = (node: Shape): Shape => {
      if (node.kind === 'object') return { ...node, described: true, fields: node.fields.map(describeAll) };
      if (node.kind === 'array') return { ...node, described: true, element: describeAll(node.element) };
      if (node.kind === 'union') return { ...node, described: true, options: node.options.map(describeAll) };
      if (node.kind === 'optional') return { ...node, described: true, inner: describeAll(node.inner) };
      return { ...node, described: true };
    };
    fc.assert(
      fc.property(shape, (node) => {
        const issues = findDocumentationIssues([{ name: 'm#S', schema: build(describeAll(node)) }]);
        expect(issues.map(({ problem }) => problem)).toEqual([
          'exported schema is not named: add .meta({ id, title, description, examples })',
        ]);
      }),
      { numRuns: 300 },
    );
  });
});
