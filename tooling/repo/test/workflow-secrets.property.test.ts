// SPDX-License-Identifier: Apache-2.0
import * as fc from 'fast-check';
import { describe, expect, it } from 'vite-plus/test';

import { findWorkflowViolations, secretsReferenced, type WorkflowFile } from '../src/workflow-policy.ts';

const UPSTREAM = "github.repository == 'leed-ai/git-gateway'";
const MAIN_ONLY = `${UPSTREAM} && github.ref == 'refs/heads/main'`;

/** A secret name GitHub accepts, never one with the reserved GITHUB_ prefix. */
const secretName = fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,20}$/).filter((name) => !name.startsWith('GITHUB_'));

/** The two ways an expression names one secret. */
const reference = (name: string, bracket: boolean): string =>
  bracket ? `\${{ secrets['${name}'] }}` : `\${{ secrets.${name} }}`;

type Place = 'workflow-env' | 'job-env' | 'step-env' | 'step-with' | 'step-run' | 'job-if';

/** A pull-request workflow with one secret reference placed somewhere that reaches job "job". */
function placed(place: Place, expression: string, guard: string): WorkflowFile {
  const step: Record<string, unknown> = { run: 'true' };
  const job: Record<string, unknown> = { if: guard, 'runs-on': 'ubuntu-latest', steps: [step] };
  const document: Record<string, unknown> = {
    on: ['pull_request', 'push'],
    permissions: { contents: 'read' },
    jobs: { job },
  };
  if (place === 'workflow-env') document['env'] = { T: expression };
  if (place === 'job-env') job['env'] = { T: expression };
  if (place === 'step-env') step['env'] = { T: expression };
  if (place === 'step-with') step['with'] = { token: expression };
  if (place === 'step-run') step['run'] = `echo "${expression}"`;
  // An if: is an expression already; `${{ }}` mixed with other text there would be an always-true string.
  if (place === 'job-if') job['if'] = `${guard} && ${expression.slice(4, -3)} != ''`;
  return { path: '.github/workflows/x.yml', document };
}

const place = fc.constantFrom<Place>(
  'workflow-env',
  'job-env',
  'step-env',
  'step-with',
  'step-run',
  'job-if',
);

describe('workflow secret detection, for any secret in any place', () => {
  it('names exactly the referenced secret', () => {
    fc.assert(
      fc.property(secretName, fc.boolean(), (name, bracket) => {
        expect([...secretsReferenced({ env: { T: reference(name, bracket) } })]).toEqual([name]);
      }),
    );
  });

  it('flags the job as pull-request reachable unless it is limited to main upstream', () => {
    fc.assert(
      fc.property(secretName, fc.boolean(), place, (name, bracket, where) => {
        const violations = findWorkflowViolations([placed(where, reference(name, bracket), UPSTREAM)]);
        expect(violations.map(({ message }) => message)).toEqual([
          `job "job" uses secrets (${name}) and could run for a pull request; limit it to main`,
        ]);
      }),
    );
  });

  it('accepts the same reference on a job limited to main upstream', () => {
    fc.assert(
      fc.property(secretName, fc.boolean(), place, (name, bracket, where) => {
        expect(findWorkflowViolations([placed(where, reference(name, bracket), MAIN_ONLY)])).toEqual([]);
      }),
    );
  });

  it('flags a missing upstream guard wherever the secret sits', () => {
    fc.assert(
      fc.property(secretName, place, (name, where) => {
        const messages = findWorkflowViolations([placed(where, reference(name, false), '')]).map(
          ({ message }) => message,
        );
        expect(messages).toContain(
          `job "job" uses secrets (${name}) without an if: limiting it to leed-ai/git-gateway`,
        );
      }),
    );
  });

  it('never reports a job whose only token is GITHUB_TOKEN', () => {
    fc.assert(
      fc.property(fc.boolean(), place, (bracket, where) => {
        expect(findWorkflowViolations([placed(where, reference('GITHUB_TOKEN', bracket), '')])).toEqual([]);
      }),
    );
  });
});
