// SPDX-License-Identifier: Apache-2.0
import type { GitGateway } from '../git-gateway.ts';
import type { BehaviourCase } from './behaviour-case.ts';
import { commitActionCases } from './commit-action-cases.ts';
import { commitWriteCases } from './commit-write-cases.ts';
import { lifecycleCases } from './lifecycle-cases.ts';
import { promoteCases } from './promote-cases.ts';
import { readCases } from './read-cases.ts';
import { syncCases } from './sync-cases.ts';

/** Every behaviour case, grouped by area of the contract. */
export const BEHAVIOUR_CASES: readonly BehaviourCase[] = [
  ...lifecycleCases,
  ...commitActionCases,
  ...commitWriteCases,
  ...readCases,
  ...syncCases,
  ...promoteCases,
];

/** The two functions of a test framework the suite registers through (Vitest, Jest, bun:test, node:test…). */
export interface TestRegistrar {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

/** How to run the suite against one implementation. */
export interface BehaviourSuiteOptions {
  /** Suite title; default "GitGateway behaviour". */
  readonly name?: string;
  /** Returns the implementation under test; called once per case. */
  readonly createGateway: () => GitGateway | Promise<GitGateway>;
  /** Prefix of every repository name the cases create; default "behaviour". Keep it short. */
  readonly repoPrefix?: string;
  /** Delete each case's repository when the case ends (for shared, long-lived gateways); default false. */
  readonly cleanup?: boolean;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

let runCounter = 0;

/** Runs one case against a fresh gateway and a repository name no other case uses. */
export async function runBehaviourCase(entry: BehaviourCase, options: BehaviourSuiteOptions): Promise<void> {
  runCounter += 1;
  const gateway = await options.createGateway();
  const unique = `${runCounter}-${crypto.randomUUID().slice(0, 8)}`;
  const repo = `${options.repoPrefix ?? 'behaviour'}-${slug(entry.name)}-${unique}`.slice(0, 100);
  try {
    await entry.run({ gateway, repo });
  } finally {
    if (options.cleanup === true) await gateway.deleteRepo({ repo });
  }
}

/**
 * Registers the behaviour suite of the {@link GitGateway} contract with a test framework: one test
 * per case, grouped by area. The in-memory reference passes it; the real gateway must pass it too.
 *
 *   registerBehaviourSuite({ describe, it }, { createGateway: () => createReferenceGateway() });
 */
export function registerBehaviourSuite(test: TestRegistrar, options: BehaviourSuiteOptions): void {
  const groups = Map.groupBy(BEHAVIOUR_CASES, (entry) => entry.group);
  test.describe(options.name ?? 'GitGateway behaviour', () => {
    for (const [group, cases] of groups) {
      test.describe(group, () => {
        for (const entry of cases) test.it(entry.name, () => runBehaviourCase(entry, options));
      });
    }
  });
}
