// SPDX-License-Identifier: Apache-2.0
import { isCoreError } from '@leed-ai/git-gateway-core/core-error';
import { PktLineReader } from '@leed-ai/git-gateway-core/pkt-line/pkt-line-reader';
import { parseReceivePackRequest } from '@leed-ai/git-gateway-core/receive-pack/parse-request';
import type { ReceivePackRequest } from '@leed-ai/git-gateway-core/schemas/receive-pack';
import type { MiddlewareHandler } from 'hono';
import { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { rejectedOutcomes, unknownOutcomes } from '../audit/push-report.ts';
import { deferWith } from '../proxy/defer.ts';
import type { GatewayDeps } from '../proxy/gateway-deps.ts';
import type { GatewayEnv } from '../proxy/gateway-env.ts';
import { errResponse, NO_CACHE, refusePush, textResponse, type RefRefusal } from '../proxy/git-responses.ts';
import { disallowedPushOptions, pushOptionsReason } from '../proxy/push-options.ts';
import { judgeWithPushPolicy, pushPolicyNeeds } from '../push-policy/run-push-policy.ts';
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
 * push (never the pack), refuses a push carrying a push option outside
 * `SmartHttpConfig.allowedPushOptions` (the storage host would act on it with the gateway's own
 * credential), asks the BranchPolicy about every ref, and proves fast-forwards it can
 * from storage, then runs the push policy (when there is one) — at once when it needs no changed
 * paths, or after the pack when it does. A push is forwarded only when every update is allowed —
 * otherwise the client is answered in-protocol ("ng <ref> <reason>" per ref) and nothing reaches
 * storage. Updates whose ancestry depends on commits in the pack are left for the receive-pack
 * handler to prove once it has read the pack, before it opens the push to storage.
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
    const refusedOptions = disallowedPushOptions(parsed.request, deps.config.allowedPushOptions);
    if (refusedOptions.length > 0) {
      const reason = reasonLine(pushOptionsReason(refusedOptions));
      const refusals = parsed.request.commands.map((command) => ({ ref: command.ref, reason }));
      deps.audit.record(
        {
          requestId,
          principal,
          git,
          outcome: 'denied',
          reason,
          refs: rejectedOutcomes(parsed.request, new Map(), reason),
        },
        defer,
        requestId,
      );
      await drain(parsed.body);
      deps.logger.log({
        level: 'info',
        message: 'push refused for its push options',
        requestId,
        repo: git.repo,
        reason,
      });
      const response = refusePush(parsed.request.capabilities, refusals);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
    /** Answers 503 when a policy hook failed; nothing reaches storage. */
    const unavailable = async (error: unknown, what: string): Promise<Response> => {
      deps.logger.log({
        level: 'error',
        message: `${what} failed`,
        requestId,
        repo: git.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      const reason = `The ${what} is unavailable; try again later`;
      deps.audit.record(
        { requestId, principal, git, outcome: 'failed', reason, refs: unknownOutcomes(parsed.request) },
        defer,
        requestId,
      );
      await drain(parsed.body);
      return textResponse(503, reason, { 'X-Request-Id': requestId });
    };
    /** Refuses the whole push in-protocol: the given refusals, and the collateral reason for the rest. */
    const refuse = async (given: readonly RefRefusal[], by: string): Promise<Response> => {
      const refusals = refuseAll(parsed.request, given);
      const reasons = new Map(refusals.map((refusal) => [refusal.ref, refusal.reason]));
      const reason = given[0]?.reason ?? COLLATERAL_REASON;
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
      deps.logger.log({ level: 'info', message: `push refused by ${by}`, requestId, repo: git.repo, reason });
      const response = refusePush(parsed.request.capabilities, refusals);
      response.headers.set('X-Request-Id', requestId);
      return response;
    };
    let verdict;
    try {
      verdict = await judgePush(deps, git, principal, parsed.request);
    } catch (error) {
      return unavailable(error, 'branch policy');
    }
    if (verdict.refusals.length > 0) return refuse(verdict.refusals, 'branch policy');
    let policyUpdates: readonly RefUpdate[] | null = null;
    const { pushPolicy } = deps;
    if (pushPolicy !== undefined) {
      const updates = parsed.request.commands.map((command) => RefUpdate.parse(command));
      const push = { principal, repo: git.repo, updates };
      const policyDeps = { pushPolicy, backend: deps.backend, config: deps.config };
      let refusals: readonly RefRefusal[] = [];
      try {
        const needs = await pushPolicyNeeds(policyDeps, push);
        // Changed paths come from the pack, so the check waits for it; a push of deletions only
        // brings no commits and is checked now.
        if (needs.changedPaths && updates.some((update) => update.newSha !== ZERO_SHA))
          policyUpdates = updates;
        else
          refusals = await judgeWithPushPolicy(
            policyDeps,
            push,
            updates.map(() => (needs.changedPaths ? [] : null)),
          );
      } catch (error) {
        return unavailable(error, 'push policy');
      }
      if (refusals.length > 0) return refuse(refusals, 'push policy');
    }
    context.set('push', { ...parsed, pending: verdict.pending, policyUpdates });
    return next();
  };
}
