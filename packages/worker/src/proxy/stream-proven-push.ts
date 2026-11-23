// SPDX-License-Identifier: Apache-2.0
import type { Context } from 'hono';

import { provePendingFromPack } from '../policy/branch-policy.ts';
import { refuseAll } from '../policy/enforce-branch-policy.ts';
import type { GatewayDeps } from './gateway-deps.ts';
import type { GatewayEnv } from './gateway-env.ts';
import type { RefRefusal } from './git-responses.ts';
import { guardPush, type OverflowingPush } from './push-guard.ts';
import { callUpstream, type UpstreamResult } from './upstream-call.ts';

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

/** How a streamed push ended: refused (every update, collateral included), or the host's answer. */
export interface StreamedPush {
  readonly refused: readonly RefRefusal[] | null;
  readonly result: UpstreamResult | null;
  /** Why the host could not be reached, when `result` is null and nothing was refused. */
  readonly failure: unknown;
}

/**
 * Streams a push whose only remaining checks are fast-forward proofs and whose pack is too large
 * to hold (`maxFastForwardPackBytes`), proving them from the pack alone as it passes: the pack
 * checksum is held back until the scan is complete, and a refusal fails the upstream request, so
 * the host sees a truncated pack and updates nothing. No storage read is made while the request is
 * open, since a host that locks a repository per request would make it wait on this push forever,
 * so an update whose proof needs storage is refused as unverifiable. The host's answer is held
 * until the verdict is known; when the host's request fails first, the verdict is still awaited
 * (at most `maxVerdictWaitMs`), so a refusal is never mistaken for a storage failure.
 */
export async function streamProvenPush(
  deps: GatewayDeps,
  context: Context<GatewayEnv>,
  overflow: OverflowingPush,
): Promise<StreamedPush> {
  const push = context.get('push');
  const commands = push.request.commands;
  const limit = deps.config.maxFastForwardPackBytes;
  const why = `the pack is larger than ${limit} bytes, so the update is proven from the pack alone, and this one needs commits from storage`;
  let refused: readonly RefRefusal[] | null = null;
  /** Settles once the guard has allowed or refused the push, or will never decide it. */
  const { promise: verdict, resolve: settleVerdict } = Promise.withResolvers<void>();
  let deciding = false;
  const guard = guardPush({
    headLength: push.headLength,
    maxCommitBytes: deps.config.maxScannedCommitBytes,
    resume: { scanner: overflow.scanner, scannedBytes: overflow.scannedBytes },
    decide: async (scan) => {
      deciding = true;
      let refusals: readonly RefRefusal[];
      try {
        refusals = await provePendingFromPack(push.pending, scan.commits, why);
      } catch {
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
  overflow.body.pipeTo(guard.writable).catch(() => {
    if (!deciding) settleVerdict();
  });
  let result: UpstreamResult | null = null;
  let failure: unknown = null;
  try {
    result = await callUpstream(deps, context, guard.readable);
  } catch (error) {
    failure = error;
  }
  if (result?.ok === true) result = await awaitVerdict(result.response, verdict, () => refused !== null);
  // A refusal fails the host's request by design (the pack is cut short), and the host may notice
  // before the guard has recorded its verdict: wait for it, so a refused push is answered
  // in-protocol rather than as a storage failure.
  else if (refused === null) await within(verdict, deps.config.maxVerdictWaitMs);
  if (refused !== null) await result?.response.body?.cancel().catch(() => undefined);
  return { refused, result, failure };
}
