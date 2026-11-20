// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** A git object id: 40-character lowercase hex SHA-1. */
export const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .meta({
    id: 'Sha',
    title: 'Object id',
    description:
      'A git object id: 40-character lowercase hex SHA-1 naming a commit, tree or blob. Never abbreviated.',
    examples: ['8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a'],
  });

/** A git object id, inferred from {@link Sha}. */
export type Sha = z.infer<typeof Sha>;

/** The all-zero object id git uses for "no object". */
export const ZERO_SHA = '0000000000000000000000000000000000000000';
