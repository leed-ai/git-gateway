// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { encodePktLine, FLUSH_PKT } from '../pkt-line/encode.ts';
import { ReceivePackPush, type ReceivePackPushInput } from '../schemas/receive-pack.ts';

/**
 * Encodes a protocol v1 git-receive-pack request body: the update commands (capabilities after a
 * NUL on the first) and a flush, then push options and a flush when any are given, then the pack.
 * The server applies the commands only if each ref still names its `oldSha`, which is what makes
 * a gateway commit safe against concurrent writers.
 */
export function encodeReceivePackRequest(push: ReceivePackPushInput): Uint8Array {
  const { commands, capabilities, pushOptions, pack } = ReceivePackPush.parse(push);
  const requested =
    pushOptions.length > 0 && !capabilities.includes('push-options')
      ? [...capabilities, 'push-options']
      : capabilities;
  const parts: Uint8Array[] = commands.map((command, index) => {
    const line = `${command.oldSha} ${command.newSha} ${command.ref}`;
    return encodePktLine(index === 0 ? `${line}\0${requested.join(' ')}\n` : `${line}\n`);
  });
  parts.push(FLUSH_PKT);
  if (pushOptions.length > 0) {
    for (const option of pushOptions) parts.push(encodePktLine(`${option}\n`));
    parts.push(FLUSH_PKT);
  }
  if (pack !== undefined) parts.push(pack);
  return concatBytes(parts);
}
