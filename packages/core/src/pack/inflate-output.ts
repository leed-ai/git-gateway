// SPDX-License-Identifier: Apache-2.0
import { invalid } from './bit-reader.ts';

const WINDOW = 32_768;
const MASK = WINDOW - 1;
const ADLER_MOD = 65_521;

/**
 * Where a streaming inflater writes: DEFLATE's 32 KiB sliding window for back-references, a
 * running Adler-32, and — only when asked — the whole output up to a size limit.
 */
export class InflateOutput {
  readonly #window = new Uint8Array(WINDOW);
  readonly #keep: number;
  #kept: Uint8Array;
  #length = 0;
  #a = 1;
  #b = 0;
  /** Bytes added to `#a`/`#b` since they were last reduced; reduced before 5552 to stay exact. */
  #pending = 0;

  /** `keep`: keep up to this many output bytes for {@link result}; absent keeps only the window. */
  constructor(keep?: number) {
    this.#keep = keep ?? 0;
    this.#kept = new Uint8Array(Math.min(this.#keep, 4096));
  }

  /** Total bytes written. */
  get length(): number {
    return this.#length;
  }

  push(byte: number): void {
    this.#window[this.#length & MASK] = byte;
    if (this.#keep > 0) this.#store(byte);
    this.#length += 1;
    this.#a += byte;
    this.#b += this.#a;
    this.#pending += 1;
    if (this.#pending === 5552) this.#reduce();
  }

  append(bytes: Uint8Array, offset: number): void {
    if (this.#keep > 0 && this.#length + bytes.length > this.#keep) this.#overflow(offset);
    for (const byte of bytes) this.push(byte);
  }

  /** Copies `count` bytes from `distance` back in the output. */
  copy(distance: number, count: number, offset: number): void {
    if (distance > this.#length || distance > WINDOW) {
      throw invalid(`back-reference distance ${distance} exceeds the output`, offset);
    }
    for (let index = 0; index < count; index += 1)
      this.push(this.#window[(this.#length - distance) & MASK] ?? 0);
  }

  /** The Adler-32 of everything written. */
  adler32(): number {
    this.#reduce();
    return ((this.#b << 16) | this.#a) >>> 0;
  }

  /** The kept output. */
  result(): Uint8Array {
    return this.#kept.slice(0, Math.min(this.#length, this.#keep));
  }

  #reduce(): void {
    this.#a %= ADLER_MOD;
    this.#b %= ADLER_MOD;
    this.#pending = 0;
  }

  #store(byte: number): void {
    if (this.#length >= this.#keep) this.#overflow(0);
    if (this.#length >= this.#kept.length) {
      const grown = new Uint8Array(Math.min(this.#keep, Math.max(this.#kept.length * 2, 64)));
      grown.set(this.#kept);
      this.#kept = grown;
    }
    this.#kept[this.#length] = byte;
  }

  #overflow(offset: number): never {
    throw invalid(`the stream inflates to more than the ${this.#keep} bytes kept`, offset);
  }
}
