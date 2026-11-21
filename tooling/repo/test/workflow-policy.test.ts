// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { REPO_ROOT } from '../src/repo-root.ts';
import { readWorkflowFiles } from '../src/workflow-files.ts';
import {
  actionReferences,
  findWorkflowViolations,
  secretsReferenced,
  triggersOf,
  type WorkflowFile,
} from '../src/workflow-policy.ts';

const SHA = 'a'.repeat(40);
const workflow = (document: Record<string, unknown>, path = '.github/workflows/x.yml'): WorkflowFile => ({
  path,
  document: { permissions: { contents: 'read' }, ...document },
});
const messages = (...files: WorkflowFile[]): string[] =>
  findWorkflowViolations(files).map(({ message }) => message);

describe('the repository workflows', () => {
  const files = readWorkflowFiles(REPO_ROOT);
  const byPath = new Map(files.map((file) => [file.path, file.document]));

  it('pass the workflow policy', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(findWorkflowViolations(files)).toEqual([]);
  });

  it('run check, unit tests and conformance for pull requests, forks included', () => {
    for (const name of ['check', 'test', 'conformance', 'contract', 'codeql']) {
      expect(triggersOf(byPath.get(`.github/workflows/${name}.yml`))).toContain('pull_request');
    }
  });

  it('split tests by the matrix size, so the shard count is one line', () => {
    const text = JSON.stringify(byPath.get('.github/workflows/test.yml'));
    expect(text).toContain('--shard=${{ matrix.shard }}/${{ strategy.job-total }}');
  });

  it('publish only when NPM_TOKEN is configured', () => {
    for (const name of ['release', 'snapshot']) {
      const text = JSON.stringify(byPath.get(`.github/workflows/${name}.yml`));
      expect(text).toContain("secrets.NPM_TOKEN != ''");
      expect(text).toContain("env.HAS_NPM_TOKEN == 'true'");
    }
  });
});

