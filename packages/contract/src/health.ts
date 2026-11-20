// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Body of `GET /health`. */
export const HealthResponse = z
  .object({
    status: z.literal('ok').describe('Always "ok": the gateway Worker is up and routing requests.'),
    service: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Name of the deployment answering, 1–64 characters; "git-gateway" unless the deployment names itself.',
      ),
  })
  .strict()
  .meta({
    id: 'HealthResponse',
    title: 'Health response',
    description:
      'Body of GET /health. Returned with status 200 whenever the Worker is serving; it does not probe storage backends.',
    examples: [{ status: 'ok', service: 'git-gateway' }],
  });

/** Body of `GET /health`, inferred from {@link HealthResponse}. */
export type HealthResponse = z.infer<typeof HealthResponse>;
