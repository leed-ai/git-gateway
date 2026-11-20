// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { childrenOf, isSchema, kindOf, membersOf, unwrap } from '../src/zod-node.ts';

describe('zod-node', () => {
  it('recognises schemas structurally', () => {
    expect(isSchema(z.string())).toBe(true);
    expect(isSchema({ _zod: { def: { type: 'string' } } })).toBe(true);
    expect(isSchema({ _zod: null })).toBe(false);
    expect(isSchema('string')).toBe(false);
    expect(isSchema(null)).toBe(false);
  });

  it('unwraps wrapper chains down to the core schema', () => {
    const core = z.string();
    const { chain } = unwrap(core.optional().nullable().default(null).readonly());
    expect(chain.map(kindOf)).toEqual(['readonly', 'default', 'nullable', 'optional', 'string']);
    expect(chain.at(-1)).toBe(core);
  });

  it('follows lazy getters and pipe inputs, keeping pipe outputs aside', () => {
    const out = z.string().min(1);
    const { chain, pipeOutputs } = unwrap(z.lazy(() => z.string().pipe(out)));
    expect(chain.map(kindOf)).toEqual(['lazy', 'pipe', 'string']);
    expect(pipeOutputs).toEqual([out]);
  });

  it('stops on a lazy schema that returns itself', () => {
    const selfRef: z.ZodType = z.lazy(() => selfRef);
    expect(unwrap(selfRef).chain).toHaveLength(1);
  });

  it('lists object fields, including a typed catch-all but not an open one', () => {
    const typed = z.object({ a: z.string() }).catchall(z.number());
    expect(childrenOf(typed).map(({ segment }) => segment)).toEqual(['.a', '.*']);
    expect(childrenOf(z.looseObject({ a: z.string() })).map(({ segment }) => segment)).toEqual(['.a']);
  });

  it('lists tuple rest items', () => {
    const tuple = z.tuple([z.string()], z.number());
    expect(childrenOf(tuple).map(({ segment }) => segment)).toEqual(['[0]', '[...]']);
  });

  it('has no children for leaves', () => {
    expect(childrenOf(z.string())).toEqual([]);
  });

  it('lists members of enums and multi-value literals only', () => {
    expect(membersOf(z.enum(['a', 'b']))).toEqual(['a', 'b']);
    expect(membersOf(z.literal([1, 2]))).toEqual(['1', '2']);
    expect(membersOf(z.literal('only'))).toEqual([]);
    expect(membersOf(z.string())).toEqual([]);
  });
});
