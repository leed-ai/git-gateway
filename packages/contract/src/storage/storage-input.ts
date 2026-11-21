// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

import { invalidInput } from '../gateway-error.ts';

/**
 * Parses one argument of a {@link StorageBackend} call with its contract schema, throwing an
 * invalid_input GatewayError (never a ZodError) when it does not match.
 */
export function parseStorageInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput(parsed.error);
  return parsed.data;
}
