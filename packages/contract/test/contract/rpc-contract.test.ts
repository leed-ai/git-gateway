// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { RPC_SCHEMAS } from '../../src/git-gateway.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';

const METHODS = [
  'commit',
  'readFile',
  'listTree',
  'resolveRef',
  'log',
  'commitExists',
  'syncBranch',
  'promote',
  'createRepo',
  'deleteRepo',
  'mintReadToken',
] as const;

// The wire contract consumers depend on: every method has schemas, inputs reject unknown fields
// (so additions are deliberate), and every example parses.
describe('RPC contract', () => {
  it('defines schemas for exactly the eleven RPC methods', () => {
    expect(Object.keys(RPC_SCHEMAS).toSorted()).toEqual([...METHODS].toSorted());
  });

  it('is implemented in full by the reference', () => {
    expect(Object.keys(createReferenceGateway()).toSorted()).toEqual([...METHODS].toSorted());
  });

  it.each(METHODS)('%s input rejects unknown fields', (method) => {
    const schema: z.ZodType = RPC_SCHEMAS[method].input;
    const examples: unknown = z.globalRegistry.get(schema)?.['examples'];
    const example: unknown = Array.isArray(examples) ? examples[0] : undefined;
    expect(schema.safeParse(example).success).toBe(true);
    expect(schema.safeParse({ ...Object(example), unexpected: true }).success).toBe(false);
  });

  it.each(METHODS)('%s has a stable JSON Schema', (method) => {
    const { input, output } = RPC_SCHEMAS[method];
    expect({
      input: z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }),
      output: z.toJSONSchema(output, { unrepresentable: 'any' }),
    }).toMatchSnapshot();
  });
});
