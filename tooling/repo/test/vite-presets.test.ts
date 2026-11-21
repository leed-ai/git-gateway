// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { PEER_NAMES } from '../src/peer-policy.ts';
import { COMPATIBILITY_DATE, EXTERNAL_IMPORTS, libraryPack, nodeTest } from '../src/vite-presets.ts';

const isExternal = (specifier: string): boolean =>
  EXTERNAL_IMPORTS.some((pattern) => pattern.test(specifier));

describe('libraryPack', () => {
  it('keeps every policy peer and its subpaths out of the bundle', () => {
    for (const peer of PEER_NAMES) {
      expect(isExternal(peer)).toBe(true);
      expect(isExternal(`${peer}/sub/path`)).toBe(true);
    }
  });

  it('keeps Workers and Node runtime modules external', () => {
    expect(isExternal('cloudflare:workers')).toBe(true);
    expect(isExternal('node:child_process')).toBe(true);
  });

  it('bundles packages that only share a prefix with a peer', () => {
    expect(isExternal('zodiac')).toBe(false);
    expect(isExternal('honojs-extra')).toBe(false);
    expect(isExternal('./zod')).toBe(false);
  });

  it('builds one ESM entry per source module with declarations and the externals', () => {
    expect(libraryPack()).toMatchObject({
      entry: ['src/**/*.ts', '!src/**/*.test.ts'],
      format: 'esm',
      dts: true,
      deps: { neverBundle: EXTERNAL_IMPORTS },
    });
  });
});

describe('test presets', () => {
  it('runs every test file under test/', () => {
    expect(nodeTest()).toEqual({ include: ['test/**/*.test.ts'] });
    expect(nodeTest({ exclude: ['x'] })).toEqual({ include: ['test/**/*.test.ts'], exclude: ['x'] });
  });

  it('uses a fixed ISO compatibility date', () => {
    expect(COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
