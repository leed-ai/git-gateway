// SPDX-License-Identifier: Apache-2.0
import { AuditEvent, type AuditRefOutcome } from '@leed-ai/git-gateway-contract/proxy/audit-event';
import type { AuditHook } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';

import type { Logger } from '../logging/logger.ts';
import type { GitRequest } from '../proxy/git-route.ts';

/** What one request contributes to its audit event. */
export interface AuditFacts {
  readonly requestId: string;
  readonly principal: Principal;
  readonly git: GitRequest;
  readonly outcome: AuditEvent['outcome'];
  readonly reason: string | null;
  readonly refs: readonly AuditRefOutcome[];
}

/** Runs work after the response, through the runtime's `waitUntil` when there is one. */
export type Defer = (work: Promise<unknown>) => void;

/**
 * Builds audit events and hands them to the deployment's hook without ever affecting the
 * response: the hook runs deferred, and a hook that throws (or an event the schema rejects) is
 * logged and dropped.
 */
export class AuditRecorder {
  readonly #hook: AuditHook | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(hook: AuditHook | undefined, logger: Logger, now: () => Date) {
    this.#hook = hook;
    this.#logger = logger;
    this.#now = now;
  }

  /** Whether a hook is configured (when not, callers can skip gathering facts). */
  get enabled(): boolean {
    return this.#hook !== undefined;
  }

  /** Records one event, deferred; `facts` may be a promise (for a push whose report is still streaming). */
  record(facts: AuditFacts | Promise<AuditFacts>, defer: Defer, requestId: string): void {
    const hook = this.#hook;
    if (hook === undefined) return;
    defer(
      (async () => {
        try {
          const resolved = await facts;
          const event = AuditEvent.parse({
            requestId: resolved.requestId,
            at: this.#now().toISOString(),
            principal: resolved.principal,
            repo: resolved.git.repo,
            operation: resolved.git.operation,
            endpoint: resolved.git.endpoint,
            outcome: resolved.outcome,
            reason: resolved.reason,
            refs: resolved.refs,
          });
          await hook(event);
        } catch (error) {
          this.#logger.log({
            level: 'error',
            message: 'audit hook failed',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })(),
    );
  }
}
