// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { BEHAVIOUR_CASES, runBehaviourCase } from '../../src/behaviour/behaviour-suite.ts';
import type { GitGateway } from '../../src/git-gateway.ts';
import { createReferenceGateway } from '../../src/reference/reference-gateway.ts';

/** A reference gateway with one method replaced by a faulty one. */
type Fault = (inner: GitGateway) => Partial<GitGateway>;

const faults: Record<string, Fault> = {
  'create overwrites like upsert': (inner) => ({
    commit: (input) =>
      inner.commit({
        ...input,
        actions: input.actions.map((action) =>
          action.action === 'create' ? { ...action, action: 'upsert' } : action,
        ),
      }),
  }),
  'expectedHead is ignored': (inner) => ({
    commit: ({ expectedHead: _ignored, ...input }) => inner.commit(input),
  }),
  'idempotency keys are not honoured': (inner) => ({
    commit: (input) =>
      inner.commit({ ...input, idempotencyKey: `${input.idempotencyKey}-${crypto.randomUUID()}` }),
  }),
  'noop reports the wrong head': (inner) => ({
    commit: async (input) => {
      const output = await inner.commit(input);
      return output.status === 'noop' ? { status: 'noop', head: null } : output;
    },
  }),
  'conflicts are hidden': (inner) => ({
    syncBranch: async (input) => {
      const output = await inner.syncBranch(input);
      return output.status === 'conflict' ? { status: 'up_to_date', head: output.intoHead } : output;
    },
  }),
  'promote refusals are swallowed': (inner) => ({
    promote: async (input) => {
      try {
        return await inner.promote(input);
      } catch {
        return { status: 'up_to_date', head: input.sha };
      }
    },
  }),
  'binary reads are returned as text': (inner) => ({
    readFile: async (input) => {
      const file = await inner.readFile(input);
      return file === null ? null : { ...file, encoding: 'text' };
    },
  }),
  'log is oldest first': (inner) => ({
    log: async (input) => {
      const output = await inner.log(input);
      return { ...output, commits: output.commits.toReversed() };
    },
  }),
  'missing repositories read as empty': (inner) => ({
    resolveRef: async (input) => {
      try {
        return await inner.resolveRef(input);
      } catch {
        return null;
      }
    },
  }),
};

/** A factory for reference gateways with the fault applied. */
function faultyGateway(fault: Fault): () => GitGateway {
  return () => {
    const inner = createReferenceGateway();
    return { ...inner, ...fault(inner) };
  };
}

describe('the behaviour suite catches faulty implementations', () => {
  for (const [name, fault] of Object.entries(faults)) {
    it(`fails when ${name}`, async () => {
      const createGateway = faultyGateway(fault);
      const outcomes = await Promise.allSettled(
        BEHAVIOUR_CASES.map((entry) => runBehaviourCase(entry, { createGateway })),
      );
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(failed.length).toBeGreaterThan(0);
    });
  }
});
