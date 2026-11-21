// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { importedPackages, packageOfSpecifier } from '../src/source-imports.ts';

describe('packageOfSpecifier', () => {
  it('maps bare specifiers to package names', () => {
    expect(packageOfSpecifier('zod')).toBe('zod');
    expect(packageOfSpecifier('zod/v4/core')).toBe('zod');
    expect(packageOfSpecifier('@leed-ai/git-gateway-core/pkt-line')).toBe('@leed-ai/git-gateway-core');
  });

  it('ignores relative paths and scheme builtins', () => {
    expect(packageOfSpecifier('./health')).toBeUndefined();
    expect(packageOfSpecifier('/abs')).toBeUndefined();
    expect(packageOfSpecifier('node:fs')).toBeUndefined();
    expect(packageOfSpecifier('cloudflare:workers')).toBeUndefined();
  });
});

describe('importedPackages', () => {
  it('finds static, type-only, re-exported and dynamic imports', () => {
    const source = [
      "import { z } from 'zod';",
      'import type { Context } from "hono";',
      "export { x } from 'cloudflare/resources';",
      "const mod = await import('fast-check');",
      "import { env } from 'cloudflare:workers';",
      "import { local } from './local.ts';",
    ].join('\n');
    expect([...importedPackages(source)].toSorted()).toEqual(['cloudflare', 'fast-check', 'hono', 'zod']);
  });

  it('finds side-effect imports and star re-exports across lines', () => {
    const source = [
      "import 'zod';",
      'export * from "hono";',
      'import {',
      '  a,',
      "} from '@scope/pkg/sub';",
    ].join('\n');
    expect([...importedPackages(source)].toSorted()).toEqual(['@scope/pkg', 'hono', 'zod']);
  });

  it('finds nothing in a file without imports', () => {
    expect(importedPackages('export const x = 1;').size).toBe(0);
  });
});
