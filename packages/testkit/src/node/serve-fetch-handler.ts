// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** A fetch-style request handler, such as `MemoryBackend.handle` or a Worker's `fetch`. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** A running local HTTP server. */
export interface LocalServer {
  /** Base URL, e.g. "http://127.0.0.1:43210". */
  readonly url: string;
  /** Stops accepting connections and resolves once the server has closed. */
  close(): Promise<void>;
}

async function readBody(message: IncomingMessage): Promise<Uint8Array | null> {
  if (message.method === 'GET' || message.method === 'HEAD') return null;
  const chunks: Uint8Array[] = [];
  for await (const chunk of message)
    chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
  return new Uint8Array(Buffer.concat(chunks));
}

async function toRequest(message: IncomingMessage, base: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const body = await readBody(message);
  return new Request(new URL(message.url ?? '/', base), {
    method: message.method ?? 'GET',
    headers,
    ...(body === null ? {} : { body }),
  });
}

async function send(response: Response, out: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  out.writeHead(response.status, headers);
  out.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Serves a fetch-style handler over plain HTTP on 127.0.0.1 (a random free port unless one is
 * given), so a real git client can talk to an in-process server such as the in-memory backend.
 * Request bodies are buffered before the handler runs; a thrown handler answers 500.
 */
export async function serveFetchHandler(handler: FetchHandler, port = 0): Promise<LocalServer> {
  let base = 'http://127.0.0.1';
  const server = createServer((message, out) => {
    toRequest(message, base)
      .then(handler)
      .then(async (response) => send(response, out))
      .catch((error: unknown) => {
        out.writeHead(500, { 'Content-Type': 'text/plain' });
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
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
