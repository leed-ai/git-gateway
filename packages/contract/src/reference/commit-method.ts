// SPDX-License-Identifier: Apache-2.0
import { RPC_SCHEMAS, type RpcInput, type RpcOutput, type RpcParsedInput } from '../git-gateway.ts';
import { gatewayError } from '../gateway-error.ts';
import type { Commit } from '../schemas/commit.ts';
import { ZERO_SHA } from '../schemas/sha.ts';
import { applyActions } from './apply-actions.ts';
import { buildTreeIndex } from './tree-index.ts';
import { walkHistory } from './history.ts';
import { lookupIn, requireRepo, withRepoLock, type ReferenceContext, type RepoState } from './repo-state.ts';
import { runMethod } from './run-method.ts';
import { appendIdempotencyTrailer } from './trailer.ts';
import { writeCommit } from './write-commit.ts';

type Input = RpcParsedInput<'commit'>;

/** The commit carrying `key` within the configured lookback window of the branch, if any. */
function findReplay(
  context: ReferenceContext,
  repo: RepoState,
  head: string,
  key: string,
): Commit | undefined {
  const { maxCommits, maxAgeSeconds } = context.config.idempotency;
  const oldest = new Date(context.now().getTime() - maxAgeSeconds * 1000).toISOString();
  const window = walkHistory(lookupIn(repo), head).slice(0, maxCommits);
  for (const commit of window) {
    if (commit.committer.date < oldest) return undefined;
    if (commit.idempotencyKey === key) return commit;
  }
  return undefined;
}

/** The commit the new one builds on: the branch head, the start branch head, or none for a root commit. */
function baseOf(repo: RepoState, input: Input, head: string | null): string | null {
  if (head !== null) return head;
  if (input.startBranch !== undefined) {
    const start = repo.branches.get(input.startBranch);
    if (start === undefined) {
      throw gatewayError('ref_not_found', `Branch not found: ${input.startBranch}`, {
        ref: input.startBranch,
      });
    }
    return start;
  }
  if (repo.branches.size === 0) return null;
  throw gatewayError('ref_not_found', `Branch not found: ${input.branch}`, { ref: input.branch });
}

async function commitLocked(
  context: ReferenceContext,
  repo: RepoState,
  input: Input,
): Promise<RpcOutput<'commit'>> {
  const head = repo.branches.get(input.branch) ?? null;
  if (head !== null) {
    const replay = findReplay(context, repo, head, input.idempotencyKey);
    if (replay !== undefined) return { status: 'replayed', commit: replay };
  }
  if (input.expectedHead !== undefined && input.expectedHead !== head) {
    throw gatewayError('stale_head', `Branch ${input.branch} moved`, {
      branch: input.branch,
      expectedHead: input.expectedHead,
      actualHead: head,
    });
  }
  const base = baseOf(repo, input, head);
  const baseCommit = base === null ? undefined : repo.commits.get(base);
  const files = await applyActions(baseCommit?.files ?? new Map(), input.actions);
  const baseTree = baseCommit?.tree.rootSha ?? (await buildTreeIndex(new Map())).rootSha;
  const nextTree = (await buildTreeIndex(files)).rootSha;
  if (nextTree === baseTree) return { status: 'noop', head };
  const stored = await writeCommit(repo, {
    parents: base === null ? [] : [base],
    files,
    author: input.author,
    committer: input.committer ?? input.author,
    message: appendIdempotencyTrailer(input.message, input.idempotencyKey),
    date: context.now().toISOString(),
  });
  repo.branches.set(input.branch, stored.commit.sha);
  return {
    status: 'committed',
    commit: stored.commit,
    refUpdate: { ref: `refs/heads/${input.branch}`, oldSha: head ?? ZERO_SHA, newSha: stored.commit.sha },
  };
}

/** The reference `commit`: GitLab Commits API rules, idempotency replay, stale-head refusal, no-op detection. */
export function referenceCommit(
  context: ReferenceContext,
  input: RpcInput<'commit'>,
): Promise<RpcOutput<'commit'>> {
  return runMethod(RPC_SCHEMAS.commit, input, async (parsed) => {
    const repo = requireRepo(context, parsed.repo);
    return withRepoLock(repo, () => commitLocked(context, repo, parsed));
  });
}
