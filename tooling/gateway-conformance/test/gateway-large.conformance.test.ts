// SPDX-License-Identifier: Apache-2.0
import { randomFillSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { startGatewayHarness, type GatewayHarness } from './gateway-harness.ts';

// A 50 MB push and clone through the gateway. The gateway must stream both: it may hold only a
// few chunks at a time, never the pack. The push goes to the protected main branch, so the gateway
// scans the whole pack as it streams to prove the update is a fast-forward.

const SIZE = 50 * 1024 * 1024;
/** Far below the pack size and a Worker's 128 MB: a handful of 64 KiB chunks plus the push head. */
const MAX_HELD = 4 * 1024 * 1024;

let h: GatewayHarness;

beforeAll(async () => {
  h = await startGatewayHarness();
});

afterAll(async () => h.close());

describe('large transfers through the gateway', () => {
  it('pushes and clones 50 MB without holding more than a few chunks', { timeout: 180_000 }, async () => {
    const url = await h.repo('large');
    const work = h.sandbox.path('large-work');
    expect((await h.git('alice', ['clone', '-q', url, work])).status).toBe(0);
    writeFileSync(`${work}/README.md`, 'large\n');
    await h.sandbox.ok(['add', '-A'], { cwd: work });
    await h.sandbox.ok(['commit', '-q', '-m', 'seed'], { cwd: work });
    expect((await h.git('alice', ['push', '-q', 'origin', 'main'], work)).status).toBe(0);

    const content = randomFillSync(Buffer.alloc(SIZE));
    writeFileSync(`${work}/large.bin`, content);
    await h.sandbox.ok(['add', '-A'], { cwd: work });
    await h.sandbox.ok(['commit', '-q', '-m', 'large'], { cwd: work });
    const head = await h.sandbox.ok(['rev-parse', 'HEAD'], { cwd: work });
    h.pushFlight.reset();
    const pushed = await h.git('alice', ['push', 'origin', 'main'], work);
    expect(pushed.status).toBe(0);
    expect(await h.backend.resolveRef('large', 'main')).toBe(head);
    expect(h.logs).toContain('proving fast-forwards from the pushed pack');
    expect(h.pushFlight.max).toBeGreaterThan(0);
    expect(h.pushFlight.max).toBeLessThan(MAX_HELD);

    h.fetchFlight.reset();
    const copy = h.sandbox.path('large-copy');
    expect((await h.git('reader', ['clone', '-q', url, copy])).status).toBe(0);
    expect(readFileSync(`${copy}/large.bin`).equals(content)).toBe(true);
    expect(h.fetchFlight.max).toBeGreaterThan(0);
    expect(h.fetchFlight.max).toBeLessThan(MAX_HELD);
  });
});
