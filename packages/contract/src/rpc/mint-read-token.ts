// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import { EXAMPLE_TIMESTAMP } from '../schemas/examples.ts';
import { Timestamp } from '../schemas/identity.ts';
import { RepoName } from '../schemas/names.ts';

/** Input of `mintReadToken`. */
export const MintReadTokenInput = z
  .object({
    repo: RepoName.describe('Repository the token may read.'),
    ttlSeconds: z
      .int()
      .min(60)
      .max(86_400)
      .default(3600)
      .describe('Lifetime of the token in seconds; 60–86400, default 3600.'),
  })
  .strict()
  .meta({
    id: 'MintReadTokenInput',
    title: 'mintReadToken input',
    description:
      'Input of mintReadToken(): a short-lived credential that can clone and fetch one repository through the gateway and nothing else. Fails with repo_not_found.',
    examples: [{ repo: 'acme-raw-content', ttlSeconds: 900 }],
  });

/** Input of `mintReadToken` as accepted (defaults optional). */
export type MintReadTokenInput = z.input<typeof MintReadTokenInput>;

/** Output of `mintReadToken`. */
export const MintReadTokenOutput = z
  .object({
    token: z
      .string()
      .min(16)
      .max(4096)
      .describe(
        'The credential: send it as the HTTP Basic password (any username) or as a Bearer token. Secret.',
      ),
    expiresAt: Timestamp.describe('When the token stops working.'),
    remoteUrl: z.url().describe('Clone URL the token is good for: <publicBaseUrl>/<repo>.git.'),
  })
  .strict()
  .meta({
    id: 'MintReadTokenOutput',
    title: 'mintReadToken output',
    description: 'Output of mintReadToken(): a read-only credential for one repository and where to use it.',
    examples: [
      {
        token: 'ggr_0123456789abcdef0123456789abcdef',
        expiresAt: EXAMPLE_TIMESTAMP,
        remoteUrl: 'https://git.example.com/acme-raw-content.git',
      },
    ],
  });

/** Output of `mintReadToken`, inferred from {@link MintReadTokenOutput}. */
export type MintReadTokenOutput = z.infer<typeof MintReadTokenOutput>;
