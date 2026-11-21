// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

import type { AnySchema } from './zod-node.ts';

/**
 * The metadata the harness reads. Named schemas carry `id`, `title`, `description` and `examples`;
 * enums carry `enumDescriptions`, one description per member value.
 */
export interface SchemaMetadata {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly examples?: unknown;
  readonly enumDescriptions?: unknown;
}

/** Metadata registered for this exact schema instance in Zod's global registry, if any. */
export function readMetadata(schema: AnySchema): SchemaMetadata | undefined {
  return z.globalRegistry.get(schema) as SchemaMetadata | undefined;
}

/** True when the value is a string with visible text. */
export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
