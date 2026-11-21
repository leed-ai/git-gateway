// SPDX-License-Identifier: Apache-2.0
import type { BranchPolicyConfigInput } from '@leed-ai/git-gateway-contract/proxy/branch-rule';
import { decodePktLines } from '@leed-ai/git-gateway-core/pkt-line/decode';
import { encodeReportStatus, parseReportStatus } from '@leed-ai/git-gateway-core/receive-pack/report-status';
import { demultiplexSideBand } from '@leed-ai/git-gateway-core/receive-pack/side-band';
import type { GitObject } from '@leed-ai/git-gateway-core/schemas/git-object';
import type { RefStatus } from '@leed-ai/git-gateway-core/schemas/report-status';

import { basic, gatewayFixture, type FixtureOptions } from './gateway-fixture.ts';
import { commitObject, emptyTree } from './push-builder.ts';

/** Side-band-64k framing, which the test pushes ask for. */
export const SIDE_BAND = { sideBand: 'side-band-64k' } as const;

/** main is protected (maintainers only, never deleted); feature branches may be force-pushed. */
export const PROTECTED: BranchPolicyConfigInput = {
  rules: [
    {
      pattern: 'refs/heads/main',
      pushers: { roles: ['maintainer'] },
      delete: false,
      message: 'main is protected',
    },
    { pattern: 'refs/heads/feature/**', forcePush: true, delete: true },
  ],
};

/** The objects the push tests use: the empty tree, `base` (head of main), a child of it, and an unrelated root. */
export interface PushObjects {
  readonly tree: GitObject;
  readonly base: GitObject;
  readonly child: GitObject;
  readonly unrelated: GitObject;
}

export async function pushObjects(): Promise<PushObjects> {
  const base = await commitObject([], 'base');
  return {
    tree: await emptyTree(),
    base,
    child: await commitObject([base.sha], 'child'),
    unrelated: await commitObject([], 'unrelated'),
  };
}

/** A gateway whose storage holds `base`, and whose storage host accepts every push to main. */
export function receivePackFixture(objects: PushObjects, options: FixtureOptions = {}) {
  const gateway = gatewayFixture({ policy: PROTECTED, ...options });
  gateway.backend.addCommit(objects.base.sha, []);
  gateway.upstream.respond = () =>
    new Response(
      encodeReportStatus({ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] }, SIDE_BAND),
      {
        headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
      },
    );
  return gateway;
}

/** POSTs a receive-pack body as `token`. */
export async function push(
  app: ReturnType<typeof gatewayFixture>['app'],
  token: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/site.git/git-receive-pack', {
    method: 'POST',
    headers: { ...basic(token), 'Content-Type': 'application/x-git-receive-pack-request', ...headers },
    body,
  });
}

/** The report-status (side-band-64k) of a response, with the progress text sent beside it. */
export async function report(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const progress = demultiplexSideBand(decodePktLines(bytes)).progress;
  return { ...parseReportStatus(bytes, SIDE_BAND), progress };
}

/** The reason of a refused ref status, or null for an accepted one. */
export function reasonOf(status: RefStatus | undefined): string | null {
  return status?.status === 'ng' ? status.reason : null;
}
