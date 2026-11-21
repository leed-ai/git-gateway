// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Settings of the smart-HTTP proxy beyond those every gateway shares (GatewayConfig). */
export const SmartHttpConfig = z
  .object({
    realm: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^"\\\n\0]+$/)
      .default('git-gateway')
      .describe(
        'Realm named in the WWW-Authenticate: Basic challenge of a 401, which git credential helpers show and key on; 1–100 characters without quotes, backslash, newline or NUL. Default "git-gateway".',
      ),
    maxPushHeadBytes: z
      .int()
      .min(4096)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024)
      .describe(
        'Most bytes of a push read before the pack (update commands, capabilities, push options); a larger head is refused. 4 KiB–64 MiB, default 8 MiB (8388608).',
      ),
    maxAncestryReads: z
      .int()
      .min(1)
      .max(100_000)
      .default(2000)
      .describe(
        'Most commits read from the storage backend to prove that a fast-forward-only update is a fast-forward; past it the update is refused as unverifiable. 1–100000, default 2000.',
      ),
    maxScannedCommitBytes: z
      .int()
      .min(1024 * 1024)
      .max(256 * 1024 * 1024)
      .default(32 * 1024 * 1024)
      .describe(
        'Most bytes of commit objects kept while scanning a pushed pack for ancestry; a push needing more is refused as unverifiable. 1 MiB–256 MiB, default 32 MiB (33554432).',
      ),
    decisionCacheEntries: z
      .int()
      .min(0)
      .max(1_000_000)
      .default(10_000)
      .describe(
        'Most authentication and authorization decisions held in the per-isolate cache, oldest evicted first; 0 disables the cache. Default 10000. How long entries live is GatewayConfig.authCacheSeconds.',
      ),
    maxAuditReportBytes: z
      .int()
      .min(0)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024)
      .describe(
        'Most bytes of a storage host push response kept to read its per-ref report for the audit event and the push event; past it the refs are audited as "unknown" and no push event is sent. 0 skips reading reports for audit; when an onPush hook is set the report is still read, up to the 1 MiB default. Default 1 MiB (1048576).',
      ),
    allowedPushOptions: z
      .array(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[^\s\0=]+$/)
          .describe(
            'A push option name, the part of a "git push -o <name>[=<value>]" option before the first "="; 1–100 characters without whitespace, NUL or "=". Matched exactly and case-sensitively.',
          ),
      )
      .max(100)
      .default([])
      .describe(
        "Push option names the proxy forwards to the storage host; a push carrying any other option is refused before it reaches storage. The host runs push options as the gateway's own credential (GitLab's merge_request.* and ci.variable, for example), so each one bypasses branch policy unless refused here. At most 100; default none, so every push option is refused.",
      ),
  })
  .strict()
  .meta({
    id: 'SmartHttpConfig',
    title: 'Smart-HTTP proxy configuration',
    description:
      'Limits and names used by the smart-HTTP proxy. Every field has a default, so {} is a complete configuration.',
    examples: [
      {
        realm: 'git-gateway',
        maxPushHeadBytes: 8_388_608,
        maxAncestryReads: 2000,
        maxScannedCommitBytes: 33_554_432,
        decisionCacheEntries: 10_000,
        maxAuditReportBytes: 1_048_576,
        allowedPushOptions: ['ci.skip'],
      },
    ],
  });

/** A smart-HTTP configuration as written (defaults optional). */
export type SmartHttpConfigInput = z.input<typeof SmartHttpConfig>;
/** A complete smart-HTTP configuration, inferred from {@link SmartHttpConfig}. */
export type SmartHttpConfig = z.output<typeof SmartHttpConfig>;
