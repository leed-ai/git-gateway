// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

import { invalidInput } from '../gateway-error.ts';

/** The input and output schema of one RPC method. */
export interface MethodSchemas<I extends z.ZodType, O extends z.ZodType> {
  readonly input: I;
  readonly output: O;
}

/**
 * Runs one RPC method the way every implementation must: parse the input (invalid_input on
 * failure), do the work, and parse the result with the output schema, so the reference can never
 * return something its own contract rejects.
 */
export async function runMethod<I extends z.ZodType, O extends z.ZodType>(
  schemas: MethodSchemas<I, O>,
  input: unknown,
  work: (parsed: z.output<I>) => Promise<z.input<O>>,
): Promise<z.output<O>> {
  const parsed = schemas.input.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);
  return schemas.output.parse(await work(parsed.data));
}
