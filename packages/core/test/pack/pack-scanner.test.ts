// SPDX-License-Identifier: Apache-2.0
import { deflateSync } from 'node:zlib';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import { PackScanner } from '../../src/pack/pack-scanner.ts';
import { buildPack, deltaSize, type BuiltEntry } from '../helpers/pack-builder.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IDENT = 'Ada <ada@example.com> 1700000000 +0000';

function commitData(parents: readonly string[], message: string): Uint8Array {
  const lines = [`tree ${TREE}`, ...parents.map((parent) => `parent ${parent}`), `author ${IDENT}`];
  return utf8(`${lines.join('\n')}\ncommitter ${IDENT}\n\n${message}\n`);
}

/** A delta that rebuilds `result` from nothing but inserts (valid against any base of `baseSize`). */
function insertDelta(baseSize: number, result: Uint8Array): Uint8Array {
  const out = [...deltaSize(baseSize), ...deltaSize(result.length)];
  for (let offset = 0; offset < result.length; offset += 127) {
    const part = result.subarray(offset, offset + 127);
    out.push(part.length, ...part);
  }
  return Uint8Array.from(out);
}

async function scan(pack: Uint8Array, sizes: readonly number[] = [pack.length], max?: number) {
  const scanner = new PackScanner(max === undefined ? {} : { maxCommitBytes: max });
  let offset = 0;
  let index = 0;
  while (offset < pack.length) {
    const size = Math.max(1, sizes[index % sizes.length] ?? 1);
    await scanner.push(pack.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
  return scanner.finish();
}

async function rejects(
  run: () => Promise<unknown>,
  code: 'invalid_pack' | 'unsupported_request',
): Promise<boolean> {
  try {
    await run();
  } catch (error) {
    return isCoreError(error, code);
  }
  return false;
}

describe('PackScanner', () => {
  it('collects whole commits with their parents and skips trees and blobs', async () => {
    const root = commitData([], 'root');
    const rootSha = await hashObject('commit', root);
    const child = commitData([rootSha], 'child');
    const childSha = await hashObject('commit', child);
    const pack = buildPack([
      { kind: 'whole', type: 'blob', data: utf8('hello\n'.repeat(1000)) },
      { kind: 'whole', type: 'commit', data: root },
      { kind: 'whole', type: 'tree', data: new Uint8Array(0) },
      { kind: 'whole', type: 'commit', data: child },
    ]);
    const result = await scan(pack, [1]);
    expect(result.objects).toBe(4);
    expect(result.unresolved).toBe(0);
    expect(result.commits).toEqual(
      new Map([
        [rootSha, []],
        [childSha, [rootSha]],
      ]),
    );
  });

  it('resolves commits stored as OFS_DELTA and REF_DELTA against commits in the pack', async () => {
    const base = commitData([], 'base');
    const baseSha = await hashObject('commit', base);
    const viaOfs = commitData([baseSha], 'via ofs');
    const viaRef = commitData([baseSha, await hashObject('commit', viaOfs)], 'via ref');
    const pack = buildPack([
      { kind: 'whole', type: 'commit', data: base },
      { kind: 'ofs', base: 0, delta: insertDelta(base.length, viaOfs) },
      { kind: 'ref', baseSha, delta: insertDelta(base.length, viaRef) },
    ]);
    const result = await scan(pack, [7, 3, 50]);
    expect(result.commits.get(await hashObject('commit', viaOfs))).toEqual([baseSha]);
    expect(result.commits.get(await hashObject('commit', viaRef))?.length).toBe(2);
    expect(result.unresolved).toBe(0);
  });

  it('counts deltas against bases outside the pack as unresolved, and follows them through OFS chains', async () => {
    const blob = utf8('content\n');
    const external = 'a'.repeat(40);
    const entries: BuiltEntry[] = [
      { kind: 'ref', baseSha: external, delta: insertDelta(3, blob) },
      { kind: 'ofs', base: 0, delta: insertDelta(blob.length, utf8('more\n')) },
      { kind: 'whole', type: 'blob', data: blob },
      { kind: 'ofs', base: 2, delta: insertDelta(blob.length, utf8('other\n')) },
    ];
    const result = await scan(buildPack(entries));
    expect(result.unresolved).toBe(2);
    expect(result.commits.size).toBe(0);
  });

  it('scans the same result however the pack is chunked (property)', async () => {
    const root = commitData([], 'root');
    const rootSha = await hashObject('commit', root);
    const pack = buildPack([
      { kind: 'whole', type: 'commit', data: root },
      { kind: 'whole', type: 'blob', data: Uint8Array.from({ length: 5000 }, (_, index) => index % 251) },
      { kind: 'ofs', base: 0, delta: insertDelta(root.length, commitData([rootSha], 'next')) },
    ]);
    const expected = await scan(pack);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 6 }),
        async (sizes) => {
          const result = await scan(pack, sizes);
          expect(result.commits).toEqual(expected.commits);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('leaves out a commit with a parent line after the author, which git reads as a root commit', async () => {
    const root = commitData([], 'root');
    const rootSha = await hashObject('commit', root);
    const crafted = utf8(`tree ${TREE}\nauthor ${IDENT}\ncommitter ${IDENT}\nparent ${rootSha}\n\ncrafted\n`);
    const craftedSha = await hashObject('commit', crafted);
    const result = await scan(
      buildPack([
        { kind: 'whole', type: 'commit', data: root },
        { kind: 'whole', type: 'commit', data: crafted },
      ]),
    );
    expect(result.commits.has(craftedSha)).toBe(false);
    expect(result.commits.get(rootSha)).toEqual([]);
    expect(result.malformed).toBe(1);
  });

  it('accepts an empty pack', async () => {
    const result = await scan(buildPack([]));
    expect(result).toEqual({ commits: new Map(), objects: 0, unresolved: 0, malformed: 0 });
  });

  it('rejects malformed packs', async () => {
    const good = buildPack([{ kind: 'whole', type: 'blob', data: utf8('x') }]);
    const badSignature = good.slice();
    badSignature[0] = 0x51;
    expect(await rejects(async () => scan(badSignature), 'invalid_pack')).toBe(true);
    expect(await rejects(async () => scan(buildPack([], { version: 4 })), 'invalid_pack')).toBe(true);
    expect(await rejects(async () => scan(good.subarray(0, good.length - 1)), 'invalid_pack')).toBe(true);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(await rejects(async () => scan(extra), 'invalid_pack')).toBe(true);
    expect(await rejects(async () => scan(buildPack([], { count: 1 })), 'invalid_pack')).toBe(true);
    const unknownType = good.slice();
    unknownType[12] = ((unknownType[12] ?? 0) & 0x8f) | (5 << 4);
    expect(await rejects(async () => scan(unknownType), 'invalid_pack')).toBe(true);
    const wrongSize = good.slice();
    wrongSize[12] = ((wrongSize[12] ?? 0) & 0xf0) | 2;
    expect(await rejects(async () => scan(wrongSize), 'invalid_pack')).toBe(true);
  });

  it('rejects an OFS_DELTA whose base does not start an entry', async () => {
    const pack = buildPack([
      { kind: 'whole', type: 'blob', data: utf8('x') },
      { kind: 'ofs', base: 0, delta: insertDelta(1, utf8('y')) },
    ]);
    // Point the delta one byte past the real base: its distance byte follows its one-byte header.
    const at = 12 + 1 + deflateSync(utf8('x')).length;
    expect(pack[at]).toBe(0x64);
    const shifted = pack.slice();
    shifted[at + 1] = (shifted[at + 1] ?? 0) - 1;
    expect(await rejects(async () => scan(shifted), 'invalid_pack')).toBe(true);
  });

  it('refuses a pack whose commits exceed the scan limit', async () => {
    const big = commitData([], 'x'.repeat(5000));
    expect(
      await rejects(
        async () => scan(buildPack([{ kind: 'whole', type: 'commit', data: big }]), [100], 1000),
        'unsupported_request',
      ),
    ).toBe(true);
  });
});
