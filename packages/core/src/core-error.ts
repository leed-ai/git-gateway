// SPDX-License-Identifier: Apache-2.0
import { CoreErrorBody, type CoreErrorCode } from './schemas/core-error-body.ts';

/** The body of the core error with a given code. */
export type CoreErrorOf<C extends CoreErrorCode> = Extract<CoreErrorBody, { code: C }>;

/** The error the core library throws for protocol and object problems; `body` is a {@link CoreErrorBody}. */
export class CoreError<C extends CoreErrorCode = CoreErrorCode> extends Error {
  override readonly name = 'CoreError';
  readonly body: CoreErrorOf<C>;

  constructor(body: CoreErrorOf<C>) {
    super(body.message);
    this.body = body;
  }

  /** The error's code. */
  get code(): C {
    return this.body.code;
  }
}

/** Builds a {@link CoreError} from a code, message and details, validating them against the schema. */
export function coreError<C extends CoreErrorCode>(
  code: C,
  message: string,
  details: CoreErrorOf<C>['details'],
): CoreError {
  return new CoreError(CoreErrorBody.parse({ code, message, details }));
}

/** True when `thrown` is a {@link CoreError}, and has `code` when one is given. */
export function isCoreError(thrown: unknown, code?: CoreErrorCode): thrown is CoreError {
  return thrown instanceof CoreError && (code === undefined || thrown.code === code);
}
