// SPDX-License-Identifier: Apache-2.0
import { concatBytes, readAllBytes, streamOf } from '@leed-ai/git-gateway-core/bytes';
import { writePack } from '@leed-ai/git-gateway-core/pack/write-pack';
import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { guardPush, holdPush, PushRefused } from '../src/proxy/push-guard.ts';
import { commitObject, emptyTree } from './helpers/push-builder.ts';

const HEAD = new TextEncoder().encode('0000head-bytes-before-the-pack');
let pack: Uint8Array;
let commitSha: string;

beforeAll(async () => {
  const commit = await commitObject([], 'root');
  commitSha = commit.sha;
  pack = await writePack([await emptyTree(), commit]);
});

function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) out.push(bytes.subarray(offset, offset + size));
  return out;
}

/** Pulls the guarded stream chunk by chunk, recording how much had come out before the source ended. */
async function run(size: number, decide: () => Promise<{ ref: string; reason: string }[]>) {
  const body = concatBytes([HEAD, pack]);
  const refusals: unknown[] = [];
  let seen: ReadonlyMap<string, readonly string[]> = new Map();
  const guarded = streamOf(...chunks(body, size)).pipeThrough(
    guardPush({
      headLength: HEAD.length,
      maxCommitBytes: 1024 * 1024,
      decide: async (scan) => {
        seen = scan.commits;
        return decide();
      },
      onRefused: (list) => refusals.push(...list),
      refuseAll: (reason) => [{ ref: 'refs/heads/main', reason }],
    }),
  );
  return { body, guarded, refusals, seen: () => seen };
}

describe('guardPush', () => {
  it('forwards everything, unchanged, once the decision allows it (property: any chunking)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200 }), async (size) => {
        const { body, guarded, seen } = await run(size, async () => []);
        expect(await readAllBytes(guarded)).toEqual(body);
        expect([...seen().keys()]).toEqual([commitSha]);
      }),
      { numRuns: 60 },
    );
  });

  it('holds back the 20-byte pack checksum until the decision', async () => {
    let decided = false;
    const { body, guarded } = await run(7, async () => {
      decided = true;
      return [];
    });
    const reader = guarded.getReader();
    let before = 0;
    for (let next = await reader.read(); !next.done; next = await reader.read())
      if (!decided) before += next.value.length;
    expect(before).toBeLessThanOrEqual(body.length - 20);
  });

  it('fails the stream with the refusals, never releasing the checksum', async () => {
    const { body, guarded, refusals } = await run(50, async () => [{ ref: 'refs/heads/main', reason: 'no' }]);
    const reader = guarded.getReader();
    let forwarded = 0;
    const failure = await (async () => {
      try {
        for (let next = await reader.read(); !next.done; next = await reader.read())
          forwarded += next.value.length;
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(PushRefused);
    expect(forwarded).toBeLessThanOrEqual(body.length - 20);
    expect(refusals).toEqual([{ ref: 'refs/heads/main', reason: 'no' }]);
  });

  it('never releases the checksum when the decision refuses or fails (property: any chunking)', async () => {
    const decisions = [
      async () => [{ ref: 'refs/heads/main', reason: 'no' }],
      async (): Promise<{ ref: string; reason: string }[]> => {
        throw new Error('ancestry lookup failed');
      },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        fc.constantFrom(...decisions),
        async (size, decide) => {
          const { body, guarded } = await run(size, decide);
          const reader = guarded.getReader();
          let forwarded = 0;
          let failed = false;
          try {
            for (let next = await reader.read(); !next.done; next = await reader.read())
              forwarded += next.value.length;
          } catch {
            failed = true;
          }
          expect(failed).toBe(true);
          expect(forwarded).toBeLessThanOrEqual(body.length - 20);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('refuses every ref when the pack cannot be read or is cut short', async () => {
    for (const tail of [
      new TextEncoder().encode('PACK\0\0\0\x09broken'),
      pack.subarray(0, pack.length - 5),
    ]) {
      const refusals: { reason: string }[] = [];
      const guarded = streamOf(HEAD, tail).pipeThrough(
        guardPush({
          headLength: HEAD.length,
          maxCommitBytes: 1024,
          decide: async () => [],
          onRefused: (list) => refusals.push(...list),
          refuseAll: (reason) => [{ ref: 'refs/heads/main', reason }],
        }),
      );
      await expect(readAllBytes(guarded)).rejects.toBeInstanceOf(PushRefused);
      expect(refusals[0]?.reason).toMatch(/pushed pack could not be checked/);
    }
  });
});

describe('holdPush', () => {
  const options = {
    headLength: HEAD.length,
    maxCommitBytes: 1024 * 1024,
    overflow: { refuse: 'too large' },
  };

  it('reads the whole push and scans its pack (property: any chunking)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200 }), async (size) => {
        const body = concatBytes([HEAD, pack]);
        const held = await holdPush(streamOf(...chunks(body, size)), {
          ...options,
          maxPackBytes: pack.length,
        });
        if (held.kind !== 'held') throw new Error(`not held: ${held.kind}`);
        expect(held.body).toEqual(body);
        expect(held.pack).toEqual(pack);
        expect([...held.scan.commits.keys()]).toEqual([commitSha]);
      }),
      { numRuns: 60 },
    );
  });

  it('refuses a pack longer than maxPackBytes, draining the rest of the body', async () => {
    let pulled = 0;
    const parts = chunks(concatBytes([HEAD, pack]), 10);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[pulled];
        pulled += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(part);
      },
    });
    expect(await holdPush(body, { ...options, maxPackBytes: pack.length - 1 })).toEqual({
      kind: 'unheld',
      reason: 'too large',
    });
    expect(pulled).toBe(parts.length + 1);
  });

  it('hands back a pack longer than maxPackBytes to stream, whose guarded scan carries on (property: any chunking)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 200 }), async (size) => {
        const body = concatBytes([HEAD, pack]);
        const held = await holdPush(streamOf(...chunks(body, size)), {
          ...options,
          maxPackBytes: 40,
          overflow: 'stream',
        });
        if (held.kind !== 'overflow') throw new Error(`not overflowing: ${held.kind}`);
        let seen: readonly string[] = [];
        const guarded = held.body.pipeThrough(
          guardPush({
            headLength: HEAD.length,
            maxCommitBytes: 1024 * 1024,
            resume: { scanner: held.scanner, scannedBytes: held.scannedBytes },
            decide: async (scan) => {
              seen = [...scan.commits.keys()];
              return [];
            },
            onRefused: () => undefined,
            refuseAll: (reason) => [{ ref: 'refs/heads/main', reason }],
          }),
        );
        expect(await readAllBytes(guarded)).toEqual(body);
        expect(seen).toEqual([commitSha]);
      }),
      { numRuns: 60 },
    );
  });

  it('refuses a pack that cannot be read or is cut short', async () => {
    for (const tail of [
      new TextEncoder().encode('PACK\0\0\0\x09broken'),
      pack.subarray(0, pack.length - 5),
    ]) {
      const held = await holdPush(streamOf(HEAD, tail), { ...options, maxPackBytes: pack.length });
      expect(held).toEqual({
        kind: 'unheld',
        reason: expect.stringMatching(/pushed pack could not be checked/),
      });
    }
  });
});
