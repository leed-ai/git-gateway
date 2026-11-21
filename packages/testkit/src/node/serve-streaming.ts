// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { FetchHandler, LocalServer } from './serve-fetch-handler.ts';

/** Byte counts a {@link serveStreaming} server reports as traffic flows. */
export interface StreamingTraffic {
  /** Called with each chunk of a request body as it is handed to the handler. */
  readonly onRequestChunk?: (bytes: number) => void;
  /** Called with each chunk of a response body once the socket has accepted it. */
  readonly onResponseChunk?: (bytes: number) => void;
}

/**
 * The request body as a stream that pulls from the socket only as the handler reads: the socket
 * is paused whenever a chunk is waiting, so nothing piles up in memory.
 */
function requestBody(message: IncomingMessage, traffic: StreamingTraffic): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        message.pause();
        message.on('data', (chunk: Buffer) => {
          message.pause();
          traffic.onRequestChunk?.(chunk.length);
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
        });
        message.on('end', () => controller.close());
        message.on('error', (error) => controller.error(error));
      },
      pull() {
        message.resume();
      },
      cancel() {
        message.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

function toRequest(message: IncomingMessage, base: string, traffic: StreamingTraffic): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = message.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = requestBody(message, traffic);
    init.duplex = 'half';
  }
  return new Request(new URL(message.url ?? '/', base), init);
}

/** Writes a response chunk by chunk, waiting for the socket to drain, so it is never buffered whole. */
async function send(response: Response, out: ServerResponse, traffic: StreamingTraffic): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  out.writeHead(response.status, headers);
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if (!out.write(next.value)) await once(out, 'drain');
      traffic.onResponseChunk?.(next.value.length);
    }
  }
  out.end();
}

/**
 * Serves a fetch-style handler (a Worker's `fetch`, a Hono app) over plain HTTP on 127.0.0.1 with
 * request and response bodies streamed in both directions under backpressure — as the Workers
 * runtime streams them — so a real git client can drive the gateway and tests can observe how much
 * it holds at once. A thrown handler answers 500.
 */
export async function serveStreaming(
  handler: FetchHandler,
  traffic: StreamingTraffic = {},
  port = 0,
): Promise<LocalServer> {
  let base = 'http://127.0.0.1';
  const server = createServer((message, out) => {
    handler(toRequest(message, base, traffic))
      .then(async (response) => send(response, out, traffic))
      .catch((error: unknown) => {
        if (!out.headersSent) out.writeHead(500, { 'Content-Type': 'text/plain' });
        out.end(error instanceof Error ? error.message : 'internal error');
      });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no TCP address');
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
