// SPDX-License-Identifier: Apache-2.0
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';
import { streamOf } from '@leed-ai/git-gateway-core/bytes';
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { readPack } from '@leed-ai/git-gateway-core/pack/read-pack';
import { readLengthHeader } from '@leed-ai/git-gateway-core/pkt-line/length-header';
import { parseReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/parse-request';
import {
  encodeErrPacket,
  encodeReportStatus,
  reportStatusFraming,
} from '@leed-ai/git-gateway-core/receive-pack/report-status';
import type { ReceivePackCommand, ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';
import type { RefStatus } from '@leed-ai/git-gateway-core/schemas/report-status';
import { encodeRefAdvertisement } from '@leed-ai/git-gateway-core/smart-http/ref-advertisement';

import type { MemoryRepository } from './memory-repository.ts';

/** The capabilities the in-memory receive-pack offers, as git's own receive-pack does. */
export const RECEIVE_PACK_CAPABILITIES: readonly string[] = [
  'report-status',
  'delete-refs',
  'side-band-64k',
  'quiet',
  'atomic',
  'ofs-delta',
  'push-options',
  'object-format=sha1',
  'agent=git-gateway-testkit',
];

/** The receive-pack ref advertisement: every ref in name order (no HEAD, as git sends it). */
export function receivePackAdvertisement(repo: MemoryRepository): Uint8Array {
  return encodeRefAdvertisement({
    service: 'git-receive-pack',
    refs: [...repo.refs.keys()]
      .toSorted()
      .map((name) => ({ name, sha: repo.refs.get(name) ?? '', peeled: null })),
    capabilities: [...RECEIVE_PACK_CAPABILITIES],
    symrefs: {},
  });
}

/** Where the pack starts: after the shallow lines, the command list and the push options. */
function packOffset(body: Uint8Array, request: ReceivePackRequest): number {
  let flushes = request.capabilities.includes('push-options') ? 2 : 1;
  let offset = 0;
  while (flushes > 0 && offset + 4 <= body.length) {
    const header = readLengthHeader(body.subarray(offset, offset + 4), offset);
    if (header.kind === 'special') {
      flushes -= 1;
      offset += 4;
    } else offset += 4 + header.payloadLength;
  }
  return offset;
}

/** Why a command cannot apply to the repository as it stands, or null when it can. */
function refuse(repo: MemoryRepository, command: ReceivePackCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_SHA;
  if (command.oldSha === ZERO_SHA && command.newSha === ZERO_SHA) return 'nothing to do';
  if (current !== command.oldSha) {
    return `cannot lock ref '${command.ref}': is at ${current} but expected ${command.oldSha}`;
  }
  if (command.newSha === ZERO_SHA) return null;
  const target = repo.object(command.newSha);
  if (target === null) return 'missing necessary objects';
  if (command.ref.startsWith('refs/heads/') && target.type !== 'commit')
    return 'branch must point at a commit';
  if (repo.missingFrom([command.newSha]).length > 0) return 'missing necessary objects';
  return null;
}

/** Unpacks the pack, if any, into the repository; returns the unpack status line. */
async function unpack(
  repo: MemoryRepository,
  body: Uint8Array,
  offset: number,
  needsPack: boolean,
): Promise<string> {
  const pack = body.subarray(offset);
  if (pack.length === 0) return needsPack ? 'unpack-objects abnormal exit' : 'ok';
  try {
    repo.put(await readPack(pack, { lookupBase: async (sha) => repo.object(sha) }));
    return 'ok';
  } catch (error) {
    return isCoreError(error) ? error.message.replaceAll('\n', ' ') : 'unpack-objects abnormal exit';
  }
}

/**
 * Applies one receive-pack request (protocol v0/v1) to an in-memory repository, the way git's
 * receive-pack does on a bare repository: unpack the pack, then update each ref only if it still
 * names the command's old id (a stale old id is refused with "cannot lock ref"). Non-fast-forward
 * updates with a matching old id are accepted, as git accepts them unless
 * receive.denyNonFastForwards is set. "atomic" applies all commands or none. Ref checks and
 * updates run without an await between them, so concurrent pushes to one ref cannot both win.
 */
export async function answerReceivePack(repo: MemoryRepository, body: Uint8Array): Promise<Uint8Array> {
  let request: ReceivePackRequest;
  try {
    request = (await parseReceivePackRequest(streamOf(body))).request;
  } catch (error) {
    return encodeErrPacket(error instanceof Error ? error.message : 'malformed request');
  }
  const framing = reportStatusFraming(
    request.capabilities.filter((capability) => RECEIVE_PACK_CAPABILITIES.includes(capability)),
  );
  const needsPack = request.commands.some((command) => command.newSha !== ZERO_SHA);
  const unpackStatus = await unpack(repo, body, packOffset(body, request), needsPack);
  let refs: RefStatus[];
  if (unpackStatus !== 'ok') {
    refs = request.commands.map((command) => ({ ref: command.ref, status: 'ng', reason: 'unpacker error' }));
  } else {
    refs = applyCommands(repo, request.commands, request.capabilities.includes('atomic'));
  }
  if (!request.capabilities.includes('report-status')) return new Uint8Array(0);
  return encodeReportStatus({ unpack: unpackStatus, refs }, framing);
}

function applyCommands(
  repo: MemoryRepository,
  commands: readonly ReceivePackCommand[],
  atomic: boolean,
): RefStatus[] {
  const reasons = commands.map((command) => refuse(repo, command));
  if (atomic && reasons.some((reason) => reason !== null)) {
    return commands.map((command, index) => ({
      ref: command.ref,
      status: 'ng',
      reason: reasons[index] ?? 'atomic transaction failed',
    }));
  }
  return commands.map((command, index) => {
    const reason = reasons[index];
    if (reason !== null && reason !== undefined) return { ref: command.ref, status: 'ng', reason };
    if (command.newSha === ZERO_SHA) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newSha);
    return { ref: command.ref, status: 'ok' };
  });
}
