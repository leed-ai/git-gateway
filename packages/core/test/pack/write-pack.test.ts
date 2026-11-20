// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { bytesToHex, sha1Bytes } from '../../src/bytes.ts';
import { createObject } from '../../src/objects/hash-object.ts';
import { deflate, inflate } from '../../src/pack/deflate.ts';
import { packEntryHeader, writePack } from '../../src/pack/write-pack.ts';
import type { GitObject } from '../../src/schemas/git-object.ts';
import { readPack } from '../helpers/read-pack.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('packEntryHeader', () => {
  it.each([
    ['blob', 0, [0x30]],
    ['blob', 15, [0x3f]],
    ['blob', 16, [0xb0, 0x01]],
    ['tree', 100, [0xa4, 0x06]],
    ['commit', 2047, [0x9f, 0x7f]],
    ['blob', 2048, [0xb0, 0x80, 0x01]],
  ] as const)('encodes a %s of %d bytes', (type, size, expected) => {
    expect([...packEntryHeader(type, size)]).toEqual(expected);
  });

  it('encodes sizes beyond 32 bits', () => {
    const header = packEntryHeader('blob', 2 ** 33 + 5);
    let size = (header[0] ?? 0) & 15;
    for (let index = 1; index < header.length; index += 1)
      size += ((header[index] ?? 0) & 0x7f) * 2 ** (4 + 7 * (index - 1));
    expect(size).toBe(2 ** 33 + 5);
  });
});

describe('deflate', () => {
  it('round-trips through inflate', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 5000 }), async (data) => {
        expect(await inflate(await deflate(data))).toEqual(data);
      }),
      { numRuns: 30 },
    );
  });

  it('writes a zlib (RFC 1950) stream', async () => {
    const compressed = await deflate(bytes('hello'));
    expect((compressed[0] ?? 0) & 0x0f).toBe(8);
    expect((((compressed[0] ?? 0) << 8) | (compressed[1] ?? 0)) % 31).toBe(0);
  });
});

describe('writePack', () => {
  it('writes the header, the objects and a SHA-1 trailer', async () => {
    const blob = await createObject('blob', bytes('hello\n'));
    const pack = await writePack([blob]);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');
    expect([...pack.subarray(4, 12)]).toEqual([0, 0, 0, 2, 0, 0, 0, 1]);
    expect(bytesToHex(pack.subarray(-20))).toBe(bytesToHex(await sha1Bytes(pack.subarray(0, -20))));
    expect(await readPack(pack)).toEqual([blob]);
  });

  it('writes an empty pack', async () => {
    const pack = await writePack([]);
    expect(pack.length).toBe(32);
    expect(await readPack(pack)).toEqual([]);
  });

  it('writes an object listed twice only once', async () => {
    const blob = await createObject('blob', bytes('x'));
    expect(await readPack(await writePack([blob, blob]))).toEqual([blob]);
  });

  it('round-trips any set of objects', async () => {
    const object = fc
      .tuple(fc.constantFrom('blob', 'tree', 'commit' as const), fc.uint8Array({ maxLength: 400 }))
      .map(async ([type, data]) => createObject(type, data));
    await fc.assert(
      fc.asyncProperty(fc.array(object, { maxLength: 6 }), async (pending) => {
        const objects = await Promise.all(pending);
        const unique = [...new Map(objects.map((o): [string, GitObject] => [o.sha, o])).values()];
        expect(await readPack(await writePack(objects))).toEqual(unique);
      }),
      { numRuns: 25 },
    );
  });

  it('refuses something that is not an object', async () => {
    await expect(writePack([{ type: 'blob', sha: 'nope', data: new Uint8Array(0) }])).rejects.toThrow(
      ZodError,
    );
  });
});
