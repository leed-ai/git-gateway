// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { concatBytes } from '../bytes.ts';
import { coreError } from '../core-error.ts';
import { decodePktLines, packetText } from '../pkt-line/decode.ts';
import { encodePktLine, FLUSH_PKT } from '../pkt-line/encode.ts';
import type { Packet } from '../schemas/packet.ts';
import { AdvertisedRef, GitService, RefAdvertisement } from '../schemas/ref-advertisement.ts';

const REF_LINE = /^([0-9a-f]{40}) (\S+)$/;
const NO_REFS = 'capabilities^{}';

function malformed(reason: string): Error {
  return coreError('malformed_request', 'Malformed ref advertisement', { reason });
}

/** The capabilities and symrefs of a first line's capability list. */
function readCapabilities(text: string): { capabilities: string[]; symrefs: Record<string, string> } {
  const capabilities = text.split(' ').filter((token) => token.length > 0);
  const symrefs: Record<string, string> = {};
  for (const capability of capabilities) {
    if (!capability.startsWith('symref=')) continue;
    const [from, to] = capability.slice('symref='.length).split(':');
    if (from !== undefined && to !== undefined && from !== '' && to.startsWith('refs/')) symrefs[from] = to;
  }
  return { capabilities, symrefs };
}

/** Drops the "# service=…" line and the flush after it, when present (smart HTTP sends them). */
function dropServiceHeader(packets: readonly Packet[], service: GitService): readonly Packet[] {
  const first = packets[0];
  const text = first === undefined ? null : packetText(first);
  if (text === null || !text.startsWith('# service=')) return packets;
  if (text !== `# service=${service}`)
    throw malformed(`expected service ${service}, got "${text.slice(10)}"`);
  return packets[1]?.type === 'flush' ? packets.slice(2) : packets.slice(1);
}

/**
 * Parses a protocol v0/v1 ref advertisement — the body of GET info/refs?service=… — into refs,
 * capabilities and symrefs. Accepts the smart-HTTP "# service=…" preamble and the
 * "capabilities^{}" line an empty repository sends. Throws malformed_request for anything else,
 * and unsupported_request for a protocol v2 capability advertisement.
 */
export function parseRefAdvertisement(body: Uint8Array, service: GitService): RefAdvertisement {
  const packets = dropServiceHeader(decodePktLines(body), GitService.parse(service));
  const refs: AdvertisedRef[] = [];
  let capabilityText: string | null = null;
  for (const packet of packets) {
    if (packet.type === 'flush') break;
    let line = packetText(packet);
    if (line === null) throw malformed(`unexpected ${packet.type} packet`);
    if (line === 'version 2')
      throw coreError('unsupported_request', 'Protocol v2 advertisement', { feature: 'protocol-v2' });
    if (line === 'version 1') continue;
    if (capabilityText === null) {
      const nul = line.indexOf('\0');
      capabilityText = nul === -1 ? '' : line.slice(nul + 1);
      line = nul === -1 ? line : line.slice(0, nul);
    }
    const match = REF_LINE.exec(line);
    if (match === null) throw malformed(`ref line ${JSON.stringify(line)} is not "<id> <ref>"`);
    const [, sha = '', name = ''] = match;
    if (name === NO_REFS && sha === ZERO_SHA) continue;
    if (name.endsWith('^{}')) {
      const tagged = refs.at(-1);
      if (tagged?.name !== name.slice(0, -3))
        throw malformed(`peeled line for ${name} does not follow its tag`);
      refs[refs.length - 1] = { ...tagged, peeled: sha };
      continue;
    }
    const parsed = AdvertisedRef.safeParse({ name, sha, peeled: null });
    if (!parsed.success) throw malformed(`bad ref name ${JSON.stringify(name)}`);
    refs.push(parsed.data);
  }
  return RefAdvertisement.parse({ service, refs, ...readCapabilities(capabilityText ?? '') });
}

/**
 * Encodes a smart-HTTP ref advertisement: the "# service=…" preamble and flush, then each ref
 * (capabilities after a NUL on the first; a peeled "<ref>^{}" line after an annotated tag), or the
 * "capabilities^{}" line when there are no refs, then a flush. `symrefs` are added to the
 * capabilities as "symref=<from>:<to>".
 */
export function encodeRefAdvertisement(advertisement: RefAdvertisement): Uint8Array {
  const { service, refs, capabilities, symrefs } = RefAdvertisement.parse(advertisement);
  const caps = [
    ...capabilities.filter((capability) => !capability.startsWith('symref=')),
    ...Object.entries(symrefs).map(([from, to]) => `symref=${from}:${to}`),
  ].join(' ');
  const lines: Uint8Array[] = [encodePktLine(`# service=${service}\n`), FLUSH_PKT];
  if (refs.length === 0) lines.push(encodePktLine(`${ZERO_SHA} ${NO_REFS}\0${caps}\n`));
  refs.forEach((ref, index) => {
    lines.push(encodePktLine(index === 0 ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`));
    if (ref.peeled !== null) lines.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
  });
  lines.push(FLUSH_PKT);
  return concatBytes(lines);
}
