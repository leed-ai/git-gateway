// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Timestamp } from '../schemas/identity.ts';
import { RepoName } from '../schemas/names.ts';
import { Sha } from '../schemas/sha.ts';
import { GitOperation, SmartHttpEndpoint } from './git-operation.ts';
import { Principal } from './principal.ts';

/** A request id: opaque, safe to log. */
export const RequestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .meta({
    id: 'RequestId',
    title: 'Request id',
    description:
      'Identifies one request in logs, audit events and the X-Request-Id response header: 1–128 characters of letters, digits, ".", "_", ":" and "-". The Cloudflare Ray id when there is one, otherwise a random UUID.',
    examples: ['8f1c2d3e4a5b6c7d-LHR', '6f1d2c3b-9a8e-4f7d-b6c5-a4e3d2c1b0a9'],
  });

/** A request id, inferred from {@link RequestId}. */
export type RequestId = z.infer<typeof RequestId>;

/** The outcome of one ref update of a push, as far as the gateway knows it. */
export const AuditRefOutcome = z
  .object({
    ref: z
      .string()
      .min(6)
      .max(4096)
      .regex(/^refs\/[^\n\0]+$/)
      .describe(
        'The ref the update command named, fully qualified; any namespace, since refused ones are audited too.',
      ),
    oldSha: Sha.describe('Id the client said the ref named; all zeros when it asked to create the ref.'),
    newSha: Sha.describe('Id the client asked the ref to name; all zeros when it asked to delete the ref.'),
    status: z.enum(['ok', 'rejected', 'unknown']).meta({
      description: 'What happened to the ref.',
      enumDescriptions: {
        ok: 'The storage host reported the ref updated.',
        rejected: 'The gateway or the storage host refused the update; `reason` says why.',
        unknown: 'The push was forwarded but the storage host report could not be read.',
      },
    }),
    reason: z
      .string()
      .min(1)
      .max(1000)
      .nullable()
      .describe('Why the update was refused, as git was told; null unless `status` is "rejected".'),
  })
  .strict()
  .meta({
    id: 'AuditRefOutcome',
    title: 'Audited ref update',
    description: 'One update command of an audited push and what became of it.',
    examples: [
      {
        ref: 'refs/heads/main',
        oldSha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
        newSha: '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a',
        status: 'rejected',
        reason: 'main is protected',
      },
    ],
  });

/** An audited ref update, inferred from {@link AuditRefOutcome}. */
export type AuditRefOutcome = z.infer<typeof AuditRefOutcome>;

/** One authenticated smart-HTTP operation, as handed to the audit hook. */
export const AuditEvent = z
  .object({
    requestId: RequestId.describe('The request this event records.'),
    at: Timestamp.describe('When the gateway finished deciding and forwarding the request.'),
    principal: Principal.describe('Who made the request (never the credential).'),
    repo: RepoName.describe('The repository the request named.'),
    operation: GitOperation.describe('Whether the request reads or writes the repository.'),
    endpoint: SmartHttpEndpoint.describe('Which smart-HTTP endpoint the request reached.'),
    outcome: z.enum(['allowed', 'denied', 'failed']).meta({
      description: 'What the gateway did with the request.',
      enumDescriptions: {
        allowed:
          'Authorized and forwarded to storage; for a push, `refs` says what storage did with each ref.',
        denied: 'Refused by the authorizer or the branch policy; nothing reached storage.',
        failed: 'Authorized, but the gateway or the storage host failed before an answer was complete.',
      },
    }),
    reason: z
      .string()
      .min(1)
      .max(1000)
      .nullable()
      .describe('Why the request was denied or failed, as the client was told; null when it was allowed.'),
    refs: z
      .array(AuditRefOutcome)
      .max(10_000)
      .describe(
        'For a push (receive-pack), every update command and its outcome; empty for every other request.',
      ),
  })
  .strict()
  .meta({
    id: 'AuditEvent',
    title: 'Audit event',
    description:
      'Handed to the audit hook for every authenticated smart-HTTP request once it is decided: principal, repository, operation, refs and outcome. Never contains a credential.',
    examples: [
      {
        requestId: '6f1d2c3b-9a8e-4f7d-b6c5-a4e3d2c1b0a9',
        at: '2026-11-20T09:30:00.000Z',
        principal: { subject: 'user:42', name: null, email: null, roles: ['editor'], expiresAt: null },
        repo: 'acme-raw-content',
        operation: 'write',
        endpoint: 'receive-pack',
        outcome: 'denied',
        reason: 'main is protected',
        refs: [
          {
            ref: 'refs/heads/main',
            oldSha: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
            newSha: '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a',
            status: 'rejected',
            reason: 'main is protected',
          },
        ],
      },
    ],
  });

/** An audit event, inferred from {@link AuditEvent}. */
export type AuditEvent = z.infer<typeof AuditEvent>;
