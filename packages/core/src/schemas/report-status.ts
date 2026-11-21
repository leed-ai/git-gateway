// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { GitRefName } from './receive-pack.ts';

const statusLine = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\n\0]+$/);

/** The server applied the update to this ref. */
export const RefStatusOk = z
  .object({
    ref: GitRefName.describe('The ref the command named.'),
    status: z.literal('ok').describe('The ref was updated ("ok <ref>").'),
  })
  .strict()
  .meta({
    id: 'RefStatusOk',
    title: 'ref status: ok',
    description: 'The server applied the update command for this ref.',
    examples: [{ ref: 'refs/heads/main', status: 'ok' }],
  });

/** The server refused the update to this ref. */
export const RefStatusRejected = z
  .object({
    ref: GitRefName.describe('The ref the command named.'),
    status: z.literal('ng').describe('The ref was not updated ("ng <ref> <reason>").'),
    reason: statusLine.describe(
      'Why the server refused, as it said it: e.g. "fetch first" or "failed to lock" for a stale old id, "non-fast-forward", or a policy message. One line, 1–1000 characters.',
    ),
  })
  .strict()
  .meta({
    id: 'RefStatusRejected',
    title: 'ref status: rejected',
    description: 'The server refused the update command for this ref and said why.',
    examples: [{ ref: 'refs/heads/main', status: 'ng', reason: 'fetch first' }],
  });

/** The outcome of one update command. */
export const RefStatus = z.discriminatedUnion('status', [RefStatusOk, RefStatusRejected]).meta({
  id: 'RefStatus',
  title: 'Ref status',
  description: 'The outcome of one update command in a report-status response, discriminated by `status`.',
  examples: [{ ref: 'refs/heads/main', status: 'ok' }],
});

/** The outcome of one update command, inferred from {@link RefStatus}. */
export type RefStatus = z.infer<typeof RefStatus>;

/** The report-status response of git-receive-pack. */
export const ReportStatus = z
  .object({
    unpack: statusLine.describe(
      'The unpack result: "ok" when the pack was received and stored, otherwise the error the server gave.',
    ),
    refs: z
      .array(RefStatus)
      .max(10_000)
      .describe('One status per update command, in the order the server reported them.'),
  })
  .strict()
  .meta({
    id: 'ReportStatus',
    title: 'Report status',
    description:
      'The report-status response of git-receive-pack: whether the pack unpacked, and whether each ref was updated. A push succeeded only when `unpack` is "ok" and every ref is "ok".',
    examples: [{ unpack: 'ok', refs: [{ ref: 'refs/heads/main', status: 'ok' }] }],
  });

/** A report-status response, inferred from {@link ReportStatus}. */
export type ReportStatus = z.infer<typeof ReportStatus>;
