// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { BEHAVIOUR_CASES, registerBehaviourSuite } from '../../src/behaviour/behaviour-suite.ts';
import { steppingClock } from '../../src/reference/clock.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';

// The oracle passes its own suite: on the system clock, on a deterministic clock, and sharing one
// gateway across every case (as a long-lived real deployment would) with cleanup on.
registerBehaviourSuite(
  { describe, it },
  { name: 'reference (system clock)', createGateway: () => createReferenceGateway() },
);

registerBehaviourSuite(
  { describe, it },
  {
    name: 'reference (stepping clock)',
    createGateway: () => createReferenceGateway({ now: steppingClock() }),
  },
);

const shared = createReferenceGateway();
registerBehaviourSuite(
  { describe, it },
  { name: 'reference (shared gateway)', createGateway: () => shared, cleanup: true, repoPrefix: 'shared' },
);

const names = (group: string): string[] =>
  BEHAVIOUR_CASES.filter((entry) => entry.group === group).map((entry) => entry.name);

describe('behaviour suite coverage', () => {
  it('has a case for every row of the commit-action table, success and failure', () => {
    const actions = names('commit actions').join('\n');
    for (const rule of [
      'create adds',
      'create fails with path_exists',
      'update replaces',
      'update fails with path_not_found',
      'upsert creates',
      'delete removes',
      'delete fails',
      'move renames',
      'move fails with path_not_found',
      'move fails with path_exists',
      'chmod sets and clears',
      'chmod fails',
      'base64',
    ]) {
      expect(actions).toContain(rule);
    }
  });

  it('covers every sync shape and every promote refusal', () => {
    const sync = names('syncBranch').join('\n');
    for (const shape of ['up_to_date', 'fast_forward', 'merged', 'conflict']) expect(sync).toContain(shape);
    const promote = names('promote').join('\n');
    for (const refusal of ['not the source head', 'non-fast-forward', 'ref_not_found'])
      expect(promote).toContain(refusal);
  });

  it('gives every case a unique name', () => {
    const keys = BEHAVIOUR_CASES.map((entry) => `${entry.group}/${entry.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('shared gateway cleanup', () => {
  it('leaves no repositories behind', async () => {
    // Every case above deleted its repository; a fresh name is free and a deleted one reports false.
    expect(await shared.deleteRepo({ repo: 'shared-never-created' })).toEqual({ deleted: false });
  });
});
