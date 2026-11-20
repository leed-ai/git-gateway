// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { hasSpdxHeader, needsSpdxHeader, SPDX_HEADER } from '../src/spdx.ts';

describe('SPDX headers', () => {
  it('selects source files but not declaration files or other content', () => {
    expect(needsSpdxHeader('packages/core/src/a.ts')).toBe(true);
    expect(needsSpdxHeader('scripts/x.mjs')).toBe(true);
    expect(needsSpdxHeader('types/env.d.ts')).toBe(false);
    expect(needsSpdxHeader('README.md')).toBe(false);
    expect(needsSpdxHeader('package.json')).toBe(false);
  });

  it('requires the header on the first line, after an optional shebang', () => {
    expect(hasSpdxHeader(`${SPDX_HEADER}\nexport {};\n`)).toBe(true);
    expect(hasSpdxHeader(`#!/usr/bin/env bun\n${SPDX_HEADER}\n`)).toBe(true);
    expect(hasSpdxHeader(`${SPDX_HEADER}\r\nexport {};`)).toBe(true);
    expect(hasSpdxHeader(`export {};\n${SPDX_HEADER}\n`)).toBe(false);
    expect(hasSpdxHeader('// SPDX-License-Identifier: MIT\n')).toBe(false);
    expect(hasSpdxHeader('')).toBe(false);
  });
});
