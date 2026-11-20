// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '../git-gateway.ts';

/** What a behaviour case runs against: the gateway under test and a repository name of its own. */
export interface BehaviourContext {
  readonly gateway: GitGateway;
  /** A repository name no other case uses; the case creates the repository itself. */
  readonly repo: string;
}

/** One rule of the contract, checked through the {@link GitGateway} interface alone. */
export interface BehaviourCase {
  /** The area of the contract, e.g. "commit actions". */
  readonly group: string;
  /** What the case checks, phrased as the rule. */
  readonly name: string;
  /** Resolves when the implementation follows the rule; rejects with a BehaviourFailure otherwise. */
  readonly run: (context: BehaviourContext) => Promise<void>;
}

/** Declares a behaviour case. */
export function behaviourCase(
  group: string,
  name: string,
  run: (context: BehaviourContext) => Promise<void>,
): BehaviourCase {
  return { group, name, run };
}
