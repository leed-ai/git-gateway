// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { drain } from '../src/policy/enforce-branch-policy.ts';

/** A stream of `count` chunks of `size` bytes that records how far it was read and whether it was cancelled. */
function counted(count: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === count) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

describe('drain', () => {
  it('reads a short body to its end', async () => {
    const { stream, state } = counted(3, 10);
    await drain(stream, 100);
    expect(state.pulled).toBe(3);
    expect(state.cancelled).toBe(false);
  });

  it('stops and cancels the rest once more than the limit has been read', async () => {
    const { stream, state } = counted(1000, 10);
    await drain(stream, 25);
    expect(state.pulled).toBe(3);
    expect(state.cancelled).toBe(true);
  });

  it('swallows a read error from a client that hung up', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    await expect(drain(stream)).resolves.toBeUndefined();
  });
});
