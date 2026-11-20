// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { collectExportedSchemas } from '../src/collect.ts';

describe('collectExportedSchemas', () => {
  it('lists exported schemas by module and export name, sorted, once each', () => {
    const shared = z.string();
    const other = z.number();
    const entries = collectExportedSchemas({
      '../src/b.ts': { Zeta: other, Alpha: shared, helper: () => 1, value: 3 },
      '../src/a.ts': { Shared: shared, nothing: null },
      './src/c.ts': null,
    });
    expect(entries.map(({ name }) => name)).toEqual(['src/a.ts#Shared', 'src/b.ts#Zeta']);
    expect(entries[0]?.schema).toBe(shared);
  });

  it('returns nothing for modules without schemas', () => {
    expect(collectExportedSchemas({ 'x.ts': { packageName: 'x' } })).toEqual([]);
  });
});
