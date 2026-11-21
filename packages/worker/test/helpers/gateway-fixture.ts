// SPDX-License-Identifier: Apache-2.0
import type { AuditEvent } from '@leed-ai/git-gateway-contract/proxy/audit-event';
import type { BranchPolicyConfigInput } from '@leed-ai/git-gateway-contract/proxy/branch-rule';
import type { BranchPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PrincipalInput } from '@leed-ai/git-gateway-contract/proxy/principal';
import { readCredential } from '@leed-ai/git-gateway-contract/proxy/request-credential';
import type { SmartHttpConfigInput } from '@leed-ai/git-gateway-contract/proxy/smart-http-config';

import { createGatewayApp } from '../../src/gateway-app.ts';
import type { LogEntry } from '../../src/logging/logger.ts';
import { RuleBranchPolicy } from '../../src/policy/rule-branch-policy.ts';
import { FakeBackend } from './fake-backend.ts';
import { FakeUpstream } from './fake-upstream.ts';

/** Tokens the fixture's authenticator knows, by secret. */
export const PRINCIPALS: Readonly<Record<string, PrincipalInput>> = {
  'alice-token': { subject: 'alice', roles: ['maintainer'] },
  'bob-token': { subject: 'bob', roles: ['editor'] },
  'reader-token': { subject: 'reader', roles: ['reader'] },
};

/** Options of {@link gatewayFixture}. */
export interface FixtureOptions {
  readonly policy?: BranchPolicyConfigInput;
  /** A branch policy to use instead of a RuleBranchPolicy built from `policy`. */
  readonly branchPolicy?: BranchPolicy;
  readonly smartHttp?: SmartHttpConfigInput;
  readonly authCacheSeconds?: number;
  readonly principals?: Readonly<Record<string, PrincipalInput>>;
  readonly now?: () => Date;
}

/**
 * A gateway app over a fake backend and storage host, a token authenticator (the Basic password
 * or Bearer token names the principal), an authorizer letting "reader" only read, and the rule
 * branch policy. Records authenticator calls, audit events and log entries.
 */
export function gatewayFixture(options: FixtureOptions = {}) {
  const backend = new FakeBackend();
  const upstream = new FakeUpstream();
  const audits: AuditEvent[] = [];
  const logs: LogEntry[] = [];
  const calls = { authenticate: 0, authorize: 0 };
  const principals = options.principals ?? PRINCIPALS;
  const app = createGatewayApp({
    backend,
    authenticator: {
      authenticate: async (request) => {
        calls.authenticate += 1;
        const credential = readCredential(request);
        return credential === null ? null : (principals[credential.secret] ?? null);
      },
    },
    authorizer: {
      authorize: async (principal, _repo, operation) => {
        calls.authorize += 1;
        return operation === 'read' || !principal.roles.includes('reader');
      },
    },
    branchPolicy: options.branchPolicy ?? new RuleBranchPolicy(options.policy ?? {}),
    audit: (event) => {
      audits.push(event);
    },
    logger: { log: (entry) => logs.push(entry) },
    gateway: { authCacheSeconds: options.authCacheSeconds ?? 60 },
    smartHttp: options.smartHttp ?? {},
    fetch: upstream.fetch,
    ...(options.now ? { now: options.now } : {}),
  });
  return { app, backend, upstream, audits, logs, calls };
}

/** An Authorization header carrying `token` as git sends it (the Basic password). */
export function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`git:${token}`)}` };
}

/** Lets deferred work (audit hooks) finish. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
