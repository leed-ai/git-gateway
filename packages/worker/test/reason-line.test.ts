// SPDX-License-Identifier: Apache-2.0
import { RefStatus } from '@leed-ai/git-gateway-core/schemas/report-status';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { reasonLine } from '../src/policy/branch-policy.ts';

describe('reasonLine', () => {
  it('folds line breaks and NULs into spaces, trims, and keeps a plain reason as it is', () => {
    expect(reasonLine('main is protected')).toBe('main is protected');
    expect(reasonLine('  first\r\nsecond\0third\n')).toBe('first second third');
  });

  it('answers "refused" for a reason that is empty once cleaned', () => {
    expect(reasonLine('')).toBe('refused');
    expect(reasonLine('\n\r\0  ')).toBe('refused');
  });

  it('cuts a long reason to 500 characters', () => {
    expect(reasonLine('x'.repeat(2000))).toHaveLength(500);
  });

  it('always yields a reason report-status can carry as "ng <ref> <reason>" (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 1200 }),
        fc.string({ maxLength: 1200 }),
        (a, b) => {
          const line = reasonLine(`${a}\n${b}`);
          expect(line.length).toBeGreaterThan(0);
          expect(line.length).toBeLessThanOrEqual(500);
          expect(line).not.toMatch(/[\n\r\0]/);
          expect(RefStatus.safeParse({ ref: 'refs/heads/main', status: 'ng', reason: line }).success).toBe(
            true,
          );
        },
      ),
    );
  });
});
