// SPDX-License-Identifier: Apache-2.0
// Rules for jobs that can mint a GitHub OIDC token (`id-token: write`), which npm trusted publishing
// exchanges for the right to publish every @leed-ai/git-gateway-* package.

/** The GitHub environment every npm trusted publisher is registered with; it admits only main. */
export const NPM_PUBLISH_ENVIRONMENT = 'npm-publish';
/** The one workflow file npm trusts to publish. */
export const NPM_PUBLISH_WORKFLOW = '.github/workflows/release.yml';
/** The composite action that runs `bun install`, and so every dependency's install scripts. */
const INSTALLING_ACTION = './.github/actions/setup-toolchain';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Installing the workspace's dependencies runs third-party code. `npm install --global npm@...`
// (the publisher itself) is the one install allowed beside the credential.
const DEPENDENCY_INSTALL = /\b(?:bun\s+(?:install|i|add)|npm\s+(?:ci|i|install)|pnpm|yarn)\b/;
const GLOBAL_NPM_INSTALL = /\bnpm\s+(?:i|install)\s+(?:--global|-g)\s+npm@\S+\s*$/;

/** True when a `permissions:` value lets the job mint an OIDC token. */
export function grantsIdToken(permissions: unknown): boolean {
  if (permissions === 'write-all') return true;
  return isRecord(permissions) && permissions['id-token'] === 'write';
}

/** The environment a job declares, as a string or `{ name }`. */
function environmentOf(job: Readonly<Record<string, unknown>>): string | undefined {
  const environment = job['environment'];
  if (typeof environment === 'string') return environment;
  return isRecord(environment) && typeof environment['name'] === 'string' ? environment['name'] : undefined;
}

/** True when a `run:` script installs dependencies other than npm itself. */
export function installsDependencies(script: string): boolean {
  return script
    .split('\n')
    .some((line) => DEPENDENCY_INSTALL.test(line) && !GLOBAL_NPM_INSTALL.test(line.trim()));
}

/**
 * Checks one workflow's OIDC-holding jobs: never granted at workflow level; each such job declares
 * an environment and installs no dependencies; and the npm-publish environment is used only by the
 * workflow file npm trusts. The upstream and main `if:` guards are required by the caller.
 */
export function oidcViolations(
  path: string,
  document: Readonly<Record<string, unknown>>,
  report: (message: string) => void,
): string[] {
  const oidcJobs: string[] = [];
  if (grantsIdToken(document['permissions'])) {
    report('id-token: write must be granted per job, never in the top-level permissions');
  }
  const jobs = isRecord(document['jobs']) ? document['jobs'] : {};
  for (const [name, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const environment = environmentOf(job);
    if (environment === NPM_PUBLISH_ENVIRONMENT && path !== NPM_PUBLISH_WORKFLOW) {
      report(`job "${name}" uses the ${NPM_PUBLISH_ENVIRONMENT} environment outside ${NPM_PUBLISH_WORKFLOW}`);
    }
    if (!grantsIdToken(job['permissions'])) continue;
    oidcJobs.push(name);
    if (environment === undefined) {
      report(`job "${name}" holds id-token: write without an environment pinning the ref`);
    }
    const steps = Array.isArray(job['steps']) ? job['steps'].filter(isRecord) : [];
    for (const step of steps) {
      if (
        step['uses'] === INSTALLING_ACTION ||
        (typeof step['run'] === 'string' && installsDependencies(step['run']))
      ) {
        report(
          `job "${name}" holds id-token: write and installs dependencies; install, build and pack in another job`,
        );
        break;
      }
    }
  }
  return oidcJobs;
}
