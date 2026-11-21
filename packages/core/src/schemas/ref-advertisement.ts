// SPDX-License-Identifier: Apache-2.0
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { Capability, GitRefName } from './receive-pack.ts';

const EXAMPLE_SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** The two smart-HTTP services. */
export const GitService = z.enum(['git-upload-pack', 'git-receive-pack']).meta({
  id: 'GitService',
  title: 'Git service',
  description: 'A git smart-HTTP service, as named in "info/refs?service=…" and the POST endpoint.',
  enumDescriptions: {
    'git-upload-pack': 'Fetch and clone: the server sends objects to the client.',
    'git-receive-pack': 'Push: the client sends objects and ref updates to the server.',
  },
  examples: ['git-upload-pack'],
});

/** A smart-HTTP service, inferred from {@link GitService}. */
export type GitService = z.infer<typeof GitService>;

/** One advertised ref. */
export const AdvertisedRef = z
  .object({
    name: z
      .union([
        GitRefName.describe('A fully qualified ref under "refs/".'),
        z.literal('HEAD').describe('The symbolic HEAD, advertised by upload-pack when it resolves.'),
      ])
      .describe('The ref name as advertised.'),
    sha: Sha.describe('The object id the ref names.'),
    peeled: Sha.nullable().describe(
      'For an annotated tag, the id of the object it points at (the "<ref>^{}" line); null otherwise.',
    ),
  })
  .strict()
  .meta({
    id: 'AdvertisedRef',
    title: 'Advertised ref',
    description: 'One ref line of a protocol v0/v1 ref advertisement.',
    examples: [{ name: 'refs/heads/main', sha: EXAMPLE_SHA, peeled: null }],
  });

/** An advertised ref, inferred from {@link AdvertisedRef}. */
export type AdvertisedRef = z.infer<typeof AdvertisedRef>;

/** A protocol v0/v1 ref advertisement, as served at "info/refs?service=…". */
export const RefAdvertisement = z
  .object({
    service: GitService,
    refs: z
      .array(AdvertisedRef)
      .describe('Every advertised ref in the order sent; empty for an empty repository.'),
    capabilities: z
      .array(Capability)
      .describe('The capabilities sent after the NUL on the first line, in order.'),
    symrefs: z
      .record(
        z.string().min(1).describe('The symbolic ref, e.g. "HEAD".'),
        GitRefName.describe('The ref it points at, e.g. "refs/heads/main".'),
      )
      .describe('Symbolic refs from "symref=<from>:<to>" capabilities, e.g. HEAD → refs/heads/main.'),
  })
  .strict()
  .meta({
    id: 'RefAdvertisement',
    title: 'Ref advertisement',
    description:
      'The protocol v0/v1 answer to GET info/refs?service=…: the refs a repository has, the capabilities the server supports and the symbolic refs it reports.',
    examples: [
      {
        service: 'git-upload-pack',
        refs: [{ name: 'refs/heads/main', sha: EXAMPLE_SHA, peeled: null }],
        capabilities: ['side-band-64k', 'symref=HEAD:refs/heads/main'],
        symrefs: { HEAD: 'refs/heads/main' },
      },
    ],
  });

/** A ref advertisement, inferred from {@link RefAdvertisement}. */
export type RefAdvertisement = z.infer<typeof RefAdvertisement>;
