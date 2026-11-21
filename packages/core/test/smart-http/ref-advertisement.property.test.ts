// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import type { RefAdvertisement } from '../../src/schemas/ref-advertisement.ts';
import { encodeRefAdvertisement, parseRefAdvertisement } from '../../src/smart-http/ref-advertisement.ts';

const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
const segment = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,11}$/);
const refName = fc
  .tuple(fc.constantFrom('heads', 'tags'), fc.array(segment, { minLength: 1, maxLength: 3 }))
  .map(([kind, parts]) => `refs/${kind}/${parts.join('/')}`);
const capability = fc.constantFrom(
  'report-status',
  'side-band-64k',
  'ofs-delta',
  'atomic',
  'push-options',
  'shallow',
  'agent=git/2.43.0',
);

const advertisement: fc.Arbitrary<RefAdvertisement> = fc
  .record({
    service: fc.constantFrom('git-upload-pack' as const, 'git-receive-pack' as const),
    refs: fc.uniqueArray(fc.record({ name: refName, sha, peeled: fc.option(sha, { nil: null }) }), {
      selector: (ref) => ref.name,
      maxLength: 12,
    }),
    capabilities: fc.uniqueArray(capability, { maxLength: 7 }),
    head: fc.boolean(),
  })
  .map(({ service, refs, capabilities, head }) => {
    const target = refs.find((ref) => ref.name.startsWith('refs/heads/'));
    if (!head || target === undefined || refs.length === 0)
      return { service, refs, capabilities, symrefs: {} };
    return {
      service,
      refs: [{ name: 'HEAD' as const, sha: target.sha, peeled: null }, ...refs],
      capabilities: [...capabilities, `symref=HEAD:${target.name}`],
      symrefs: { HEAD: target.name },
    };
  });

describe('ref advertisement (properties)', () => {
  it('parses back exactly what it encodes, empty repositories included', () => {
    fc.assert(
      fc.property(advertisement, (sent) => {
        expect(parseRefAdvertisement(encodeRefAdvertisement(sent), sent.service)).toEqual(sent);
      }),
    );
  });
});
