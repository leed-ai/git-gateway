// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import manifest from '../package.json' with { type: 'json' };
import { packageName } from '../src/package-name.ts';

describe('packageName', () => {
  it('matches the published package name', () => {
    expect(packageName).toBe(manifest.name);
  });
});
