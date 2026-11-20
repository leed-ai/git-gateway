// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';

import { bytesToHex, concatBytes, sha1Bytes } from '../bytes.ts';
import { GitObjectType, type GitObject } from '../schemas/git-object.ts';

/** The loose-object form of an object: "<type> <size>\0" followed by its content. */
export function objectBytes(type: GitObjectType, data: Uint8Array): Uint8Array {
  return concatBytes([utf8(`${GitObjectType.parse(type)} ${data.length}\0`), data]);
}

/** The id git gives an object, exactly as `git hash-object -t <type>` computes it. */
export async function hashObject(type: GitObjectType, data: Uint8Array): Promise<string> {
  return bytesToHex(await sha1Bytes(objectBytes(type, data)));
}

/** A {@link GitObject} for some content, with its id computed. */
export async function createObject(type: GitObjectType, data: Uint8Array): Promise<GitObject> {
  return { type, sha: await hashObject(type, data), data };
}
