// SPDX-License-Identifier: Apache-2.0
import { requiredClauses } from './workflow-condition.ts';

/** The repository whose secrets the live jobs may use; a fork never matches. */
export const UPSTREAM_REPOSITORY = 'leed-ai/git-gateway';

const UPSTREAM_GUARD = `github.repository == '${UPSTREAM_REPOSITORY}'`;
const MAIN_GUARD = "github.ref == 'refs/heads/main'";

/** A parsed GitHub Actions workflow or composite action file, with its repository-relative path. */
export interface WorkflowFile {
  readonly path: string;
  readonly document: unknown;
}

/** A broken workflow rule, located by file. */
export interface WorkflowViolation {
  readonly path: string;
  readonly message: string;
}

// Events that run on the default branch but anyone can set off (an issue, a comment, a star, a fork),
// so `github.ref == 'refs/heads/main'` holds for them and cannot keep them away from secrets.
const DEFAULT_BRANCH_EVENTS = [
  'issue_comment',
  'issues',
  'discussion',
  'discussion_comment',
  'watch',
  'fork',
];
// Events a fork's pull request, or anyone outside the repository, can set off.
const FORK_REACHABLE_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'merge_group',
  ...DEFAULT_BRANCH_EVENTS,
];
const FORBIDDEN_EVENTS = ['pull_request_target', 'workflow_run'];
// GitHub expression context names are case-insensitive: `secrets`, `SECRETS` and `Secrets` are one context.
// `secrets.NAME` or `secrets['NAME']`, but not a property path such as `steps.secrets.outputs`.
const SECRET_REFERENCE = /(?<![\w.])secrets\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*'([^']+)'\s*\])/gi;
// An index that is not one quoted literal (`secrets[matrix.name]`, `secrets[format(...)]`) can read any secret.
const DYNAMIC_SECRET_INDEX = /(?<![\w.])secrets\s*\[(?!\s*'[^']+'\s*\])/i;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
// The whole secrets context inside an expression, as in `${{ toJSON(secrets) }}`.
const WHOLE_SECRETS_CONTEXT = /(?<![\w.])secrets(?!\s*[.[\w])/i;
const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;
const PINNED_IMAGE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The workflow's trigger names, whether `on:` is a string, a list or a map. */
export function triggersOf(document: unknown): string[] {
  if (!isRecord(document)) return [];
  // YAML 1.1 parsers read a bare `on` key as boolean true.
  const on = document['on'] ?? document['true'];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((event): event is string => typeof event === 'string');
  return isRecord(on) ? Object.keys(on) : [];
}

/** Stands for every repository secret: `secrets: inherit`, or the whole `secrets` context read at once. */
export const ALL_SECRETS = '*';

/**
 * Every secret a value (job, step, input map) references, except the per-run GITHUB_TOKEN.
 * Holds ALL_SECRETS when the value reads the whole secrets context.
 */
export function secretsReferenced(value: unknown): Set<string> {
  const names = new Set<string>();
  // Each string is scanned as written: serializing the value first would turn a newline before
  // `secrets` into the two characters `\n` and hide the reference from the lookbehind.
  const texts = stringsIn(value);
  for (const text of texts) {
    for (const match of text.matchAll(SECRET_REFERENCE)) {
      const name = match[1] ?? match[2];
      if (name !== undefined && name.toUpperCase() !== 'GITHUB_TOKEN') names.add(name);
    }
    if (DYNAMIC_SECRET_INDEX.test(text)) names.add(ALL_SECRETS);
  }
  const expressions = [
    ...texts.flatMap((text) => [...text.matchAll(EXPRESSION)].map(([, inner]) => inner)),
    ...conditionsIn(value),
  ];
  if (expressions.some((expression) => expression !== undefined && WHOLE_SECRETS_CONTEXT.test(expression))) {
    names.add(ALL_SECRETS);
  }
  return names;
}

/** Every string in a value, keys included, at any depth. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...stringsIn(inner)]);
}

/** Every `if:` string in a value: an expression even without `${{ }}`. */
function conditionsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(conditionsIn);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    key === 'if' && typeof inner === 'string' ? [inner] : conditionsIn(inner),
  );
}

/** True for a clause pinning the job to one event a fork cannot trigger, e.g. `github.event_name == 'push'`. */
function isTrustedEventClause(clause: string): boolean {
  const event = /^github\.event_name == '([a-z_]+)'$/.exec(clause)?.[1];
  return event !== undefined && !FORK_REACHABLE_EVENTS.includes(event) && !FORBIDDEN_EVENTS.includes(event);
}

