// SPDX-License-Identifier: Apache-2.0
import {
  BranchPolicyConfig,
  type BranchPermissions,
  type BranchPolicyConfigInput,
  type PrincipalSelector,
} from '@leed-ai/git-gateway-contract/proxy/branch-rule';
import type { BranchPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PolicyResult, RefDecision } from '@leed-ai/git-gateway-contract/proxy/policy-result';
import type { Principal } from '@leed-ai/git-gateway-contract/proxy/principal';
import type { RefUpdate } from '@leed-ai/git-gateway-contract/schemas/ref-update';
import { ZERO_SHA } from '@leed-ai/git-gateway-contract/schemas/sha';

import { compileRefPattern } from './ref-pattern.ts';

interface CompiledRule extends BranchPermissions {
  readonly matches: (ref: string) => boolean;
  readonly message: string | null;
}

/** Whether a principal is selected (a null selector selects everyone). */
function selects(selector: PrincipalSelector | null, principal: Principal): boolean {
  if (selector === null) return true;
  return (
    selector.subjects.includes(principal.subject) ||
    principal.roles.some((role) => selector.roles.includes(role))
  );
}

/** A short ref name for messages: "main" for refs/heads/main, "tag v1" for refs/tags/v1. */
function describeRef(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  return `tag ${ref.slice('refs/tags/'.length)}`;
}

/**
 * The reference {@link BranchPolicy}: an ordered list of {@link BranchRule}s, first match wins,
 * with a fallback for refs no rule matches. Each rule says who may push the refs it matches,
 * whether they may be created or deleted, and whether force pushes are allowed; an update that is
 * allowed but not forced comes back "fast-forward-only" for the gateway to prove.
 */
export class RuleBranchPolicy implements BranchPolicy {
  readonly #rules: readonly CompiledRule[];
  readonly #fallback: CompiledRule;

  constructor(config: BranchPolicyConfigInput = {}) {
    const parsed = BranchPolicyConfig.parse(config);
    this.#rules = parsed.rules.map((rule) => ({ ...rule, matches: compileRefPattern(rule.pattern) }));
    this.#fallback = { ...parsed.fallback, matches: () => true, message: null };
  }

  check(principal: Principal, _repo: string, updates: readonly RefUpdate[]): PolicyResult {
    return { refs: updates.map((update) => this.#decide(principal, update)) };
  }

  #decide(principal: Principal, update: RefUpdate): RefDecision {
    const rule = this.#rules.find((candidate) => candidate.matches(update.ref)) ?? this.#fallback;
    const name = describeRef(update.ref);
    const deny = (what: string): RefDecision => ({
      ref: update.ref,
      decision: 'deny',
      reason: rule.message ?? `${what} ${name} is not allowed`,
    });
    if (!selects(rule.pushers, principal)) return deny('pushing to');
    if (update.oldSha === ZERO_SHA)
      return rule.create ? { ref: update.ref, decision: 'allow' } : deny('creating');
    if (update.newSha === ZERO_SHA)
      return rule.delete ? { ref: update.ref, decision: 'allow' } : deny('deleting');
    if (rule.forcePush) return { ref: update.ref, decision: 'allow' };
    return {
      ref: update.ref,
      decision: 'fast-forward-only',
      reason: rule.message ?? `force-pushing ${name} is not allowed`,
    };
  }
}
