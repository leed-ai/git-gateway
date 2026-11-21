// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });

/** The Cloudflare API v4 response envelope around a result. */
export function cloudflareEnvelope<S extends z.ZodType>(result: S) {
  return z
    .object({
      success: z
        .literal(true)
        .describe('Always true for a successful response; failures are thrown by the SDK.'),
      result: result.describe('The payload of the response.'),
      errors: z
        .array(z.unknown().describe('An error entry; empty on success.'))
        .describe('Errors; empty on success.'),
      messages: z
        .array(z.unknown().describe('An informational message.'))
        .describe('Informational messages.'),
    })
    .describe('The Cloudflare API v4 envelope: success flag, result, errors and messages.');
}

/** A repository as the Artifacts REST API describes it. */
export const ArtifactsRestRepo = z
  .object({
    id: z.string().min(1).describe('Unique repository id.'),
    name: z.string().min(1).describe('Repository name within the namespace.'),
    description: z
      .string()
      .nullable()
      .optional()
      .describe('Repository description; null or absent when none.'),
    default_branch: z.string().min(1).describe('Default branch name.'),
    created_at: timestamp.optional().describe('Creation time, ISO 8601; absent in a create result.'),
    remote: z.url().describe('Git remote URL of the repository.'),
  })
  .meta({
    id: 'ArtifactsRestRepo',
    title: 'Artifacts REST repository',
    description:
      'A repository from the Artifacts REST API (GET or POST …/namespaces/{namespace}/repos). Extra fields are ignored.',
    examples: [
      {
        id: 'tq6o4x0af6vky45b',
        name: 'acme-raw-content',
        description: null,
        default_branch: 'main',
        created_at: '2026-11-20T09:30:00.000Z',
        remote: 'https://acct.artifacts.cloudflare.net/git/default/acme-raw-content.git',
      },
    ],
  });

/** An Artifacts repository from the REST API, inferred from {@link ArtifactsRestRepo}. */
export type ArtifactsRestRepo = z.infer<typeof ArtifactsRestRepo>;

/** A token from the Artifacts REST API. */
export const ArtifactsRestToken = z
  .object({
    id: z.string().min(1).describe('Unique token id, used to revoke it.'),
    plaintext: z.string().min(1).describe('The token. Secret: authenticates git only, never REST.'),
    scope: z.enum(['read', 'write']).meta({
      description: 'What the token allows.',
      enumDescriptions: { read: 'Fetch and clone only.', write: 'Fetch, clone and push.' },
    }),
    expires_at: timestamp.describe('When the token stops working, ISO 8601.'),
  })
  .meta({
    id: 'ArtifactsRestToken',
    title: 'Artifacts REST token',
    description: 'A repository token minted through POST …/namespaces/{namespace}/tokens.',
    examples: [
      {
        id: 'hh50uo1kos7zorfv',
        plaintext: 'art_v2_example',
        scope: 'read',
        expires_at: '2026-11-20T09:35:00.000Z',
      },
    ],
  });

/** An Artifacts token from the REST API, inferred from {@link ArtifactsRestToken}. */
export type ArtifactsRestToken = z.infer<typeof ArtifactsRestToken>;

/** A namespace from the Artifacts REST API. */
export const ArtifactsRestNamespace = z
  .object({
    name: z.string().min(1).describe('The namespace name.'),
  })
  .meta({
    id: 'ArtifactsRestNamespace',
    title: 'Artifacts REST namespace',
    description:
      'A namespace from the Artifacts REST API; only its name is relied on, other fields are ignored.',
    examples: [{ name: 'default' }],
  });

/** An Artifacts namespace from the REST API, inferred from {@link ArtifactsRestNamespace}. */
export type ArtifactsRestNamespace = z.infer<typeof ArtifactsRestNamespace>;
