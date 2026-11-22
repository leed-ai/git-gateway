// SPDX-License-Identifier: Apache-2.0
import type { PushPolicy } from '@leed-ai/git-gateway-contract/proxy/gateway-hooks';
import type { PushPolicyInput } from '@leed-ai/git-gateway-contract/proxy/push-policy';
import type { PushPolicyResultInput } from '@leed-ai/git-gateway-contract/proxy/push-policy-result';

/** Settings of the {@link ExamplePushPolicy}. */
export interface ExamplePushPolicyOptions {
  /** Largest file a push may add or change, in bytes. */
  readonly maxFileBytes: number;
  /** Path prefixes only principals with `maintainerRole` may change (e.g. ".github/workflows/"). */
  readonly protectedPrefixes: readonly string[];
  /** The role allowed to change protected paths. */
  readonly maintainerRole: string;
}

/**
 * An example PushPolicy, to copy and adapt: every commit a push brings is checked for files over
 * a size limit, and for changes under protected path prefixes by anyone without the maintainer
 * role. Pushes that only delete refs carry no commits and pass. It asks for changed paths on
 * every push; a policy that only cares about some refs or principals can return
 * `{ changedPaths: false }` for the rest and skip the cost.
 */
export class ExamplePushPolicy implements PushPolicy {
  readonly #options: ExamplePushPolicyOptions;

  constructor(options: ExamplePushPolicyOptions) {
    this.#options = options;
  }

  needs(): { changedPaths: boolean } {
    return { changedPaths: true };
  }

  check(input: PushPolicyInput): PushPolicyResultInput {
    const { maxFileBytes, protectedPrefixes, maintainerRole } = this.#options;
    const maintainer = input.principal.roles.includes(maintainerRole);
    return {
      refs: input.updates.map((update) => {
        for (const commit of update.commits ?? []) {
          for (const change of commit.changes) {
            if ((change.size ?? 0) > maxFileBytes) {
              const reason = `${change.path} is larger than ${maxFileBytes} bytes (commit ${commit.sha.slice(0, 12)})`;
              return { ref: update.ref, decision: 'deny', reason };
            }
            const prefix = protectedPrefixes.find((candidate) => change.path.startsWith(candidate));
            if (prefix !== undefined && !maintainer) {
              const reason = `only maintainers may change ${prefix} (${change.path}, commit ${commit.sha.slice(0, 12)})`;
              return { ref: update.ref, decision: 'deny', reason };
            }
          }
        }
        return { ref: update.ref, decision: 'allow' };
      }),
    };
  }
}
