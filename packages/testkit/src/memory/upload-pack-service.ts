// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { decodePktLines, packetText } from '@leed-ai/git-gateway-core/pkt-line/decode';
import { encodePktLine, FLUSH_PKT } from '@leed-ai/git-gateway-core/pkt-line/encode';
import { writePack } from '@leed-ai/git-gateway-core/pack/write-pack';
import { encodeErrPacket } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import {
  BAND_DATA,
  encodeSideBand,
  SIDE_BAND_64K_MAX_PAYLOAD,
  SIDE_BAND_MAX_PAYLOAD,
} from '@leed-ai/git-gateway-core/receive-pack/side-band';
import { encodeRefAdvertisement } from '@leed-ai/git-gateway-core/smart-http/ref-advertisement';

import type { MemoryRepository } from './memory-repository.ts';
import { selectPack } from './pack-selection.ts';

/** The capabilities the in-memory upload-pack offers: whole-object packs, shallow (deepen) and filter. */
export const UPLOAD_PACK_CAPABILITIES: readonly string[] = [
  'side-band',
  'side-band-64k',
  'no-progress',
  'shallow',
  'filter',
  'allow-reachable-sha1-in-want',
  'object-format=sha1',
  'agent=git-gateway-testkit',
];

/** The upload-pack ref advertisement: HEAD (when the default branch exists), then every ref in name order. */
export function uploadPackAdvertisement(repo: MemoryRepository): Uint8Array {
  const names = [...repo.refs.keys()].toSorted();
  const head = repo.refs.get(repo.headRef);
  const refs = names.map((name) => ({ name, sha: repo.refs.get(name) ?? '', peeled: null }));
  return encodeRefAdvertisement({
    service: 'git-upload-pack',
    refs: head === undefined ? refs : [{ name: 'HEAD', sha: head, peeled: null }, ...refs],
    capabilities: [...UPLOAD_PACK_CAPABILITIES],
    symrefs: head === undefined ? {} : { HEAD: repo.headRef },
  });
}

interface Negotiation {
  readonly wants: string[];
  readonly haves: string[];
  readonly capabilities: string[];
  readonly clientShallow: string[];
  readonly depth: number | undefined;
  readonly filter: string | undefined;
  /** How the request ended after the wants: "done", a flush closing a round of haves, or nothing. */
  readonly end: 'done' | 'flush' | 'none';
}

/**
 * Reads a stateless upload-pack request: the wants (with capabilities, shallow, deepen and filter
 * lines) up to a flush, then have lines up to a flush or "done". A request that stops right after
 * the wants' flush only asks for the shallow list.
 */
function readNegotiation(body: Uint8Array): Negotiation | string {
  const wants: string[] = [];
  const haves: string[] = [];
  const capabilities: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let filter: string | undefined;
  let section: 'needs' | 'haves' = 'needs';
  let end: Negotiation['end'] = 'none';
  for (const packet of decodePktLines(body)) {
    const line = packetText(packet);
    if (line === null) {
      if (section === 'needs') section = 'haves';
      else end = 'flush';
      continue;
    }
    const [verb, argument = '', ...rest] = line.split(' ');
    if (section === 'needs' && verb === 'want') {
      if (wants.length === 0) capabilities.push(...rest);
      wants.push(argument);
    } else if (section === 'needs' && verb === 'shallow') clientShallow.push(argument);
    else if (section === 'needs' && verb === 'deepen' && /^[1-9]\d*$/.test(argument))
      depth = Number(argument);
    else if (section === 'needs' && verb === 'filter') filter = argument;
    else if (section === 'haves' && verb === 'have') haves.push(argument);
    else if (section === 'haves' && line === 'done') end = 'done';
    else return `unsupported upload-pack line: ${line.slice(0, 60)}`;
  }
  return { wants, haves, capabilities, clientShallow, depth, filter, end };
}

function frame(capabilities: readonly string[], pack: Uint8Array): Uint8Array {
  if (capabilities.includes('side-band-64k')) {
    return concatBytes([encodeSideBand(BAND_DATA, pack, SIDE_BAND_64K_MAX_PAYLOAD), FLUSH_PKT]);
  }
  if (capabilities.includes('side-band'))
    return concatBytes([encodeSideBand(BAND_DATA, pack, SIDE_BAND_MAX_PAYLOAD), FLUSH_PKT]);
  return pack;
}

/**
 * Answers one stateless upload-pack request. A deepen first gets its shallow lines and a flush;
 * a request that ends right after its wants gets nothing more. Otherwise, without "done" the
 * answer acknowledges the first common have ("ACK <id>") or sends "NAK", and the client goes on; with "done" it sends that acknowledgement and a pack of every object
 * reachable from the wants but not from the common haves — cut at the deepen, filtered — on
 * side-band channel 1 when the client asked for side-band. Any object reachable from a ref may be
 * wanted (allow-reachable-sha1-in-want).
 */
export async function answerUploadPack(repo: MemoryRepository, body: Uint8Array): Promise<Uint8Array> {
  const negotiation = readNegotiation(body);
  if (typeof negotiation === 'string') return encodeErrPacket(negotiation);
  const reachableFromRefs = new Set(repo.reachable([...repo.refs.values()], []).map((object) => object.sha));
  const unknown = negotiation.wants.find((want) => !reachableFromRefs.has(want));
  if (unknown !== undefined) return encodeErrPacket(`upload-pack: not our ref ${unknown}`);
  const common = negotiation.haves.filter((have) => repo.objects.has(have));
  const selected = selectPack(repo, {
    wants: negotiation.wants,
    haves: common,
    clientShallow: negotiation.clientShallow,
    ...(negotiation.depth === undefined ? {} : { depth: negotiation.depth }),
    ...(negotiation.filter === undefined ? {} : { filter: negotiation.filter }),
  });
  const parts: Uint8Array[] = [];
  if (negotiation.depth !== undefined) {
    for (const sha of selected.shallow) parts.push(encodePktLine(`shallow ${sha}\n`));
    for (const sha of selected.unshallow) parts.push(encodePktLine(`unshallow ${sha}\n`));
    parts.push(FLUSH_PKT);
  }
  if (negotiation.end === 'none') return concatBytes(parts);
  parts.push(common[0] === undefined ? encodePktLine('NAK\n') : encodePktLine(`ACK ${common[0]}\n`));
  if (negotiation.end === 'done')
    parts.push(frame(negotiation.capabilities, await writePack(selected.objects)));
  return concatBytes(parts);
}
