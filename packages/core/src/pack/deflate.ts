// SPDX-License-Identifier: Apache-2.0
import { arrayBufferBacked, readAllBytes } from '../bytes.ts';

/** Runs bytes through a Web Streams compression transform and collects the output. */
async function transform(
  stream: CompressionStream | DecompressionStream,
  data: Uint8Array,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Write and read concurrently: awaiting the write first would deadlock on backpressure.
  const writing = writer.write(arrayBufferBacked(data)).then(async () => writer.close());
  const [output] = await Promise.all([readAllBytes(stream.readable), writing]);
  return output;
}

/** zlib-compresses bytes (RFC 1950, the format git stores pack entries in) via `CompressionStream`. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return transform(new CompressionStream('deflate'), data);
}

/** Reverses {@link deflate} via `DecompressionStream`. */
export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return transform(new DecompressionStream('deflate'), data);
}
