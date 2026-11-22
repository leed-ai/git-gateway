// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { REPO_ROOT } from '../src/repo-root.ts';
import { readWorkflowFiles } from '../src/workflow-files.ts';
import {
  ALL_SECRETS,
  findWorkflowViolations,
  secretsReferenced,
  type WorkflowFile,
} from '../src/workflow-policy.ts';

const SHA = 'a'.repeat(40);
const workflow = (document: Record<string, unknown>, path = '.github/workflows/x.yml'): WorkflowFile => ({
  path,
  document: { permissions: { contents: 'read' }, ...document },
});
const messages = (...files: WorkflowFile[]): string[] =>
  findWorkflowViolations(files).map(({ message }) => message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every step of every job in a parsed workflow. */
const stepsOf = (document: unknown): Record<string, unknown>[] => {
  const jobs = isRecord(document) && isRecord(document['jobs']) ? Object.values(document['jobs']) : [];
  return jobs.flatMap((job) =>
    isRecord(job) && Array.isArray(job['steps']) ? job['steps'].filter(isRecord) : [],
  );
};

describe('the next snapshot in the release workflow', () => {
  it('gives snapshot versioning a GitHub token, which the GitHub changelog needs for every changeset', () => {
    const snapshot = readWorkflowFiles(REPO_ROOT).find(
      ({ path }) => path === '.github/workflows/release.yml',
    );
    const step = stepsOf(snapshot?.document).find(
      ({ run }) => typeof run === 'string' && run.includes('changeset version --snapshot'),
    );
    const env = step?.['env'];
    expect(isRecord(env) ? env['GITHUB_TOKEN'] : undefined).toBe('${{ secrets.GITHUB_TOKEN }}');
  });
});

describe('secrets that reach a job from outside its own body', () => {
  it('applies a workflow-level env secret to every job, pull-request rule included', () => {
    const document = {
      on: 'pull_request',
      env: { T: '${{ secrets.TOKEN }}' },
      jobs: { a: { 'runs-on': 'x' }, b: { if: "github.repository == 'leed-ai/git-gateway'" } },
    };
    expect(messages(workflow(document))).toEqual([
      'job "a" uses secrets (TOKEN) without an if: limiting it to leed-ai/git-gateway',
      'job "a" uses secrets (TOKEN) and could run for a pull request; limit it to main',
      'job "b" uses secrets (TOKEN) and could run for a pull request; limit it to main',
    ]);
  });

  it('finds a secret anywhere outside jobs, such as run-name or concurrency', () => {
    const job = { if: "github.repository == 'leed-ai/git-gateway'" };
    expect(
      messages(workflow({ on: 'pull_request', concurrency: '${{ secrets.GROUP }}', jobs: { job } })),
    ).toEqual(['job "job" uses secrets (GROUP) and could run for a pull request; limit it to main']);
  });

  it('treats secrets: inherit on a reusable-workflow job as using every secret', () => {
    const job = {
      if: "github.repository == 'leed-ai/git-gateway'",
      uses: `o/r/.github/workflows/w.yml@${SHA}`,
      secrets: 'inherit',
    };
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
      'job "job" uses secrets (every secret) and could run for a pull request; limit it to main',
    ]);
    expect(messages(workflow({ on: 'push', jobs: { job: { ...job, if: undefined } } }))).toEqual([
      'job "job" uses secrets (every secret) without an if: limiting it to leed-ai/git-gateway',
      'job "job" uses secrets (every secret) without an if: limiting it to main',
    ]);
  });

  it('requires secret-bearing jobs to be limited to main whatever the trigger', () => {
    const job = { if: "github.repository == 'leed-ai/git-gateway'", env: { T: '${{ secrets.NPM_TOKEN }}' } };
    for (const on of ['push', 'workflow_dispatch', 'schedule', 'release']) {
      expect(messages(workflow({ on, jobs: { job } }))).toEqual([
        'job "job" uses secrets (NPM_TOKEN) without an if: limiting it to main',
      ]);
    }
  });

  it('finds a secret reference after a newline or tab inside an expression', () => {
    const guard = "github.repository == 'leed-ai/git-gateway'";
    for (const value of [
      '${{\nsecrets.NPM_TOKEN }}',
      '${{\tsecrets.NPM_TOKEN }}',
      'a\n${{ secrets.NPM_TOKEN }}',
    ]) {
      const job = { if: guard, steps: [{ run: 'x', env: { T: value } }] };
      expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
        'job "job" uses secrets (NPM_TOKEN) and could run for a pull request; limit it to main',
      ]);
    }
  });

  it('treats events anyone can trigger on main like issue comments', () => {
    const guard = "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main'";
    for (const event of ['issues', 'discussion', 'discussion_comment', 'watch', 'fork']) {
      const job = { if: guard, env: { T: '${{ secrets.TOKEN }}' } };
      expect(messages(workflow({ on: [event], jobs: { job } }))).toHaveLength(1);
      const pinned = { ...job, if: `${guard} && github.event_name == '${event}'` };
      expect(messages(workflow({ on: [event], jobs: { job: pinned } }))).toHaveLength(1);
    }
  });

  it('catches a secret read with brackets', () => {
    const job = { if: "github.repository == 'leed-ai/git-gateway'", env: { T: "${{ secrets['TOKEN'] }}" } };
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
      'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
    ]);
  });

  it('accepts a workflow-level or inherited secret on jobs limited to main upstream', () => {
    const guard = "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main'";
    const document = {
      on: ['pull_request', 'push'],
      env: { T: '${{ secrets.TOKEN }}' },
      jobs: {
        a: { if: guard },
        b: { if: guard, uses: `o/r/.github/workflows/w.yml@${SHA}`, secrets: 'inherit' },
      },
    };
    expect(messages(workflow(document))).toEqual([]);
  });
});

