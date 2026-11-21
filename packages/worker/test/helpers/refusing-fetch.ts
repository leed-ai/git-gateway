// SPDX-License-Identifier: Apache-2.0
import {
  encodeReportStatus,
  reportStatusFraming,
} from '@leed-ai/git-gateway-core/receive-pack/report-status';
import type { ReportStatus } from '@leed-ai/git-gateway-core/schemas/report-status';
import type { FetchLike } from '@leed-ai/git-gateway-core/smart-http/git-http-client';

import { isPush } from './memory-gateway.ts';

/**
 * A fetch that answers every push with the given report-status (as a host with a protected
 * branch or a failed unpack would) without applying it, and forwards everything else.
 */
export function refusingFetch(forward: FetchLike, report: ReportStatus): FetchLike {
  return async (request) => {
    if (!isPush(request)) return forward(request);
    await request.arrayBuffer();
    const body = encodeReportStatus(report, reportStatusFraming(['report-status', 'side-band-64k']));
    return new Response(body, { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } });
  };
}
