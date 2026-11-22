// SPDX-License-Identifier: Apache-2.0
// Whether a checkout is ready to publish its versions to npm, for the release workflow and the
// local first publish alike. Node builtins only.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The changeset files waiting in `.changeset/`, excluding its README. */
export function pendingChangesets(repoRoot: string): string[] {
  const dir = join(repoRoot, '.changeset');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .toSorted();
}

/** What the local release preflight observed about the checkout and the operator's sessions. */
export interface CheckoutState {
  readonly branch: string;
  /** Uncommitted paths, or null when git could not be asked. */
  readonly dirty: readonly string[] | null;
  /** Whether `git fetch origin main` succeeded, and how many commits HEAD is behind it. */
  readonly fetched: boolean;
  readonly behind: number;
  readonly pendingChangesets: readonly string[];
  /** `npm whoami`, or null when nobody is logged in. */
  readonly npmUser: string | null;
  readonly ghAuthenticated: boolean;
}

/**
 * Every reason the checkout cannot be released, all at once. A dry run publishes nothing, so it
 * does not need an npm or GitHub session, but it is held to the same tree as a real release.
 */
export function releaseProblems(state: CheckoutState, { publishing }: { publishing: boolean }): string[] {
  const problems: string[] = [];
  if (state.pendingChangesets.length > 0) {
    problems.push(
      `${state.pendingChangesets.length} changeset(s) are not versioned yet (${state.pendingChangesets.join(', ')}); ` +
        'merge the "chore: release packages" pull request first, so the versions on main are the ones to publish',
    );
  }
  if (state.dirty === null) problems.push('git status failed, so the working tree cannot be checked');
  else if (state.dirty.length > 0)
    problems.push(`the working tree has ${state.dirty.length} uncommitted path(s)`);
  if (!publishing) return problems;
  if (state.branch !== 'main') problems.push(`on branch "${state.branch}", not main`);
  if (!state.fetched) problems.push('could not fetch origin/main to compare against');
  else if (state.behind > 0) problems.push(`${state.behind} commit(s) behind origin/main; pull first`);
  if (state.npmUser === null) problems.push('not logged in to npm; run `npm login`');
  if (!state.ghAuthenticated) problems.push('the GitHub CLI is not logged in; run `gh auth login`');
  return problems;
}
