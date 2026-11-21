// SPDX-License-Identifier: Apache-2.0
import type { AuditRefOutcome } from '@leed-ai/git-gateway-contract/proxy/audit-event';
import { concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { parseReportStatus, reportStatusFraming } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';

/** The ref outcomes of a push before the storage host has answered: every update "unknown". */
export function unknownOutcomes(request: ReceivePackRequest): AuditRefOutcome[] {
  return request.commands.map((command) => ({ ...command, status: 'unknown', reason: null }));
}

/** Every update of a push refused with its reason. */
export function rejectedOutcomes(
  request: ReceivePackRequest,
  reasons: ReadonlyMap<string, string>,
  fallback: string,
): AuditRefOutcome[] {
  return request.commands.map((command) => ({
    ...command,
    status: 'rejected',
    reason: reasons.get(command.ref) ?? fallback,
  }));
}

/**
 * Reads up to `maxBytes` of a storage host's receive-pack response (one branch of a tee) and
 * turns its report-status into per-ref outcomes. When the response is larger, unreadable or not a
 * report, every ref is "unknown". Never throws.
 */
export async function readPushOutcomes(
  stream: ReadableStream<Uint8Array>,
  request: ReceivePackRequest,
  maxBytes: number,
): Promise<AuditRefOutcome[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return unknownOutcomes(request);
      }
      chunks.push(next.value);
    }
    const report = parseReportStatus(concatBytes(chunks), reportStatusFraming(request.capabilities));
    const byRef = new Map(report.refs.map((status) => [status.ref, status]));
    return request.commands.map((command) => {
      const status = byRef.get(command.ref);
      if (status === undefined) return { ...command, status: 'unknown', reason: null };
      if (status.status === 'ok' && report.unpack === 'ok') return { ...command, status: 'ok', reason: null };
      const reason = status.status === 'ng' ? status.reason : `unpack failed: ${report.unpack}`;
      return { ...command, status: 'rejected', reason: reason.slice(0, 1000) };
    });
  } catch {
    await reader.cancel().catch(() => undefined);
    return unknownOutcomes(request);
  }
}
