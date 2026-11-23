// SPDX-License-Identifier: Apache-2.0
import { arrayBufferBacked, utf8 } from './bytes.ts';

/** Lowercase hex SHA-1 of some bytes, through Web Crypto (Bun, Node, Workers and browsers). */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', arrayBufferBacked(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The git blob id of some bytes: SHA-1 of "blob <size>\0" followed by the bytes. */
export async function blobSha(bytes: Uint8Array): Promise<string> {
  const header = utf8(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return sha1Hex(object);
}

/**
 * A deterministic id for a tree or commit of the in-memory model: SHA-1 of the kind and a
 * canonical text form. Equal content gives equal ids; it is not git's object encoding.
 */
export async function modelSha(kind: 'tree' | 'commit', canonical: string): Promise<string> {
  return sha1Hex(utf8(`${kind}\0${canonical}`));
}