/** The secrets one job uses: its own, those `secrets: inherit` passes to a reusable workflow, and the workflow's. */
function jobSecrets(job: Readonly<Record<string, unknown>>, workflowSecrets: ReadonlySet<string>): string[] {
  const names = new Set([...workflowSecrets, ...secretsReferenced(job)]);
  if (job['secrets'] === 'inherit') names.add(ALL_SECRETS);
  return [...names].toSorted();
}

const describeSecrets = (names: readonly string[]): string =>
  names.map((name) => (name === ALL_SECRETS ? 'every secret' : name)).join(', ');

/** Every `uses:` reference in a workflow's jobs or a composite action's steps. */
export function actionReferences(document: unknown): string[] {
  if (!isRecord(document)) return [];
  const stepLists: unknown[] = [];
  if (isRecord(document['runs'])) stepLists.push(document['runs']['steps']);
  if (isRecord(document['jobs'])) {
    for (const job of Object.values(document['jobs'])) {
      if (!isRecord(job)) continue;
      stepLists.push(job['steps']);
      if (typeof job['uses'] === 'string') stepLists.push([{ uses: job['uses'] }]);
    }
  }
  return stepLists.flatMap((steps) =>
    Array.isArray(steps)
      ? steps.flatMap((step) => (isRecord(step) && typeof step['uses'] === 'string' ? [step['uses']] : []))
      : [],
  );
}

function checkJobs(
  path: string,
  document: Readonly<Record<string, unknown>>,
  report: (message: string) => void,
): void {
  const triggers = triggersOf(document);
  const forkReachable = triggers.some((event) => FORK_REACHABLE_EVENTS.includes(event));
  const defaultBranchEvents = triggers.filter((event) => DEFAULT_BRANCH_EVENTS.includes(event));
  const { jobs: jobMap, ...workflowLevel } = document;
  // A secret outside `jobs` (workflow `env:`, `run-name:`, `concurrency:`) reaches every job.
  const workflowSecrets = secretsReferenced(workflowLevel);
  const jobs = isRecord(jobMap) ? jobMap : {};
  for (const [name, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const used = jobSecrets(job, workflowSecrets);
    if (used.length === 0) continue;
    const secrets = describeSecrets(used);
    // Each guard must be a top-level `&&` clause: one joined by `||` is not guaranteed to hold.
    const clauses = typeof job['if'] === 'string' ? (requiredClauses(job['if']) ?? []) : [];
    if (!clauses.includes(UPSTREAM_GUARD)) {
      report(`job "${name}" uses secrets (${secrets}) without an if: limiting it to ${UPSTREAM_REPOSITORY}`);
    }
    // Secrets only ever run from main, whatever the trigger: a workflow_dispatch from a branch,
    // or a pull request, never reaches them.
    if (!clauses.includes(MAIN_GUARD)) {
      report(
        forkReachable
          ? `job "${name}" uses secrets (${secrets}) and could run for a pull request; limit it to main`
          : `job "${name}" uses secrets (${secrets}) without an if: limiting it to main`,
      );
    }
    if (defaultBranchEvents.length > 0 && !clauses.some(isTrustedEventClause)) {
      report(
        `job "${name}" uses secrets (${secrets}) and could run for ${defaultBranchEvents.join(', ')} on main; ` +
          "limit it with github.event_name == '<an event a fork cannot trigger>'",
      );
    }
  }
  if (path.startsWith('.github/workflows/') && !isRecord(document['permissions'])) {
    report('workflow must set top-level permissions');
  }
}

/**
 * Checks workflows and composite actions: no pull_request_target or workflow_run triggers,
 * top-level permissions on every workflow, third-party actions pinned to a full commit SHA and
 * images to a digest, and no job that references a repository secret unless it is limited to
 * this repository's main branch and unreachable from a pull request or a fork.
 */
export function findWorkflowViolations(files: readonly WorkflowFile[]): WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  for (const { path, document } of files) {
    const report = (message: string): void => {
      violations.push({ path, message });
    };
    if (!isRecord(document)) {
      report('not a YAML mapping');
      continue;
    }
    for (const event of triggersOf(document)) {
      if (FORBIDDEN_EVENTS.includes(event))
        report(`trigger ${event} runs fork code with secrets; use pull_request`);
    }
    for (const reference of actionReferences(document)) {
      if (reference.startsWith('./')) continue;
      if (reference.startsWith('docker://')) {
        if (!PINNED_IMAGE.test(reference)) report(`image ${reference} must be pinned to a sha256 digest`);
        continue;
      }
      if (!PINNED_ACTION.test(reference)) report(`action ${reference} must be pinned to a full commit SHA`);
    }
    checkJobs(path, document, report);
  }
  return violations;
}
