// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { Identity } from './identity.ts';
import { BranchName } from './names.ts';

/** How far back `commit()` looks for a commit carrying the same idempotency key. */
export const IdempotencyConfig = z
  .object({
    maxCommits: z
      .int()
      .min(1)
      .max(10_000)
      .default(200)
      .describe('Most commits of the branch history examined, newest first; 1–10000, default 200.'),
    maxAgeSeconds: z
      .int()
      .min(60)
      .max(30 * 24 * 3600)
      .default(7 * 24 * 3600)
      .describe(
        'Commits committed longer ago than this many seconds are not examined; 60 s–30 days, default 7 days (604800).',
      ),
  })
  .strict()
  .meta({
    id: 'IdempotencyConfig',
    title: 'Idempotency window',
    description:
      'How far back commit() looks through the target branch for a commit carrying the same idempotency key. Both bounds apply; the lookup stops at whichever is reached first.',
    examples: [{ maxCommits: 200, maxAgeSeconds: 604_800 }],
  });

/** An idempotency window, inferred from {@link IdempotencyConfig}. */
export type IdempotencyConfig = z.infer<typeof IdempotencyConfig>;

/** An automatic sync run after every push to a branch. */
export const SyncRule = z
  .object({
    from: BranchName.describe('The branch whose pushes trigger the sync.'),
    into: BranchName.describe('The branch brought up to date with `from` by syncBranch.'),
  })
  .strict()
  .refine((rule) => rule.from !== rule.into, { message: 'from and into must differ', path: ['into'] })
  .meta({
    id: 'SyncRule',
    title: 'Sync rule',
    description:
      'An onPush rule: after any push to `from`, run syncBranch({ from, into }) as a SyncBranchWorkflow with retries.',
    examples: [{ from: 'main', into: 'staging' }],
  });

/** An automatic sync rule, inferred from {@link SyncRule}. */
export type SyncRule = z.infer<typeof SyncRule>;

/** Settings shared by every gateway implementation of the RPC contract. */
export const GatewayConfig = z
  .object({
    publicBaseUrl: z
      .url({ protocol: /^https?$/ })
      .default('https://git.example.com')
      .describe(
        'Origin (and optional path prefix) repositories are served under, without a trailing slash; a repository is at <publicBaseUrl>/<repo>.git. Default https://git.example.com.',
      ),
    serviceIdentity: Identity.default({ name: 'git-gateway', email: 'git-gateway@noreply.invalid' }).describe(
      'Author and committer of commits the gateway makes on its own behalf (sync merges) when the caller names none. Default git-gateway <git-gateway@noreply.invalid>.',
    ),
    idempotency: IdempotencyConfig.default({ maxCommits: 200, maxAgeSeconds: 604_800 }).describe(
      'Idempotency lookback window; defaults to 200 commits or 7 days.',
    ),
    inlineRetries: z
      .int()
      .min(0)
      .max(10)
      .default(3)
      .describe(
        'Times a write is rebuilt and retried inline after a stale-head refusal before it is handed to a Workflow; 0–10, default 3.',
      ),
    authCacheSeconds: z
      .int()
      .min(0)
      .max(3600)
      .default(60)
      .describe(
        'Seconds an authentication and authorization decision is cached per principal and repository; 0 disables caching; at most 3600, default 60.',
      ),
    syncRules: z
      .array(SyncRule)
      .max(50)
      .default([])
      .describe('Branch syncs run automatically after pushes; at most 50, default none.'),
  })
  .strict()
  .meta({
    id: 'GatewayConfig',
    title: 'Gateway configuration',
    description:
      'Settings shared by every implementation of the RPC contract, the real gateway and the in-memory reference alike. Every field has a default, so {} is a complete configuration.',
    examples: [
      {
        publicBaseUrl: 'https://git.example.com',
        serviceIdentity: { name: 'git-gateway', email: 'git-gateway@noreply.invalid' },
        idempotency: { maxCommits: 200, maxAgeSeconds: 604_800 },
        inlineRetries: 3,
        authCacheSeconds: 60,
        syncRules: [{ from: 'main', into: 'staging' }],
      },
    ],
  });

/** A gateway configuration as written (defaults optional). */
export type GatewayConfigInput = z.input<typeof GatewayConfig>;
/** A complete gateway configuration, inferred from {@link GatewayConfig}. */
export type GatewayConfig = z.output<typeof GatewayConfig>;
