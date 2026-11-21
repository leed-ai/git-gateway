// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '../bytes.ts';
import { encodePktLine, FLUSH_PKT } from '../pkt-line/encode.ts';
import { UploadPackRequest, type UploadPackRequestInput } from '../schemas/upload-pack.ts';

/**
 * Encodes a stateless protocol v0/v1 git-upload-pack request body: "want" lines (capabilities on
 * the first), "deepen" and "filter" lines when asked for, a flush, the "have" lines, then "done".
 * Sending "done" in the first round asks the server for the pack straight away, which is what a
 * smart-HTTP client that needs specific objects (not a minimal pack) wants.
 */
export function encodeUploadPackRequest(request: UploadPackRequestInput): Uint8Array {
  const parsed = UploadPackRequest.parse(request);
  const capabilities = [...parsed.capabilities];
  if (parsed.depth !== undefined && !capabilities.includes('shallow')) capabilities.push('shallow');
  if (parsed.filter !== undefined && !capabilities.includes('filter')) capabilities.push('filter');
  const wants = [...new Set(parsed.wants)];
  const firstSuffix = capabilities.length > 0 ? ` ${capabilities.join(' ')}` : '';
  const lines: Uint8Array[] = wants.map((want, index) =>
    encodePktLine(index === 0 ? `want ${want}${firstSuffix}\n` : `want ${want}\n`),
  );
  if (parsed.depth !== undefined) lines.push(encodePktLine(`deepen ${parsed.depth}\n`));
  if (parsed.filter !== undefined) lines.push(encodePktLine(`filter ${parsed.filter}\n`));
  lines.push(FLUSH_PKT);
  for (const have of new Set(parsed.haves)) lines.push(encodePktLine(`have ${have}\n`));
  lines.push(encodePktLine('done\n'));
  return concatBytes(lines);
}