describe('secret references the policy must not miss', () => {
  const upstreamOnly = "github.repository == 'leed-ai/git-gateway'";
  const pullRequestJob = (env: Record<string, string>) =>
    workflow({ on: 'pull_request', jobs: { job: { if: upstreamOnly, env } } });

  it('flags an uppercase SECRETS.X on a pull request job', () => {
    expect(messages(pullRequestJob({ T: '${{ SECRETS.X }}' }))).toEqual([
      'job "job" uses secrets (X) and could run for a pull request; limit it to main',
    ]);
  });

  it('flags secrets[matrix.name] as every secret', () => {
    expect(messages(pullRequestJob({ T: '${{ secrets[matrix.name] }}' }))).toEqual([
      'job "job" uses secrets (every secret) and could run for a pull request; limit it to main',
    ]);
  });

  it("flags secrets [ 'X' ] with a space before the bracket", () => {
    expect(messages(pullRequestJob({ T: "${{ secrets [ 'X' ] }}" }))).toEqual([
      'job "job" uses secrets (X) and could run for a pull request; limit it to main',
    ]);
  });
});

describe('secretsReferenced', () => {
  it('finds bracketed references and ignores a bracketed GITHUB_TOKEN', () => {
    expect([
      ...secretsReferenced([
        "${{ secrets['A'] }}",
        "${{ secrets[ 'B-c' ] }}",
        "${{ secrets['GITHUB_TOKEN'] }}",
      ]),
    ]).toEqual(['A', 'B-c']);
  });

  it('reads the whole secrets context as every secret', () => {
    expect([...secretsReferenced({ env: { ALL: '${{ toJSON(secrets) }}' } })]).toEqual([ALL_SECRETS]);
  });

  it('reads the secrets context whatever its case, as GitHub does', () => {
    expect([...secretsReferenced(['${{ SECRETS.X }}', '${{ Secrets.Y }}', "${{ SECRETS['Z'] }}"])]).toEqual([
      'X',
      'Y',
      'Z',
    ]);
    expect([...secretsReferenced('${{ toJSON(SECRETS) }}')]).toEqual([ALL_SECRETS]);
    expect([...secretsReferenced('${{ Secrets.github_token }}')]).toEqual([]);
  });

  it('treats an index that is not one quoted literal as reading every secret', () => {
    expect([...secretsReferenced('${{ secrets[matrix.name] }}')]).toEqual([ALL_SECRETS]);
    expect([...secretsReferenced("${{ secrets[format('{0}_TOKEN', matrix.env)] }}")]).toEqual([ALL_SECRETS]);
    expect([...secretsReferenced('${{ SECRETS[ inputs.name ] }}')]).toEqual([ALL_SECRETS]);
  });

  it('accepts whitespace before the bracket or the dot', () => {
    expect([...secretsReferenced(["${{ secrets [ 'X' ] }}", '${{ secrets . Y }}'])]).toEqual(['X', 'Y']);
  });

  it('reads an if: as an expression even without ${{ }}', () => {
    expect([...secretsReferenced({ if: "toJSON(secrets) != '{}'" })]).toEqual([ALL_SECRETS]);
  });

  it('does not mistake a step named secrets, or a secrets key, for a secret', () => {
    expect([
      ...secretsReferenced({ if: "steps.secrets.outputs.ready == 'true'", secrets: 'inherit' }),
    ]).toEqual([]);
    expect([...secretsReferenced({ on: { workflow_call: { secrets: { X: { required: true } } } } })]).toEqual(
      [],
    );
  });
});
