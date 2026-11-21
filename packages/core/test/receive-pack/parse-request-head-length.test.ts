// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { readAllBytes, streamOf } from '../../src/bytes.ts';
import { encodeReceivePackRequest } from '../../src/receive-pack/encode-request.ts';
import { parseReceivePackRequest } from '../../src/receive-pack/parse-request.ts';
import { arbitrarySha } from '../helpers/arbitraries.ts';

const PACK = new TextEncoder().encode('PACK\0\0\0\x02 pretend pack bytes');

describe('parseReceivePackRequest headLength', () => {
  it('locates the pack after the commands and push options, however the body is chunked (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(arbitrarySha, { minLength: 2, maxLength: 4 }),
        fc.array(fc.stringMatching(/^[a-z.]{0,12}$/), { maxLength: 3 }),
        fc.integer({ min: 1, max: 40 }),
        async ([oldSha = '', ...news], pushOptions, size) => {
          const commands = news.map((newSha, index) => ({ oldSha, newSha, ref: `refs/heads/b${index}` }));
          const body = encodeReceivePackRequest({ commands, pushOptions, pack: PACK });
          const chunks: Uint8Array[] = [];
          for (let offset = 0; offset < body.length; offset += size)
            chunks.push(body.subarray(offset, offset + size));
          const parsed = await parseReceivePackRequest(streamOf(...chunks));
          const replay = await readAllBytes(parsed.body);
          expect(parsed.headLength).toBe(body.length - PACK.length);
          expect([...replay.subarray(parsed.headLength)]).toEqual([...PACK]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
