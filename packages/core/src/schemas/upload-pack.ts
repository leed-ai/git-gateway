// SPDX-License-Identifier: Apache-2.0
import { Sha } from '@leed-ai/git-gateway-contract/schemas/sha';
import { z } from 'zod';

import { Bytes } from './packet.ts';
import { Capability } from './receive-pack.ts';

const EXAMPLE_SHA = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';

/** A partial-clone object filter. */
export const ObjectFilter = z
  .string()
  .regex(/^(?:blob:none|blob:limit=\d+[kmg]?|tree:\d+)$/)
  .meta({
    id: 'ObjectFilter',
    title: 'Object filter',
    description:
      'A partial-clone filter spec the server applies to the pack ("filter" capability): "blob:none" omits every blob, "blob:limit=<n>[kmg]" omits blobs larger than n bytes, "tree:<depth>" omits trees and blobs at or below that depth from the root tree (tree:0 sends commits only).',
    examples: ['tree:0', 'blob:none'],
  });

/** A partial-clone filter, inferred from {@link ObjectFilter}. */
export type ObjectFilter = z.infer<typeof ObjectFilter>;

/** A protocol v0/v1 git-upload-pack request. */
export const UploadPackRequest = z
  .object({
    wants: z
      .array(Sha.describe('An object the client wants, with everything it needs.'))
      .min(1)
      .max(10_000)
      .describe('The objects to send: 1–10000 ids, normally ref tips. Duplicates are sent once.'),
    haves: z
      .array(Sha.describe('An object the client already has.'))
      .max(10_000)
      .default([])
      .describe('Objects the client already has; the server leaves out what they reach. Default none.'),
    capabilities: z
      .array(Capability)
      .default(['side-band-64k', 'ofs-delta', 'no-progress'])
      .describe(
        'Capabilities requested on the first want line. Default side-band-64k, ofs-delta and no-progress; "shallow" and "filter" are added when `depth` or `filter` is set.',
      ),
    depth: z
      .int()
      .min(1)
      .max(2_147_483_647)
      .optional()
      .describe(
        'Shallow fetch: send only this many commits of history from each want ("deepen <n>"). Absent: full history.',
      ),
    filter: ObjectFilter.optional().describe('Partial-clone filter for the pack. Absent: no filter.'),
  })
  .strict()
  .meta({
    id: 'UploadPackRequest',
    title: 'upload-pack request',
    description:
      'A stateless (smart-HTTP) protocol v0/v1 git-upload-pack request: want lines with capabilities, optional deepen and filter lines, have lines, then "done" — one round, no multi-round negotiation.',
    examples: [
      { wants: [EXAMPLE_SHA], haves: [], capabilities: ['side-band-64k'], depth: 1, filter: 'tree:0' },
    ],
  });

/** A git-upload-pack request as accepted (defaults optional). */
export type UploadPackRequestInput = z.input<typeof UploadPackRequest>;

/** The parsed answer to an upload-pack request. */
export const UploadPackResponse = z
  .object({
    shallow: z
      .array(Sha.describe('A commit whose parents the client must treat as absent.'))
      .describe('Commits reported by "shallow <id>" lines after a deepen; empty without one.'),
    acknowledged: z
      .array(Sha.describe('A have the server found in common.'))
      .describe('Ids from "ACK <id>" lines; empty when the server answered "NAK".'),
    pack: Bytes.describe(
      'The packfile bytes, side-band channel 1 joined; empty when the server sent no pack.',
    ),
    progress: z.string().describe('Text the server sent on side-band channel 2; empty with no-progress.'),
  })
  .strict()
  .meta({
    id: 'UploadPackResponse',
    title: 'upload-pack response',
    description:
      'The answer to a stateless git-upload-pack request: shallow boundary, acknowledgements, and the packfile demultiplexed from side-band channel 1.',
    examples: [{ shallow: [], acknowledged: [], pack: new Uint8Array(0), progress: '' }],
  });

/** A parsed upload-pack response, inferred from {@link UploadPackResponse}. */
export type UploadPackResponse = z.infer<typeof UploadPackResponse>;
