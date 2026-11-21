// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** How file content is carried in a string. */
export const ContentEncoding = z.enum(['text', 'base64']).meta({
  id: 'ContentEncoding',
  title: 'Content encoding',
  description: 'How file content is carried in a JSON string.',
  enumDescriptions: {
    text: 'The string is the file content itself, stored as UTF-8 bytes.',
    base64:
      'The string is standard base64 (RFC 4648, with padding) of the raw file bytes; use for binary files.',
  },
  examples: ['text', 'base64'],
});

/** How file content is carried, inferred from {@link ContentEncoding}. */
export type ContentEncoding = z.infer<typeof ContentEncoding>;

/** The base64 alphabet followed by at most two "=" padding characters. */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Whether a string is standard padded base64 (RFC 4648 §4): a multiple of four characters from the
 * base64 alphabet, with "=" padding only at the end. Checked with a length test and one
 * character-class scan rather than a grouped pattern, so it runs in linear time without recursion
 * and stays safe at the full {@link FileContent} size on every JavaScript engine.
 */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_CHARACTERS.test(value);
}

/** File content as text or base64, at most 48 MiB of characters. */
export const FileContent = z
  .string()
  .max(48 * 1024 * 1024)
  .meta({
    id: 'FileContent',
    title: 'File content',
    description:
      'File content as a string, interpreted according to the accompanying encoding: UTF-8 text, or base64 of the raw bytes. At most 48 MiB of characters (32 MiB of bytes as base64). An empty string is an empty file.',
    examples: ['# Hello\n', 'iVBORw0KGgo='],
  });

/** File content, inferred from {@link FileContent}. */
export type FileContent = z.infer<typeof FileContent>;

/** File content returned by a read, with no length cap. */
export const ReadContent = z.string().meta({
  id: 'ReadContent',
  title: 'Read content',
  description:
    'File content returned by a read, interpreted according to the accompanying encoding: UTF-8 text, or base64 of the raw bytes. Not length-capped: base64 output is 4/3 the size of the bytes and files can arrive over git push at any size, so a read returns whatever the repository holds. An empty string is an empty file.',
  examples: ['# Hello\n', 'iVBORw0KGgo='],
});

/** File content returned by a read, inferred from {@link ReadContent}. */
export type ReadContent = z.infer<typeof ReadContent>;
