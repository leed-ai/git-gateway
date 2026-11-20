// SPDX-License-Identifier: Apache-2.0
import { blobSha } from '@leed-ai/git-gateway-contract/reference/hash';
import * as fc from 'fast-check';
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { bytesToHex, concatBytes, hexToBytes, readAllBytes, streamOf } from '../../src/bytes.ts';
import { createObject, hashObject, objectBytes } from '../../src/objects/hash-object.ts';
import type { GitObjectType } from '../../src/schemas/git-object.ts';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

// Ids from `git hash-object` (git 2.43); the tree and commit fixtures live in their own tests.
describe('hashObject', () => {
  it.each<[string, GitObjectType, string, string]>([
    ['the empty blob', 'blob', '', 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
    ['"hello\\n"', 'blob', 'hello\n', 'ce013625030ba8dba906f756967f9e9ca394464a'],
    ['a script', 'blob', '#!/bin/sh\necho hi\n', '4163036efa65bd4a469e752267498f01ea36a55c'],
    ['the empty tree', 'tree', '', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
  ])('hashes %s as git does', async (_, type, content, sha) => {
    expect(await hashObject(type, bytes(content))).toBe(sha);
  });

  it('agrees with the contract reference blob id for any content', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 2000 }), async (content) => {
        expect(await hashObject('blob', content)).toBe(await blobSha(content));
      }),
      { numRuns: 50 },
    );
  });

  it('prefixes the loose-object header', () => {
    expect(new TextDecoder().decode(objectBytes('commit', bytes('abc')))).toBe('commit 3\0abc');
  });

  it('refuses an unknown type', () => {
    expect(() => objectBytes(JSON.parse('"tag"'), new Uint8Array(0))).toThrow(ZodError);
  });

  it('creates an object with its id', async () => {
    expect(await createObject('blob', bytes('hello\n'))).toEqual({
      type: 'blob',
      sha: 'ce013625030ba8dba906f756967f9e9ca394464a',
      data: bytes('hello\n'),
    });
  });
});

describe('byte helpers', () => {
  it('round-trips hex', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (raw) => {
        expect(hexToBytes(bytesToHex(raw))).toEqual(raw);
      }),
    );
  });

  it('concatenates and streams bytes', async () => {
    expect(concatBytes([bytes('a'), new Uint8Array(0), bytes('bc')])).toEqual(bytes('abc'));
    expect(await readAllBytes(streamOf(bytes('a'), bytes('bc')))).toEqual(bytes('abc'));
  });
});
