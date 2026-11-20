// SPDX-License-Identifier: Apache-2.0
import { readGatewayError, type GatewayErrorOf } from '../gateway-error.ts';
import type { GatewayErrorBody, GatewayErrorCode } from '../schemas/gateway-error-body.ts';

/** The error a behaviour case throws when the implementation under test breaks a rule. */
export class BehaviourFailure extends Error {
  override readonly name = 'BehaviourFailure';
}

const show = (value: unknown): string => JSON.stringify(value, null, 2) ?? String(value);

/** True when two values are structurally equal (plain objects, arrays and primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a).filter((key) => Reflect.get(a, key) !== undefined);
  const keysB = Object.keys(b).filter((key) => Reflect.get(b, key) !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(Reflect.get(a, key), Reflect.get(b, key)));
}

/** Fails unless `condition` holds. */
export function assertTrue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new BehaviourFailure(message);
}

/** Fails unless `actual` structurally equals `expected`. */
export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    throw new BehaviourFailure(`${message}\nexpected: ${show(expected)}\nactual:   ${show(actual)}`);
  }
}

function hasCode<C extends GatewayErrorCode>(body: GatewayErrorBody, code: C): body is GatewayErrorOf<C> {
  return body.code === code;
}

/** Awaits `call`, fails unless it rejects with a gateway error of `code`, and returns that error's body. */
export async function expectGatewayError<C extends GatewayErrorCode>(
  call: Promise<unknown>,
  code: C,
): Promise<GatewayErrorOf<C>> {
  let outcome: unknown;
  try {
    outcome = await call;
  } catch (thrown) {
    const body = readGatewayError(thrown);
    if (body !== null && hasCode(body, code)) return body;
    throw new BehaviourFailure(`expected a ${code} gateway error, got: ${show(body ?? String(thrown))}`);
  }
  throw new BehaviourFailure(`expected a ${code} gateway error, but the call resolved to ${show(outcome)}`);
}

function hasStatus<T extends { status: string }, S extends T['status']>(
  output: T,
  status: S,
): output is Extract<T, { status: S }> {
  return output.status === status;
}

/** Fails unless the output has `status`, and returns it narrowed to that branch. */
export function expectStatus<T extends { status: string }, S extends T['status']>(
  output: T,
  status: S,
): Extract<T, { status: S }> {
  if (hasStatus(output, status)) return output;
  throw new BehaviourFailure(`expected status "${status}", got ${show(output)}`);
}

/** Fails when the value is null or undefined, and returns it otherwise. */
export function present<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new BehaviourFailure(message);
  return value;
}
