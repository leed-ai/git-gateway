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
    frontedProjects: z
      .object({
        prefix: z
          .string()
          .min(1)
          .max(20)
          .regex(/^[A-Za-z][A-Za-z0-9_.]*-$/)
          .default('gl-')
          .describe(
            'Prefix of the reserved repository names that address an existing project by id: <prefix><projectId>, e.g. "gl-1234" for project 1234. 1–20 characters, starting with a letter and ending in "-". Default "gl-".',
          ),
        namespace: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/)
          .describe(
            'Full path of the group whose projects (at any depth below it) may be fronted, e.g. "acme/customers". A project id outside it answers repo_not_found, so the token\'s other projects stay unreachable.',
          ),
      })
      .strict()
      .optional()
      .describe(
        'Fronts projects that already exist outside `namespace`, addressed by project id instead of by name. A repository named <prefix><projectId> is project <projectId>, provided it lives under `frontedProjects.namespace`; createRepo and deleteRepo refuse such names with invalid_input, since the gateway did not create those projects and must not remove them. Absent: every name is a project in `namespace`.',
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
      {
        baseUrl: 'https://gitlab.com',
        token: 'glpat-example',
        namespace: 'acme/sites',
        frontedProjects: { prefix: 'gl-', namespace: 'acme/customers' },
        gitUsername: 'oauth2',
      },
    ],
  });

/** GitLab backend configuration as accepted (defaults optional). */
export type GitLabBackendConfig = z.input<typeof GitLabBackendConfig>;
