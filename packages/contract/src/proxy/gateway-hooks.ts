// SPDX-License-Identifier: Apache-2.0
import type { RefUpdate } from '../schemas/ref-update.ts';
import type { RepoName } from '../schemas/names.ts';
import type { AuditEvent } from './audit-event.ts';
import type { GitOperation } from './git-operation.ts';
import type { PolicyResult } from './policy-result.ts';
import type { Principal, PrincipalInput } from './principal.ts';

/**
 * Establishes who a smart-HTTP request acts for. git sends credentials as HTTP Basic; the
 * password is a bearer credential (an OAuth access token, a JWT, an API key), so a credential
 * helper can supply one. Return null when the request carries no valid credential — the gateway
 * then answers 401 with `WWW-Authenticate: Basic` so git asks its credential helper. The result
 * is parsed with {@link Principal} before use.
 */
export interface Authenticator {
  authenticate(request: Request): Promise<PrincipalInput | null>;
}

/** Decides whether a principal may read (clone, fetch) or write (push) a repository. */
export interface Authorizer {
  authorize(principal: Principal, repo: RepoName, operation: GitOperation): Promise<boolean>;
}

/**
 * Decides, per ref, whether a push may update it. Called with every branch or tag update of a
 * push (refs in other namespaces are refused before it is called). Synchronous: it decides from
 * the principal and the update commands alone; the gateway proves fast-forwards itself when the
 * result asks for "fast-forward-only". The result is parsed with {@link PolicyResult}.
 */
export interface BranchPolicy {
  check(principal: Principal, repo: RepoName, updates: readonly RefUpdate[]): PolicyResult;
}

/**
 * Receives every authenticated smart-HTTP operation once it is decided. It runs after the
 * response is under way (through `waitUntil` when the runtime has it); a failure is logged and
 * never changes the response.
 */
export type AuditHook = (event: AuditEvent) => void | Promise<void>;
