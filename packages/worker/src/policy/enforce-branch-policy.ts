// SPDX-License-Identifier: Apache-2.0
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { PktLineReader } from '@leed-ai/git-gateway-core/pkt-line/pkt-line-reader';
import { parseReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/parse-request';
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';
import type { MiddlewareHandler } from 'hono';

import { rejectedOutcomes, unknownOutcomes } from '../audit/push-report.ts';
import { deferWith } from '../proxy/defer.ts';
import type { GatewayDeps } from '../proxy/gateway-deps.ts';
import type { GatewayEnv } from '../proxy/gateway-env.ts';
import { errResponse, NO_CACHE, refusePush, textResponse, type RefRefusal } from '../proxy/git-responses.ts';
import { judgePush, reasonLine } from './branch-policy.ts';

/** The reason given for an update refused only because another update of the same push was. */
export const COLLATERAL_REASON = 'not updated: another update in this push was refused';

/** Most bytes of a refused push read and discarded before it is answered. */
export const MAX_DRAIN_BYTES = 16 * 1024 * 1024;

/**
 * Reads and discards what remains of a refused push, so a client that is still sending gets its
 * answer instead of a reset connection — but at most `limit` bytes, after which the rest is
 * cancelled. Read errors (a client that hung up) are swallowed: the answer is already decided.
 */
export async function drain(stream: ReadableStream<Uint8Array>, limit = MAX_DRAIN_BYTES): Promise<void> {
  const reader = stream.getReader();
  let read = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      read += next.value.length;
      if (read > limit) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  }
}

/** Every update of a push refused: the given refusals, and the collateral reason for the rest. */
export function refuseAll(request: ReceivePackRequest, refusals: readonly RefRefusal[]): RefRefusal[] {
  const byRef = new Map(refusals.map((refusal) => [refusal.ref, refusal.reason]));
  return request.commands.map((command) => ({
    ref: command.ref,
    reason: byRef.get(command.ref) ?? COLLATERAL_REASON,
  }));
}

/**
 * The request body as receive-pack bytes: gunzipped when the client compressed it, and null for
 * git's auth probe (a body of just a flush packet, sent before a large chunked push).
 */
async function receivePackBody(request: Request): Promise<ReadableStream<Uint8Array> | null> {
  const raw = request.body ?? new Blob([]).stream();
  const body =
    request.headers.get('Content-Encoding') === 'gzip'
      ? raw.pipeThrough(new DecompressionStream('gzip'))
      : raw;
  const reader = new PktLineReader(body);
  const first = await reader.read();
  if (first?.type === 'flush' && (await reader.read()) === null) return null;
  return reader.replay();
}

/**
 * Branch-policy middleware for git-receive-pack: reads only the leading update commands of the
 * push (never the pack), asks the BranchPolicy about every ref, and proves fast-forwards it can
 * from storage. A push is forwarded only when every update is allowed — otherwise the client is
 * answered in-protocol ("ng <ref> <reason>" per ref) and nothing reaches storage. Updates whose
 * ancestry depends on commits in the pack are left for the receive-pack handler to prove as the
 * pack streams past.
 */
export function enforceBranchPolicy(deps: GatewayDeps): MiddlewareHandler<GatewayEnv> {
  return async (context, next) => {
    const requestId = context.get('requestId');
    const principal = context.get('principal');
    const git = context.get('git');
    const defer = deferWith(context);
    let parsed;
    try {
      const body = await receivePackBody(context.req.raw);
      if (body === null) {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-git-receive-pack-result',
            ...NO_CACHE,
            'X-Request-Id': requestId,
          },
        });
      }
      parsed = await parseReceivePackRequest(body, { maxHeadBytes: deps.config.maxPushHeadBytes });
    } catch (error) {
      if (!isCoreError(error)) throw error;
      const reason = reasonLine(`malformed push: ${error.message}`);
      deps.audit.record({ requestId, principal, git, outcome: 'denied', reason, refs: [] }, defer, requestId);
      const response = errResponse(git.service, 'rpc', reason);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
    let verdict;
    try {
      verdict = await judgePush(deps, git, principal, parsed.request);
    } catch (error) {
      deps.logger.log({
        level: 'error',
        message: 'branch policy failed',
        requestId,
        repo: git.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      const reason = 'The branch policy is unavailable; try again later';
      deps.audit.record(
        { requestId, principal, git, outcome: 'failed', reason, refs: unknownOutcomes(parsed.request) },
        defer,
        requestId,
      );
      await drain(parsed.body);
      return textResponse(503, reason, { 'X-Request-Id': requestId });
    }
    if (verdict.refusals.length > 0) {
      const refusals = refuseAll(parsed.request, verdict.refusals);
      const reasons = new Map(refusals.map((refusal) => [refusal.ref, refusal.reason]));
      const reason = verdict.refusals[0]?.reason ?? COLLATERAL_REASON;
      deps.audit.record(
        {
          requestId,
          principal,
          git,
          outcome: 'denied',
          reason,
          refs: rejectedOutcomes(parsed.request, reasons, COLLATERAL_REASON),
        },
        defer,
        requestId,
      );
      await drain(parsed.body);
      deps.logger.log({
        level: 'info',
        message: 'push refused by branch policy',
        requestId,
        repo: git.repo,
        reason,
      });
      const response = refusePush(parsed.request.capabilities, refusals);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
    context.set('push', { ...parsed, pending: verdict.pending });
    return next();
  };
}