describe('findWorkflowViolations', () => {
  it('rejects pull_request_target and workflow_run', () => {
    expect(messages(workflow({ on: ['pull_request_target', 'workflow_run'], jobs: {} }))).toEqual([
      'trigger pull_request_target runs fork code with secrets; use pull_request',
      'trigger workflow_run runs fork code with secrets; use pull_request',
    ]);
  });

  it('requires actions pinned to a commit SHA, in workflows and composite actions', () => {
    const job = {
      'runs-on': 'x',
      steps: [{ uses: 'actions/checkout@v7' }, { uses: `actions/cache@${SHA}` }],
    };
    const composite = {
      path: '.github/actions/a/action.yml',
      document: { runs: { steps: [{ uses: 'x/y@main' }] } },
    };
    expect(messages(workflow({ on: 'push', jobs: { job } }), composite)).toEqual([
      'action actions/checkout@v7 must be pinned to a full commit SHA',
      'action x/y@main must be pinned to a full commit SHA',
    ]);
  });

  it('allows local actions and docker images pinned to a digest', () => {
    const job = {
      steps: [
        { uses: './.github/actions/setup' },
        {
          uses: 'docker://rhysd/actionlint:1.7.12@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    };
    expect(messages(workflow({ on: 'push', jobs: { job } }))).toEqual([]);
  });

  it('rejects a docker image referenced by a mutable tag', () => {
    const job = { steps: [{ uses: 'docker://rhysd/actionlint:1.7.12' }, { uses: 'docker://alpine' }] };
    expect(messages(workflow({ on: 'push', jobs: { job } }))).toEqual([
      'image docker://rhysd/actionlint:1.7.12 must be pinned to a sha256 digest',
      'image docker://alpine must be pinned to a sha256 digest',
    ]);
  });

  it('requires top-level permissions on workflows', () => {
    expect(messages({ path: '.github/workflows/x.yml', document: { on: 'push', jobs: {} } })).toEqual([
      'workflow must set top-level permissions',
    ]);
  });

  it('rejects a secret-bearing job reachable from a pull request', () => {
    const job = { if: "github.repository == 'leed-ai/git-gateway'", env: { T: '${{ secrets.TOKEN }}' } };
    expect(messages(workflow({ on: { pull_request: null, push: null }, jobs: { job } }))).toEqual([
      'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
    ]);
  });

  it('rejects a secret-bearing job without the upstream repository guard', () => {
    const job = { steps: [{ run: 'x', env: { T: '${{ secrets.NPM_TOKEN }}' } }] };
    expect(messages(workflow({ on: { push: null }, jobs: { job } }))).toEqual([
      'job "job" uses secrets (NPM_TOKEN) without an if: limiting it to leed-ai/git-gateway',
      'job "job" uses secrets (NPM_TOKEN) without an if: limiting it to main',
    ]);
  });

  it('accepts a secret-bearing job limited to main in the upstream repository', () => {
    const job = {
      if: "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main' && github.event_name == 'push'",
      env: { T: '${{ secrets.TOKEN }}' },
    };
    expect(messages(workflow({ on: ['pull_request', 'push'], jobs: { job } }))).toEqual([]);
  });

  it('ignores the per-run GITHUB_TOKEN', () => {
    const job = { env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } };
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([]);
  });

  it('rejects pull_request_target written as a map key with settings', () => {
    expect(messages(workflow({ on: { pull_request_target: { types: ['opened'] } }, jobs: {} }))).toEqual([
      'trigger pull_request_target runs fork code with secrets; use pull_request',
    ]);
  });

  it('treats merge_group, reviews and comments as reachable from a pull request', () => {
    const job = { if: "github.repository == 'leed-ai/git-gateway'", env: { T: '${{ secrets.TOKEN }}' } };
    for (const event of ['merge_group', 'pull_request_review', 'pull_request_review_comment']) {
      expect(messages(workflow({ on: [event], jobs: { job } }))).toEqual([
        'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
      ]);
    }
  });

  it('rejects a main-only guard that still names pull_request', () => {
    const job = {
      if: "github.repository == 'leed-ai/git-gateway' && (github.ref == 'refs/heads/main' || github.event_name == 'pull_request')",
      env: { T: '${{ secrets.TOKEN }}' },
    };
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
      'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
    ]);
  });

  it('rejects guards joined by || at the top level', () => {
    const env = { T: '${{ secrets.TOKEN }}' };
    const conditions = [
      "github.repository == 'leed-ai/git-gateway' || github.ref == 'refs/heads/main'",
      "github.ref == 'refs/heads/main' && github.repository == 'leed-ai/git-gateway' || true",
      "${{ github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request' }}",
    ];
    for (const condition of conditions) {
      expect(messages(workflow({ on: 'pull_request', jobs: { job: { if: condition, env } } }))).toEqual([
        'job "job" uses secrets (TOKEN) without an if: limiting it to leed-ai/git-gateway',
        'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
      ]);
    }
    const nested = "(github.repository == 'leed-ai/git-gateway' || false) && github.ref == 'refs/heads/main'";
    expect(messages(workflow({ on: 'pull_request', jobs: { job: { if: nested, env } } }))).toEqual([
      'job "job" uses secrets (TOKEN) without an if: limiting it to leed-ai/git-gateway',
    ]);
  });

  it('rejects a guard that only appears inside a string or a negation', () => {
    const env = { T: '${{ secrets.TOKEN }}' };
    for (const condition of [
      "!(github.repository == 'leed-ai/git-gateway')",
      "contains('github.repository == ''leed-ai/git-gateway''', 'x')",
    ]) {
      expect(messages(workflow({ on: 'push', jobs: { job: { if: condition, env } } }))).toEqual([
        'job "job" uses secrets (TOKEN) without an if: limiting it to leed-ai/git-gateway',
        'job "job" uses secrets (TOKEN) without an if: limiting it to main',
      ]);
    }
  });

  it('accepts the guards as top-level clauses however they are wrapped or spaced', () => {
    const env = { T: '${{ secrets.TOKEN }}' };
    for (const condition of [
      "${{ github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main' }}",
      "(github.repository=='leed-ai/git-gateway') && (github.ref == 'refs/heads/main' && github.event_name == 'push')",
      "github.ref == 'refs/heads/main' && (github.repository  ==  'leed-ai/git-gateway') && (a || b)",
    ]) {
      expect(
        messages(workflow({ on: ['pull_request', 'push'], jobs: { job: { if: condition, env } } })),
      ).toEqual([]);
    }
  });

  it('requires an issue_comment workflow to pin secret jobs to an event a fork cannot trigger', () => {
    const guard = "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main'";
    const env = { T: '${{ secrets.TOKEN }}' };
    expect(messages(workflow({ on: ['issue_comment', 'push'], jobs: { job: { if: guard, env } } }))).toEqual([
      'job "job" uses secrets (TOKEN) and could run for issue_comment on main; ' +
        "limit it with github.event_name == '<an event a fork cannot trigger>'",
    ]);
    for (const event of ['issue_comment', 'pull_request']) {
      const condition = `${guard} && github.event_name == '${event}'`;
      expect(
        messages(workflow({ on: ['issue_comment'], jobs: { job: { if: condition, env } } })),
      ).toHaveLength(1);
    }
    const pinned = `${guard} && github.event_name == 'push'`;
    expect(messages(workflow({ on: ['issue_comment', 'push'], jobs: { job: { if: pinned, env } } }))).toEqual(
      [],
    );
  });

  it('does not accept a guard on a step in place of one on the job', () => {
    const job = {
      steps: [
        {
          if: "github.repository == 'leed-ai/git-gateway' && github.ref == 'refs/heads/main'",
          env: { T: '${{ secrets.TOKEN }}' },
        },
      ],
    };
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
      'job "job" uses secrets (TOKEN) without an if: limiting it to leed-ai/git-gateway',
      'job "job" uses secrets (TOKEN) and could run for a pull request; limit it to main',
    ]);
  });

  it('lists every secret a job uses, once each', () => {
    const job = {
      if: "github.repository == 'leed-ai/git-gateway'",
      env: { A: '${{ secrets.A }}', B: '${{ secrets.B }}', A2: '${{ secrets.A }}' },
    };
    expect(messages(workflow({ on: 'push', jobs: { job } }))).toEqual([
      'job "job" uses secrets (A, B) without an if: limiting it to main',
    ]);
    expect(messages(workflow({ on: 'pull_request', jobs: { job } }))).toEqual([
      'job "job" uses secrets (A, B) and could run for a pull request; limit it to main',
    ]);
  });

  it('requires a reusable workflow from another repository to be pinned', () => {
    const jobs = {
      a: { uses: 'o/r/.github/workflows/w.yml@v1' },
      b: { uses: `o/r/.github/workflows/w.yml@${SHA}` },
    };
    expect(messages(workflow({ on: 'push', jobs }))).toEqual([
      'action o/r/.github/workflows/w.yml@v1 must be pinned to a full commit SHA',
    ]);
  });

  it('rejects a short or uppercase commit SHA', () => {
    const job = { steps: [{ uses: 'a/b@abc1234' }, { uses: `a/b@${'A'.repeat(40)}` }] };
    expect(messages(workflow({ on: 'push', jobs: { job } }))).toEqual([
      'action a/b@abc1234 must be pinned to a full commit SHA',
      `action a/b@${'A'.repeat(40)} must be pinned to a full commit SHA`,
    ]);
  });

  it('does not require top-level permissions on a composite action', () => {
    expect(messages({ path: '.github/actions/a/action.yml', document: { runs: { steps: [] } } })).toEqual([]);
  });

  it('rejects a file that is not a mapping', () => {
    expect(messages({ path: '.github/workflows/x.yml', document: 'text' })).toEqual(['not a YAML mapping']);
  });
});

describe('workflow helpers', () => {
  it('reads triggers in every form, including YAML 1.1 boolean keys', () => {
    expect(triggersOf({ on: 'push' })).toEqual(['push']);
    expect(triggersOf({ on: ['push', 3] })).toEqual(['push']);
    expect(triggersOf({ true: { schedule: [] } })).toEqual(['schedule']);
    expect(triggersOf(null)).toEqual([]);
  });

  it('finds secret references anywhere in a value', () => {
    expect([...secretsReferenced({ a: ['${{ secrets.A }}', { b: "${{ x && secrets.B || '' }}" }] })]).toEqual(
      ['A', 'B'],
    );
  });

  it('collects uses from steps and reusable-workflow jobs', () => {
    expect(
      actionReferences({
        jobs: { a: { uses: 'o/r/.github/workflows/w.yml@x' }, b: { steps: [{ uses: 'c@d' }, { run: 'e' }] } },
      }),
    ).toEqual(['o/r/.github/workflows/w.yml@x', 'c@d']);
  });
});
