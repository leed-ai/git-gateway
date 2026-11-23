// SPDX-License-Identifier: Apache-2.0
import type { ContentEncoding } from '../schemas/content-encoding.ts';

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Standard padded base64 of some bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

/** The bytes a standard padded base64 string encodes; the caller has validated the string. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
}

/** The bytes of content carried in the given encoding. */
export function decodeContent(content: string, encoding: ContentEncoding): Uint8Array {
  return encoding === 'base64' ? fromBase64(content) : utf8(content);
}

/**
 * Content for a read: text when asked for and the bytes are valid UTF-8 that round-trips
 * exactly, base64 otherwise.
 */
export function encodeContent(
  bytes: Uint8Array,
  preferred: ContentEncoding,
): { encoding: ContentEncoding; content: string } {
  if (preferred === 'text') {
    try {
      return { encoding: 'text', content: strictDecoder.decode(bytes) };
    } catch {
      // Not valid UTF-8: fall through to base64.
    }
  }
  return { encoding: 'base64', content: toBase64(bytes) };
}

/** True when two byte arrays hold the same bytes. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

/** Compares two strings by their UTF-8 bytes, the order git sorts paths in. */
export function byteOrder(a: string, b: string): number {
  const left = utf8(a);
  const right = utf8(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * The same bytes as a view over an `ArrayBuffer`, which Web Crypto and Web Streams require: the
 * array itself when an `ArrayBuffer` backs it (any array not built over shared memory), otherwise
 * a copy. Checks the buffer's tag rather than `instanceof`, which fails across realms.
 */
export function arrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return isArrayBufferBacked(bytes) ? bytes : new Uint8Array(bytes);
}

function isArrayBufferBacked(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return Object.prototype.toString.call(bytes.buffer) === '[object ArrayBuffer]';
}
