// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';

import { GatewayErrorBody, type GatewayErrorCode } from './schemas/gateway-error-body.ts';

/** The body of the error with a given code. */
export type GatewayErrorOf<C extends GatewayErrorCode> = Extract<GatewayErrorBody, { code: C }>;

const PREFIX = 'GatewayError ';

/**
 * The error every gateway call throws. `body` is a {@link GatewayErrorBody}; the message carries
 * the same body as JSON after a fixed prefix, so it survives transports (such as Workers RPC)
 * that keep only an error's message.
 */
export class GatewayError<C extends GatewayErrorCode = GatewayErrorCode> extends Error {
  override readonly name = 'GatewayError';
  readonly body: GatewayErrorOf<C>;

  constructor(body: GatewayErrorOf<C>) {
    super(`${PREFIX}${JSON.stringify(body)}`);
    this.body = body;
  }

  /** The error's code. */
  get code(): C {
    return this.body.code;
  }
}

/** Builds a {@link GatewayError} from a code, message and details, validating them against the schema. */
export function gatewayError<C extends GatewayErrorCode>(
  code: C,
  message: string,
  details: GatewayErrorOf<C>['details'],
): GatewayError {
  return new GatewayError(GatewayErrorBody.parse({ code, message, details }));
}

/**
 * Recovers the body of a gateway error from anything thrown: a {@link GatewayError}, or any error
 * whose message is one (e.g. after crossing a Workers RPC boundary). Null for anything else.
 */
export function readGatewayError(thrown: unknown): GatewayErrorBody | null {
  if (thrown instanceof GatewayError) return thrown.body;
  if (!(thrown instanceof Error)) return null;
  const at = thrown.message.indexOf(PREFIX);
  if (at === -1) return null;
  try {
    const parsed = GatewayErrorBody.safeParse(JSON.parse(thrown.message.slice(at + PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when `thrown` is a gateway error, and has `code` when one is given. */
export function isGatewayError(thrown: unknown, code?: GatewayErrorCode): boolean {
  const body = readGatewayError(thrown);
  return body !== null && (code === undefined || body.code === code);
}

/** Converts Zod validation issues into an invalid_input {@link GatewayError}. */
export function invalidInput(error: z.ZodError): GatewayError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message.length > 0 ? issue.message : 'Invalid value',
  }));
  return gatewayError('invalid_input', 'Invalid input', {
    issues: issues.length > 0 ? issues : [{ path: '', message: 'Invalid value' }],
  });
}
