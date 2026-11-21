// SPDX-License-Identifier: Apache-2.0
import { readAllBytes } from '@leed-ai/git-gateway-core/bytes';

/** One request the fake storage host received, its body read in full (or the error reading it). */
export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array | null;
  readonly bodyError: string | null;
}

/** A fake storage host: records requests and answers with what the test scripted. */
export class FakeUpstream {
  readonly received: ReceivedRequest[] = [];
  respond: (request: ReceivedRequest) => Response | Promise<Response> = () =>
    new Response('PACK', {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    });

  /**
   * When true, the host answers as soon as the request arrives and reads the body afterwards, as
   * a host that flushes its headers early would; `bodyRead` settles once that read is over.
   */
  answerBeforeBody = false;
  bodyRead: Promise<void> = Promise.resolve();

  readonly fetch = async (request: Request): Promise<Response> => {
    if (this.answerBeforeBody) return this.#answerEarly(request);
    let body: Uint8Array | null = null;
    let bodyError: string | null = null;
    if (request.body !== null) {
      try {
        body = await readAllBytes(request.body);
      } catch (error) {
        bodyError = error instanceof Error ? error.message : String(error);
      }
    }
    const received = { method: request.method, url: request.url, headers: request.headers, body, bodyError };
    this.received.push(received);
    if (bodyError !== null) throw new Error(`request body failed: ${bodyError}`);
    return this.respond(received);
  };

  async #answerEarly(request: Request): Promise<Response> {
    const head = { method: request.method, url: request.url, headers: request.headers };
    const stream = request.body;
    this.bodyRead =
      stream === null
        ? Promise.resolve()
        : readAllBytes(stream).then(
            (body) => {
              this.received.push({ ...head, body, bodyError: null });
            },
            (error: unknown) => {
              const bodyError = error instanceof Error ? error.message : String(error);
              this.received.push({ ...head, body: null, bodyError });
            },
          );
    return this.respond({ ...head, body: null, bodyError: null });
  }

  /** The last request received. */
  last(): ReceivedRequest {
    const request = this.received.at(-1);
    if (request === undefined) throw new Error('no request reached the upstream');
    return request;
  }
}
