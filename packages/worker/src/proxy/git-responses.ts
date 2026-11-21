// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '@leed-ai/git-gateway-core/bytes';
import { encodePktLine, FLUSH_PKT } from '@leed-ai/git-gateway-core/pkt-line/encode';
import {
  encodeErrPacket,
  encodeReportStatus,
  reportStatusFraming,
} from '@leed-ai/git-gateway-core/receive-pack/report-status';
import {
  BAND_PROGRESS,
  encodeSideBand,
  SIDE_BAND_64K_MAX_PAYLOAD,
  SIDE_BAND_MAX_PAYLOAD,
} from '@leed-ai/git-gateway-core/receive-pack/side-band';

import type { GitServiceName } from './git-route.ts';

/** Headers git smart-HTTP responses carry so no proxy or browser caches them. */
export const NO_CACHE: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-cache, max-age=0, must-revalidate',
  Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  Pragma: 'no-cache',
};

/** A plain-text response (for errors outside the git protocol). */
export function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body.endsWith('\n') ? body : `${body}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE, ...headers },
  });
}

/** 401 with a Basic challenge, so git asks its credential helper and retries. */
export function unauthorized(realm: string): Response {
  return textResponse(401, 'Authentication required', { 'WWW-Authenticate': `Basic realm="${realm}"` });
}

/**
 * A refusal git prints as "fatal: remote error: <message>": an "ERR" packet, after the
 * "# service=…" preamble for an info/refs request.
 */
export function errResponse(
  service: GitServiceName,
  endpoint: 'info-refs' | 'rpc',
  message: string,
): Response {
  const err = encodeErrPacket(message);
  const body =
    endpoint === 'info-refs' ? concatBytes([encodePktLine(`# service=${service}\n`), FLUSH_PKT, err]) : err;
  const kind = endpoint === 'info-refs' ? 'advertisement' : 'result';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': `application/x-${service}-${kind}`, ...NO_CACHE },
  });
}

/** One update a refused push names, and why it was refused. */
export interface RefRefusal {
  readonly ref: string;
  readonly reason: string;
}

/**
 * The receive-pack response refusing a whole push in-protocol: "ng <ref> <reason>" for every
 * update (git prints "! [remote rejected] <ref> (<reason>)"), with each reason also sent as
 * progress text when a side-band was negotiated (git prints "remote: …"). A client that did not
 * ask for report-status gets an ERR packet instead.
 */
export function refusePush(capabilities: readonly string[], refusals: readonly RefRefusal[]): Response {
  const headers = { 'Content-Type': 'application/x-git-receive-pack-result', ...NO_CACHE };
  const wantsReport = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
  if (!wantsReport) {
    return new Response(encodeErrPacket(refusals[0]?.reason ?? 'push refused'), { status: 200, headers });
  }
  const framing = reportStatusFraming(capabilities);
  const report = encodeReportStatus(
    { unpack: 'ok', refs: refusals.map(({ ref, reason }) => ({ ref, status: 'ng', reason })) },
    framing,
  );
  if (framing.sideBand === 'none') return new Response(report, { status: 200, headers });
  const progress = new TextEncoder().encode(
    refusals.map(({ ref, reason }) => `git-gateway: ${ref}: ${reason}\n`).join(''),
  );
  const maxPayload = framing.sideBand === 'side-band' ? SIDE_BAND_MAX_PAYLOAD : SIDE_BAND_64K_MAX_PAYLOAD;
  return new Response(concatBytes([encodeSideBand(BAND_PROGRESS, progress, maxPayload), report]), {
    status: 200,
    headers,
  });
}
