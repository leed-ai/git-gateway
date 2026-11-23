// SPDX-License-Identifier: Apache-2.0
import { streamOf } from '@leed-ai/git-gateway-core/bytes';
import type { Handler } from 'hono';

import { readPushOutcomes, rejectedOutcomes, unknownOutcomes } from '../audit/push-report.ts';
import { COLLATERAL_REASON, refuseAll } from '../policy/enforce-branch-policy.ts';
import { checkHeldPush } from './check-held-push.ts';
import { deferWith } from './defer.ts';
import type { GatewayDeps } from './gateway-deps.ts';
import type { GatewayEnv } from './gateway-env.ts';
import { refusePush, textResponse, type RefRefusal } from './git-responses.ts';
import { deliverPushEvents } from './push-events.ts';
import { streamProvenPush } from './stream-proven-push.ts';
import { callUpstream, streamToClient, type UpstreamResult } from './upstream-call.ts';

/** Bytes of a host report read for push events when the audit report is switched off (1 MiB). */
const DEFAULT_REPORT_BYTES = 1024 * 1024;

/**
 * Forwards a push the branch policy let through. When fast-forwards remain to be proven from the
 * pack, or the push policy is to be given changed paths computed from it, the push is first read
 * whole (bounded by `maxFastForwardPackBytes`, or `maxPushPolicyPackBytes` for the push policy)
 * and its pack scanned; every storage read the proofs and the policy need is made, and the push
 * decided, before the receive-pack request to the storage host is opened, since a host that locks
 * a repository for the whole of each request would otherwise make those reads wait on the
 * gateway's own push. A refusal sends nothing to storage and tells the client in-protocol which
 * refs were refused and why; an allowed push is sent byte for byte, and the host still refuses an
 * update whose old id has gone stale meanwhile. A push with only fast-forwards to prove whose pack
 * is too large to hold streams instead, proven from the pack alone (see `streamProvenPush`), and a
 * push with nothing left to check streams straight through. When an audit hook or an onPush hook
 * is set, a copy of the answer is read for per-ref outcomes: the audit event gets them, and the
 * refs the host accepted go to the onPush hook as push events, both after the response through
 * `waitUntil`.
 */
export function receivePack(deps: GatewayDeps): Handler<GatewayEnv> {
  return async (context) => {
    const requestId = context.get('requestId');
    const principal = context.get('principal');
    const git = context.get('git');
    const push = context.get('push');
    const defer = deferWith(context);
    const refusal = (all: readonly RefRefusal[]): Response => {
      const reasons = new Map(all.map((entry) => [entry.ref, entry.reason]));
      const reason = all.find((entry) => entry.reason !== COLLATERAL_REASON)?.reason ?? COLLATERAL_REASON;
      deps.audit.record(
        {
          requestId,
          principal,
          git,
          outcome: 'denied',
          reason,
          refs: rejectedOutcomes(push.request, reasons, reason),
        },
        defer,
        requestId,
      );
      deps.logger.log({
        level: 'info',
        message: 'push refused after reading its pack',
        requestId,
        repo: git.repo,
        reason,
      });
      const response = refusePush(push.request.capabilities, all);
      response.headers.set('X-Request-Id', requestId);
      return response;
    };
    let body: ReadableStream<Uint8Array> | null = push.body;
    let result: UpstreamResult | null = null;
    let failure: unknown = null;
    if (push.pending.length > 0 || push.policyUpdates !== null) {
      const verdict = await checkHeldPush(deps, push, { requestId, principal, git });
      if (verdict.kind === 'refused') return refusal(refuseAll(push.request, verdict.refusals));
      if (verdict.kind === 'allowed') body = streamOf(verdict.body);
      else {
        const streamed = await streamProvenPush(deps, context, verdict);
        if (streamed.refused !== null) return refusal(streamed.refused);
        ({ result, failure } = streamed);
        body = null;
      }
    }
    if (body !== null) {
      try {
        result = await callUpstream(deps, context, body);
      } catch (error) {
        failure = error;
      }
    }
    if (result === null) {
      deps.logger.log({
        level: 'error',
        message: 'storage host unreachable',
        requestId,
        repo: git.repo,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      const reason = 'The storage backend is unreachable; try again later';
      deps.audit.record(
        { requestId, principal, git, outcome: 'failed', reason, refs: unknownOutcomes(push.request) },
        defer,
        requestId,
      );
      return textResponse(502, reason, { 'X-Request-Id': requestId });
    }
    if (!result.ok) {
      deps.audit.record(
        {
          requestId,
          principal,
          git,
          outcome: 'failed',
          reason: result.reason,
          refs: unknownOutcomes(push.request),
        },
        defer,
        requestId,
      );
      return result.response;
    }
    const upstream = result.response;
    const auditReport = deps.audit.enabled && deps.config.maxAuditReportBytes > 0;
    const onPush = deps.onPush;
    const unknown = { requestId, principal, git, outcome: 'allowed' as const, reason: null };
    if (upstream.body === null || (!auditReport && onPush === undefined)) {
      deps.audit.record({ ...unknown, refs: unknownOutcomes(push.request) }, defer, requestId);
      return streamToClient(upstream, upstream.body, requestId);
    }
    const [toClient, toReport] = upstream.body.tee();
    const limit = auditReport ? deps.config.maxAuditReportBytes : DEFAULT_REPORT_BYTES;
    const outcomes = readPushOutcomes(toReport, push.request, limit);
    deps.audit.record(
      auditReport
        ? outcomes.then((refs) => ({ ...unknown, refs }))
        : { ...unknown, refs: unknownOutcomes(push.request) },
      defer,
      requestId,
    );
    if (onPush !== undefined) {
      defer(
        deliverPushEvents(
          { onPush, onPushError: deps.onPushError, logger: deps.logger, now: deps.now },
          git.repo,
          outcomes,
          requestId,
        ),
      );
    }
    return streamToClient(upstream, toClient, requestId);
  };
}
