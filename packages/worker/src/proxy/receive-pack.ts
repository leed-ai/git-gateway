// SPDX-License-Identifier: Apache-2.0
import type { Handler } from 'hono';

import { readPushOutcomes, rejectedOutcomes, unknownOutcomes } from '../audit/push-report.ts';
import { provePending } from '../policy/branch-policy.ts';
import { COLLATERAL_REASON, refuseAll } from '../policy/enforce-branch-policy.ts';
import { deferWith } from './defer.ts';
import type { GatewayDeps } from './gateway-deps.ts';
import type { GatewayEnv } from './gateway-env.ts';
import { refusePush, textResponse, type RefRefusal } from './git-responses.ts';
import { deliverPushEvents } from './push-events.ts';
import { judgeChangedPaths } from '../push-policy/run-push-policy.ts';
import { guardPush } from './push-guard.ts';
import { callUpstream, streamToClient, type UpstreamResult } from './upstream-call.ts';

/** Bytes of a host report read for push events when the audit report is switched off (1 MiB). */
const DEFAULT_REPORT_BYTES = 1024 * 1024;

/** The reason given for every update when proving the push failed unexpectedly. */
const UNCHECKED_REASON = 'the push could not be checked; try again later';

/** Waits for `promise`, but at most `ms` milliseconds. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, timeout]);
  clearTimeout(timer);
}

/**
 * Holds a 2xx storage host answer back until the push guard has decided, so a host that answers
 * before reading the whole body cannot carry a push past a refusal made later. Returns once the
 * guard's verdict is in, or once the host's answer has ended without one (the host stopped
 * reading, so it never got the pack checksum and updated nothing); the answer is buffered by the
 * tee meanwhile and handed back whole. On a refusal the watching branch is cancelled as well.
 */
async function awaitVerdict(
  upstream: Response,
  verdict: Promise<void>,
  isRefused: () => boolean,
): Promise<UpstreamResult> {
  const [watched, kept] = (upstream.body ?? new Blob([]).stream()).tee();
  const reader = watched.getReader();
  const ended = (async () => {
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read());
    } catch {
      // The host's answer failed: it is over either way.
    }
  })();
  await Promise.race([verdict, ended]);
  if (isRefused()) await reader.cancel().catch(() => undefined);
  const init = { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers };
  return { ok: true, response: new Response(kept, init) };
}

/**
 * Forwards a push the branch policy let through. When fast-forwards remain to be proven from the
 * pack, or the push policy is to be given changed paths computed from it, the body streams through a guard that scans it and holds back the pack checksum until
 * they are; a refusal then fails the upstream request (the host gets a truncated pack and updates
 * nothing) and the client is told in-protocol which refs were refused and why. The host's answer
 * is held until that verdict is known — and when the host's request fails first, the verdict is
 * still awaited (at most `maxVerdictWaitMs`), so a refusal is never mistaken for a storage
 * failure — and the push is audited only after it; otherwise it
 * streams back untouched. When an audit hook or an onPush hook is set, a copy of the answer is
 * read for per-ref outcomes: the audit event gets them, and the refs the host accepted go to the
 * onPush hook as push events, both after the response through `waitUntil`.
 */
export function receivePack(deps: GatewayDeps): Handler<GatewayEnv> {
  return async (context) => {
    const requestId = context.get('requestId');
    const principal = context.get('principal');
    const git = context.get('git');
    const push = context.get('push');
    const defer = deferWith(context);
    const commands = push.request.commands;
    let refused: readonly RefRefusal[] | null = null;
    /** Settles once the guard has allowed or refused the push, or will never decide it. */
    const { promise: verdict, resolve: settleVerdict } = Promise.withResolvers<void>();
    let deciding = false;
    const { policyUpdates } = push;
    const guarded = push.pending.length > 0 || policyUpdates !== null;
    if (push.pending.length > 0) {
      deps.logger.log({
        level: 'debug',
        message: 'proving fast-forwards from the pushed pack',
        requestId,
        repo: git.repo,
        refs: push.pending.map(({ update }) => update.ref),
      });
    }
    let body = push.body;
    if (guarded) {
      const { pushPolicy } = deps;
      const maxPackBytes = deps.config.maxPushPolicyPackBytes;
      const guard = guardPush({
        headLength: push.headLength,
        maxCommitBytes: deps.config.maxScannedCommitBytes,
        ...(policyUpdates === null
          ? {}
          : {
              keepPack: {
                maxBytes: maxPackBytes,
                tooLarge: `the push policy could not check this push: the pack is larger than ${maxPackBytes} bytes`,
              },
            }),
        decide: async (scan, pack) => {
          deciding = true;
          let refusals: readonly RefRefusal[];
          try {
            refusals = await provePending(deps, git, push.pending, scan.commits);
            if (
              refusals.length === 0 &&
              policyUpdates !== null &&
              pushPolicy !== undefined &&
              pack !== null
            ) {
              refusals = await judgeChangedPaths(
                { pushPolicy, backend: deps.backend, config: deps.config },
                { principal, repo: git.repo, updates: policyUpdates },
                pack,
              );
            }
          } catch (error) {
            deps.logger.log({
              level: 'error',
              message: 'proving the push failed',
              requestId,
              repo: git.repo,
              error: error instanceof Error ? error.message : String(error),
            });
            refusals = commands.map((command) => ({ ref: command.ref, reason: UNCHECKED_REASON }));
          }
          if (refusals.length === 0) settleVerdict();
          return refusals;
        },
        onRefused: (refusals) => {
          refused = refuseAll(push.request, refusals);
          settleVerdict();
        },
        refuseAll: (reason) => commands.map((command) => ({ ref: command.ref, reason })),
      });
      // The pipe fails when the host stops reading (or the client stops sending); if that happens
      // before the pack has been scanned, no verdict will ever come.
      push.body.pipeTo(guard.writable).catch(() => {
        if (!deciding) settleVerdict();
      });
      body = guard.readable;
    }
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
        message: 'push refused after scanning its pack',
        requestId,
        repo: git.repo,
        reason,
      });
      const response = refusePush(push.request.capabilities, all);
      response.headers.set('X-Request-Id', requestId);
      return response;
    };
    let result: UpstreamResult | null = null;
    let failure: unknown = null;
    try {
      result = await callUpstream(deps, context, body);
    } catch (error) {
      failure = error;
    }
    if (guarded) {
      if (result?.ok === true) result = await awaitVerdict(result.response, verdict, () => refused !== null);
      // A refusal fails the host's request by design (the pack is cut short), and the host may
      // notice before the guard has recorded its verdict: wait for it, so a refused push is
      // answered in-protocol rather than as a storage failure.
      else if (refused === null) await within(verdict, deps.config.maxVerdictWaitMs);
    }
    if (refused !== null) {
      await result?.response.body?.cancel().catch(() => undefined);
      return refusal(refused);
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
