// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Timestamp } from '../schemas/identity.ts';

/** A role or group name a deployment grants a principal. */
export const Role = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\s\0]+$/)
  .meta({
    id: 'Role',
    title: 'Role',
    description:
      'A role or group the deployment grants a principal, matched by branch-policy rules and authorizers: 1–100 characters without whitespace or NUL. Case-sensitive.',
    examples: ['maintainer', 'site:acme:editor'],
  });

/** A role name, inferred from {@link Role}. */
export type Role = z.infer<typeof Role>;

/** Who a smart-HTTP request acts for, as an Authenticator established it. */
export const Principal = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\n\0]+$/)
      .describe(
        'Stable identifier of the caller in the deployment (e.g. the JWT "sub" claim or a user id): 1–255 characters without newline or NUL. Used for policy matching, audit and caching; never a credential.',
      ),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\n\0]+$/)
      .nullable()
      .default(null)
      .describe(
        'Display name for logs and audit, 1–255 characters without newline or NUL; null (the default) when the authenticator does not know one.',
      ),
    email: z
      .email()
      .max(255)
      .nullable()
      .default(null)
      .describe('Email address, at most 255 characters; null (the default) when unknown.'),
    roles: z
      .array(Role)
      .max(100)
      .default([])
      .describe('Roles or groups granted to the caller, at most 100; default none.'),
    expiresAt: Timestamp.nullable()
      .default(null)
      .describe(
        'When the credential that established this principal stops being valid, as an ISO 8601 UTC timestamp; cached decisions never outlive it. Null (the default) when the credential does not expire or the authenticator does not say.',
      ),
  })
  .strict()
  .meta({
    id: 'Principal',
    title: 'Principal',
    description:
      'Who a smart-HTTP request acts for, as returned by an Authenticator. Authorizers, branch policy, the audit hook and the decision cache all key on it; it never carries the credential itself.',
    examples: [
      {
        subject: 'user:42',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        roles: ['maintainer'],
        expiresAt: '2026-11-20T10:30:00.000Z',
      },
    ],
  });

/** A principal as an authenticator may write it (defaults optional). */
export type PrincipalInput = z.input<typeof Principal>;
/** A complete principal, inferred from {@link Principal}. */
export type Principal = z.output<typeof Principal>;
