// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { serveFetchHandler } from '../../src/node/serve-fetch-handler.ts';

describe('serveFetchHandler', () => {
  it('serves a fetch handler over HTTP, bodies and headers included', async () => {
    const server = await serveFetchHandler(
      async (request) =>
        new Response(
          `${request.method} ${new URL(request.url).pathname} ${await request.text()} ${request.headers.get('x-test') ?? ''}`,
          {
            status: 201,
            headers: { 'X-Reply': 'yes' },
          },
        ),
    );
    try {
      const got = await fetch(`${server.url}/path`, {
        method: 'POST',
        body: 'payload',
        headers: { 'X-Test': 'header' },
      });
      expect(got.status).toBe(201);
      expect(got.headers.get('x-reply')).toBe('yes');
      expect(await got.text()).toBe('POST /path payload header');
      expect(await (await fetch(`${server.url}/get`)).text()).toBe('GET /get  ');
    } finally {
      await server.close();
    }
  });

  it('answers 500 when the handler throws', async () => {
    const server = await serveFetchHandler(async () => {
      throw new Error('boom');
    });
    try {
      const got = await fetch(server.url);
      expect(got.status).toBe(500);
      expect(await got.text()).toBe('boom');
    } finally {
      await server.close();
    }
  });
});
