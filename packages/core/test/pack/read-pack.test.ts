// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import { MAX_PACK_OBJECTS, readPack } from '../../src/pack/read-pack.ts';
import { writePack } from '../../src/pack/write-pack.ts';
import type { GitObject } from '../../src/schemas/git-object.ts';
import { buildPack, deltaSize } from '../helpers/pack-builder.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The details of the invalid_pack CoreError `run` rejects with, as JSON, or "not invalid_pack". */
async function invalidPackReason(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (isCoreError(error, 'invalid_pack')) return JSON.stringify(error.body.details);
  }
  return 'not invalid_pack';
}

/** A delta turning `base` into `base` + `suffix`. */
function appendDelta(base: Uint8Array, suffix: string): Uint8Array {
  const tail = bytes(suffix);
  const length = base.length;
  // Copy (offset 0, two size bytes), then insert the suffix.
  return Uint8Array.from([
    ...deltaSize(length),
    ...deltaSize(length + tail.length),
    0xb0,
    length & 0xff,
    length >> 8,
    tail.length,
    ...tail,
  ]);
}

/** Recomputes a pack's trailing checksum after an edit. */
function resum(pack: Uint8Array): Uint8Array {
  const body = pack.subarray(0, pack.length - 20);
  return new Uint8Array([...body, ...createHash('sha1').update(body).digest()]);
}

describe('readPack', () => {
  it('reads back what writePack writes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uint8Array({ maxLength: 2000 }), { maxLength: 8 }), async (blobs) => {
        const objects = await Promise.all(blobs.map(async (data) => createObject('blob', data)));
        const unique = [...new Map(objects.map((object) => [object.sha, object])).values()];
        const read = await readPack(await writePack(objects));
        expect(read.map((object) => object.sha)).toEqual(unique.map((object) => object.sha));
      }),
      { numRuns: 30 },
    );
  });

  it('resolves OFS_DELTA entries against earlier entries, chains included', async () => {
    const base = bytes('base content\n'.repeat(20));
    const one = appendDelta(base, 'one\n');
    const second = new Uint8Array([...base, ...bytes('one\n')]);
    const two = appendDelta(second, 'two\n');
    const pack = buildPack([
      { kind: 'whole', type: 'blob', data: base },
      { kind: 'ofs', base: 0, delta: one },
      { kind: 'ofs', base: 1, delta: two },
    ]);
    const objects = await readPack(pack);
    expect(objects.map((object) => new TextDecoder().decode(object.data).slice(-8))).toEqual([
      'content\n',
      'ent\none\n',
      'one\ntwo\n',
    ]);
    expect(objects[2]?.sha).toBe(
      (await createObject('blob', new Uint8Array([...second, ...bytes('two\n')]))).sha,
    );
  });

  it('resolves REF_DELTA entries against later entries in the pack', async () => {
    const base = await createObject('blob', bytes('referenced base\n'));
    const pack = buildPack([
      { kind: 'ref', baseSha: base.sha, delta: appendDelta(base.data, 'more\n') },
      { kind: 'whole', type: 'blob', data: base.data },
    ]);
    const objects = await readPack(pack);
    expect(objects.map((object) => object.type)).toEqual(['blob', 'blob']);
    expect(new TextDecoder().decode(objects[0]?.data)).toBe('referenced base\nmore\n');
  });

  it('resolves a thin pack through lookupBase and fails without it', async () => {
    const base = await createObject('tree', new Uint8Array(0));
    const pack = buildPack([{ kind: 'ref', baseSha: base.sha, delta: Uint8Array.from([0, 0]) }]);
    const lookups: string[] = [];
    const objects = await readPack(pack, {
      lookupBase: async (sha): Promise<GitObject | null> => {
        lookups.push(sha);
        return sha === base.sha ? base : null;
      },
    });
    expect(lookups).toEqual([base.sha]);
    expect(objects).toEqual([base]);
    expect(await invalidPackReason(readPack(pack))).toMatch(/not in the pack/);
    expect(await invalidPackReason(readPack(pack, { lookupBase: async () => null }))).toMatch(
      /not in the pack/,
    );
  });

  it('rejects an OFS_DELTA whose base offset is not an entry, or outside the pack', async () => {
    const first = { kind: 'whole' as const, type: 'blob' as const, data: bytes('a') };
    const firstLength = buildPack([first]).length - 32;
    const pack = buildPack([first, { kind: 'ofs', base: 0, delta: Uint8Array.from([1, 1, 1, 65]) }]);
    expect(await readPack(pack)).toHaveLength(2);
    const distanceAt = 12 + firstLength + 1;
    const midEntry = pack.slice();
    midEntry[distanceAt] = 1;
    expect(await invalidPackReason(readPack(resum(midEntry)))).toMatch(/not in the pack/);
    const outside = pack.slice();
    outside[distanceAt] = 0x7f;
    expect(await invalidPackReason(readPack(resum(outside)))).toMatch(/outside the pack/);
  });

  it('rejects bad signatures, versions, checksums, counts and lengths', async () => {
    const pack = await writePack([await createObject('blob', bytes('x'))]);
    expect(await invalidPackReason(readPack(pack.subarray(0, 20)))).toMatch(/shorter/);
    const signature = pack.slice();
    signature[0] = 0x51;
    expect(await invalidPackReason(readPack(resum(signature)))).toMatch(/PACK/);
    expect(
      await invalidPackReason(
        readPack(buildPack([{ kind: 'whole', type: 'blob', data: bytes('x') }], { version: 4 })),
      ),
    ).toMatch(/version/);
    const flipped = pack.slice();
    flipped[15] = (flipped[15] ?? 0) ^ 1;
    expect(await invalidPackReason(readPack(flipped))).toMatch(/checksum/);
    expect(
      await invalidPackReason(
        readPack(buildPack([{ kind: 'whole', type: 'blob', data: bytes('x') }], { count: 2 })),
      ),
    ).toMatch(/ends after/);
    expect(
      await invalidPackReason(
        readPack(buildPack([{ kind: 'whole', type: 'blob', data: bytes('x') }], { count: 0 })),
      ),
    ).toMatch(/remain/);
    expect(await invalidPackReason(readPack(buildPack([], { count: MAX_PACK_OBJECTS + 1 })))).toMatch(
      /claims/,
    );
  });

  it('accepts version 3 packs and rejects unknown entry types and size mismatches', async () => {
    expect(
      await readPack(buildPack([{ kind: 'whole', type: 'commit', data: bytes('tree x\n') }], { version: 3 })),
    ).toHaveLength(1);
    const pack = buildPack([{ kind: 'whole', type: 'blob', data: bytes('abc') }]);
    const typed = pack.slice();
    typed[12] = ((typed[12] ?? 0) & 0x8f) | (5 << 4);
    expect(await invalidPackReason(readPack(resum(typed)))).toMatch(/unknown entry type/);
    const sized = pack.slice();
    sized[12] = ((sized[12] ?? 0) & 0xf0) | 4;
    expect(await invalidPackReason(readPack(resum(sized)))).toMatch(/header says/);
  });
});
