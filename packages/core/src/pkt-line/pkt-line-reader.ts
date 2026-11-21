// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import type { Packet } from '../schemas/packet.ts';
import { readLengthHeader, truncatedPacket } from './length-header.ts';

/** Options for a {@link PktLineReader}. */
export interface PktLineReaderOptions {
  /**
   * The most input bytes the packets read may span. Reading a packet that would end past it
   * throws a malformed_request CoreError before more is pulled, so a hostile stream cannot make
   * the reader buffer without bound: what it keeps for {@link PktLineReader.replay} is at most
   * this much plus the rest of the last chunk the source delivered. Default: no limit.
   */
  readonly maxBytes?: number;
}

/**
 * Reads pkt-lines one at a time from a byte stream, pulling only as many chunks as it needs.
 * Everything pulled from the source is remembered, so the caller can hand the untouched stream
 * on ({@link replay}) or continue with the bytes after the last packet ({@link rest}).
 */
export class PktLineReader {
  readonly #source: ReadableStreamDefaultReader<Uint8Array>;
  readonly #maxBytes: number;
  /** Every chunk pulled from the source so far, in order. */
  readonly #pulled: Uint8Array[] = [];
  #buffer: Uint8Array = new Uint8Array(0);
  #position = 0;
  #ended = false;
  #handedOff = false;

  constructor(stream: ReadableStream<Uint8Array>, options: PktLineReaderOptions = {}) {
    this.#source = stream.getReader();
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  }

  /** Bytes of the input consumed by the packets read so far. */
  get offset(): number {
    return this.#position;
  }

  /** The next packet, or null when the stream ends cleanly between packets. */
  async read(): Promise<Packet | null> {
    if (!(await this.#fill(4))) {
      if (this.#buffer.length === 0) return null;
      throw truncatedPacket(this.#position, 4 - this.#buffer.length);
    }
    const header = readLengthHeader(this.#buffer.subarray(0, 4), this.#position);
    if (header.kind === 'special') {
      this.#consume(4);
      return header.packet;
    }
    const total = 4 + header.payloadLength;
    if (!(await this.#fill(total))) throw truncatedPacket(this.#position, total - this.#buffer.length);
    const payload = this.#buffer.slice(4, total);
    this.#consume(total);
    return { type: 'data', payload };
  }

  /** The whole input from its first byte: what has been read, then the rest of the source. */
  replay(): ReadableStream<Uint8Array> {
    return this.#handOff([...this.#pulled]);
  }

  /** The input after the last packet read: buffered bytes, then the rest of the source. */
  rest(): ReadableStream<Uint8Array> {
    return this.#handOff(this.#buffer.length > 0 ? [this.#buffer] : []);
  }

  /**
   * Gives up on the stream: cancels the source with `reason` and releases its lock, so the
   * caller's stream is not left locked after a failed parse. Does nothing once the stream was
   * handed off, since the handed-off stream then owns the source.
   */
  async cancel(reason?: unknown): Promise<void> {
    if (this.#handedOff) return;
    this.#handedOff = true;
    try {
      await this.#source.cancel(reason);
    } finally {
      this.#source.releaseLock();
    }
  }

  #handOff(prefix: Uint8Array[]): ReadableStream<Uint8Array> {
    if (this.#handedOff) throw new Error('PktLineReader: the stream was already handed off');
    this.#handedOff = true;
    const source = this.#source;
    const ended = this.#ended;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const head = prefix.shift();
        if (head !== undefined) {
          controller.enqueue(head);
          return;
        }
        const next = ended ? { done: true as const } : await source.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return source.cancel(reason);
      },
    });
  }

  /** Pulls chunks until at least `count` bytes are buffered; false if the source ends first. */
  async #fill(count: number): Promise<boolean> {
    if (this.#position + count > this.#maxBytes) {
      throw coreError('malformed_request', 'Too many bytes of pkt-lines', {
        reason: `the pkt-lines run past the ${this.#maxBytes}-byte limit at offset ${this.#position}`,
      });
    }
    while (this.#buffer.length < count && !this.#ended) {
      const next = await this.#source.read();
      if (next.done) {
        this.#ended = true;
        break;
      }
      this.#pulled.push(next.value);
      this.#buffer = this.#buffer.length === 0 ? next.value : concatBytes([this.#buffer, next.value]);
    }
    return this.#buffer.length >= count;
  }

  #consume(count: number): void {
    this.#buffer = this.#buffer.subarray(count);
    this.#position += count;
  }
}
