// SPDX-License-Identifier: Apache-2.0
import { RPC_SCHEMAS, type RpcInput, type RpcOutput, type RpcParsedInput } from '../git-gateway.ts';
import { gatewayError } from '../gateway-error.ts';
import { ZERO_SHA } from '../schemas/sha.ts';
import { contains, mergeBase } from './history.ts';
import {
  lookupIn,
  requireBranchHead,
  requireRepo,
  withRepoLock,
  type ReferenceContext,
  type RepoState,
} from './repo-state.ts';
import { runMethod } from './run-method.ts';
import { threeWayMerge } from './three-way-merge.ts';
import { writeCommit } from './write-commit.ts';

const branchRef = (branch: string): string => `refs/heads/${branch}`;

async function syncLocked(
  context: ReferenceContext,
  repo: RepoState,
  input: RpcParsedInput<'syncBranch'>,
): Promise<RpcOutput<'syncBranch'>> {
  const fromHead = requireBranchHead(repo, input.from);
  const intoHead = requireBranchHead(repo, input.into);
  const lookup = lookupIn(repo);
  if (contains(lookup, intoHead, fromHead)) return { status: 'up_to_date', head: intoHead };
  const refUpdate = (newSha: string) => ({ ref: branchRef(input.into), oldSha: intoHead, newSha });
  if (contains(lookup, fromHead, intoHead)) {
    repo.branches.set(input.into, fromHead);
    return { status: 'fast_forward', refUpdate: refUpdate(fromHead) };
  }
  const base = mergeBase(lookup, intoHead, fromHead);
  if (base === null) {
    throw gatewayError('unrelated_histories', `${input.from} and ${input.into} share no history`, {
      from: input.from,
      into: input.into,
    });
  }
  const files = (sha: string) => repo.commits.get(sha)?.files ?? new Map();
  const merged = threeWayMerge(files(base), files(intoHead), files(fromHead));
  if (merged.kind === 'conflict') {
    return { status: 'conflict', paths: [...merged.paths], base, fromHead, intoHead };
  }
  const identity = input.author ?? context.config.serviceIdentity;
  const stored = await writeCommit(repo, {
    parents: [intoHead, fromHead],
    files: merged.files,
    author: identity,
    committer: identity,
    message: input.message ?? `Merge branch '${input.from}' into ${input.into}`,
    date: context.now().toISOString(),
  });
  repo.branches.set(input.into, stored.commit.sha);
  return { status: 'merged', commit: stored.commit, refUpdate: refUpdate(stored.commit.sha) };
}

/** The reference `syncBranch`: up to date, fast-forward, file-level merge, or conflict with paths. */
export function referenceSyncBranch(
  context: ReferenceContext,
  input: RpcInput<'syncBranch'>,
): Promise<RpcOutput<'syncBranch'>> {
  return runMethod(RPC_SCHEMAS.syncBranch, input, async (parsed) => {
    const repo = requireRepo(context, parsed.repo);
    return withRepoLock(repo, () => syncLocked(context, repo, parsed));
  });
}

function promoteLocked(repo: RepoState, input: RpcParsedInput<'promote'>): RpcOutput<'promote'> {
  const { from, into, sha } = input;
  const fromHead = requireBranchHead(repo, from);
  if (fromHead !== sha) {
    throw gatewayError('not_head_of_source', `${sha} is not the head of ${from}`, {
      from,
      sha,
      head: fromHead,
    });
  }
  const intoHead = repo.branches.get(into);
  if (intoHead === sha) return { status: 'up_to_date', head: sha };
  if (intoHead !== undefined && !contains(lookupIn(repo), sha, intoHead)) {
    throw gatewayError('not_fast_forward', `${sha} does not contain the head of ${into}`, {
      into,
      sha,
      head: intoHead,
    });
  }
  repo.branches.set(into, sha);
  return {
    status: 'promoted',
    refUpdate: { ref: branchRef(into), oldSha: intoHead ?? ZERO_SHA, newSha: sha },
  };
}

/** The reference `promote`: fast-forward only, from the source head only. */
export function referencePromote(
  context: ReferenceContext,
  input: RpcInput<'promote'>,
): Promise<RpcOutput<'promote'>> {
  return runMethod(RPC_SCHEMAS.promote, input, async (parsed) => {
    const repo = requireRepo(context, parsed.repo);
    return withRepoLock(repo, async () => promoteLocked(repo, parsed));
  });
}
