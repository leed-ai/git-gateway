// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** A UTC timestamp in ISO 8601 form. */
export const Timestamp = z.iso.datetime().meta({
  id: 'Timestamp',
  title: 'Timestamp',
  description:
    'A point in time as an ISO 8601 UTC timestamp ending in "Z", with optional fractional seconds (e.g. 2026-11-20T09:30:00.000Z).',
  examples: ['2026-11-20T09:30:00.000Z'],
});

/** A UTC timestamp, inferred from {@link Timestamp}. */
export type Timestamp = z.infer<typeof Timestamp>;

/** The name and email a commit is attributed to. */
export const Identity = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^<>\n\0]+$/)
      .describe('Display name, 1–255 characters, without "<", ">", newlines or NUL (git cannot store them).'),
    email: z.email().max(255).describe('Email address, at most 255 characters.'),
  })
  .strict()
  .meta({
    id: 'Identity',
    title: 'Identity',
    description: 'The name and email a commit is attributed to, as an author or a committer.',
    examples: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
  });

/** A commit identity, inferred from {@link Identity}. */
export type Identity = z.infer<typeof Identity>;

/** An identity together with when it acted. */
export const Signature = z
  .object({
    name: Identity.shape.name,
    email: Identity.shape.email,
    date: Timestamp.describe(
      'When this person authored or committed the change, as an ISO 8601 UTC timestamp.',
    ),
  })
  .strict()
  .meta({
    id: 'Signature',
    title: 'Signature',
    description:
      'An identity together with the time it authored or committed a commit, as stored in the commit.',
    examples: [{ name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-11-20T09:30:00.000Z' }],
  });

/** An identity with a date, inferred from {@link Signature}. */
export type Signature = z.infer<typeof Signature>;
