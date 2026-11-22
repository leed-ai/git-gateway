// SPDX-License-Identifier: Apache-2.0
import { GitLabHttpError, type GitLabApi } from './gitlab-api.ts';
import { GitLabCommitSummary } from './schemas/gitlab-responses.ts';

/**
 * Whether `ancestor` is `descendant` or one of its ancestors, from one call to GitLab's merge-base
 * API (`GET /projects/:id/repository/merge_base?refs[]=…&refs[]=…`): it is exactly when the merge
 * base of the two is `ancestor` itself. Null when GitLab cannot find either commit (400 "Could not
 * find ref"); false when the two share no history (404 "Merge Base Not Found"). Any other error is
 * thrown for the backend to map. Both ids must already be validated 40-character hex ids, which
 * git resolves as object ids before any ref name.
 */
export async function isAncestorOnGitLab(
  api: GitLabApi,
  projectPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  const refs = [ancestor, descendant].map((sha) => `refs%5B%5D=${sha}`).join('&');
  try {
    const base = await api.json(GitLabCommitSummary, `${projectPath}/repository/merge_base?${refs}`);
    return base.id === ancestor;
  } catch (error) {
    if (error instanceof GitLabHttpError && !error.projectMissing) {
      if (error.status === 400 && /could not find/i.test(error.detail)) return null;
      if (error.status === 404 && /merge base/i.test(error.detail)) return false;
    }
    throw error;
  }
}
