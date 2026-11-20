// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** How the GitLab backend reaches its GitLab instance. */
export const GitLabBackendConfig = z
  .object({
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .default('https://gitlab.com')
      .describe(
        'Base URL of the GitLab instance, without a trailing "/api/v4". Default "https://gitlab.com".',
      ),
    token: z
      .string()
      .min(1)
      .describe(
        'A GitLab access token (personal, group or project access token, or OAuth) with the api, read_repository and write_repository scopes on the namespace. Secret: sent as a PRIVATE-TOKEN header to the API and as the HTTP Basic password to git.',
      ),
    namespace: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/)
      .describe(
        'Full path of the group the repositories live in, e.g. "acme/sites". A repository named <repo> is the project <namespace>/<repo>.',
      ),
    namespaceId: z
      .int()
      .positive()
      .optional()
      .describe(
        'Numeric id of that group. Absent: looked up from `namespace` the first time a repository is created.',
      ),
    gitUsername: z
      .string()
      .min(1)
      .default('oauth2')
      .describe(
        'HTTP Basic username sent with the token to git; GitLab ignores it for access tokens. Default "oauth2".',
      ),
  })
  .strict()
  .meta({
    id: 'GitLabBackendConfig',
    title: 'GitLab backend configuration',
    description:
      'Where the GitLab storage backend keeps repositories and the credential it uses. Each repository is a private project in one group.',
    examples: [
      {
        baseUrl: 'https://gitlab.com',
        token: 'glpat-example',
        namespace: 'acme/sites',
        gitUsername: 'oauth2',
      },
    ],
  });

/** GitLab backend configuration as accepted (defaults optional). */
export type GitLabBackendConfig = z.input<typeof GitLabBackendConfig>;
