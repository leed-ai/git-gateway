// SPDX-License-Identifier: Apache-2.0

/** The trailer the gateway appends to every commit made with an idempotency key. */
export const IDEMPOTENCY_TRAILER = 'Gateway-Idempotency-Key';

const TRAILER_LINE = new RegExp(`^${IDEMPOTENCY_TRAILER}: ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`, 'm');

/** The message with the idempotency trailer appended as its last paragraph. */
export function appendIdempotencyTrailer(message: string, key: string): string {
  return `${message.trimEnd()}\n\n${IDEMPOTENCY_TRAILER}: ${key}\n`;
}

/** The idempotency key in a message's trailer, or null when it has none. */
export function readIdempotencyTrailer(message: string): string | null {
  const lines = message.trimEnd().split('\n');
  const last = lines.at(-1) ?? '';
  return TRAILER_LINE.exec(last)?.[1] ?? null;
}
