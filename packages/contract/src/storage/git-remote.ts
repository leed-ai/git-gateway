// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** What a git remote is minted for. */
export const GitAccess = z.enum(['read', 'write']).meta({
  id: 'GitAccess',
  title: 'Git access',
  description: 'What a git remote from StorageBackend.gitRemote() is allowed to do on the storage host.',
  enumDescriptions: {
    read: 'Fetch and clone only (git-upload-pack).',
    write: 'Fetch, clone and push (git-upload-pack and git-receive-pack).',
  },
  examples: ['read', 'write'],
});

/** A git access level, inferred from {@link GitAccess}. */
export type GitAccess = z.infer<typeof GitAccess>;

/** Where and how to reach a repository over git smart HTTP on the storage host. */
export const GitRemote = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .describe(
        'The repository\'s smart-HTTP base URL on the storage host, ending in ".git"; append "/info/refs?service=…", "/git-upload-pack" or "/git-receive-pack". Never holds a credential.',
      ),
    headers: z
      .record(
        z.string().min(1).describe('HTTP header name, e.g. "Authorization".'),
        z.string().describe('HTTP header value. Secret when it carries a credential.'),
      )
      .describe(
        'HTTP headers every request to the remote must carry, typically the short-lived credential as "Authorization". Secret: never log it or hand it to a git client.',
      ),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the credential in `headers` stops working, as an ISO 8601 UTC timestamp; null when the host does not say (for example a long-lived access token).',
      ),
  })
  .strict()
  .meta({
    id: 'GitRemote',
    title: 'Git remote',
    description:
      'A storage-host git remote minted for one use: the smart-HTTP URL plus the headers that authorize it. The gateway proxies to it; the credential never reaches a git client.',
    examples: [
      {
        url: 'https://artifacts.example.com/git/default/acme-raw-content.git',
        headers: { Authorization: 'Bearer art_v2_example' },
        expiresAt: '2026-11-20T09:35:00.000Z',
      },
    ],
  });

/** A storage-host git remote, inferred from {@link GitRemote}. */
export type GitRemote = z.infer<typeof GitRemote>;
