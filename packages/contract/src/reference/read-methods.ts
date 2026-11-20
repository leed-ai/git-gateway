// SPDX-License-Identifier: Apache-2.0
import { RPC_SCHEMAS, type RpcInput, type RpcOutput } from '../git-gateway.ts';
import { encodeContent } from './bytes.ts';
import { contains, walkHistory } from './history.ts';
import {
  lookupIn,
  requireRepo,
  requireRevision,
  resolveRevision,
  type ReferenceContext,
} from './repo-state.ts';
import { runMethod } from './run-method.ts';
import { entriesBeneath } from './tree-index.ts';

/** The reference `readFile`. */
export function referenceReadFile(
  context: ReferenceContext,
  input: RpcInput<'readFile'>,
): Promise<RpcOutput<'readFile'>> {
  return runMethod(RPC_SCHEMAS.readFile, input, async ({ repo, ref, path, encoding }) => {
    const stored = requireRevision(requireRepo(context, repo), ref);
    const file = stored.files.get(path);
    if (file === undefined) return null;
    return {
      path,
      commit: stored.commit.sha,
      sha: file.sha,
      size: file.bytes.length,
      executable: file.executable,
      ...encodeContent(file.bytes, encoding),
    };
  });
}

/** The reference `listTree`. */
export function referenceListTree(
  context: ReferenceContext,
  input: RpcInput<'listTree'>,
): Promise<RpcOutput<'listTree'>> {
  return runMethod(RPC_SCHEMAS.listTree, input, async ({ repo, ref, path, recursive }) => {
    const stored = requireRevision(requireRepo(context, repo), ref);
    const dir = path ?? '';
    if (!stored.tree.directories.has(dir)) return null;
    return {
      commit: stored.commit.sha,
      path: path ?? null,
      entries: entriesBeneath(stored.tree, dir, recursive),
    };
  });
}

/** The reference `resolveRef`. */
export function referenceResolveRef(
  context: ReferenceContext,
  input: RpcInput<'resolveRef'>,
): Promise<RpcOutput<'resolveRef'>> {
  return runMethod(RPC_SCHEMAS.resolveRef, input, async ({ repo, ref }) => {
    const stored = resolveRevision(requireRepo(context, repo), ref);
    return stored === undefined ? null : { sha: stored.commit.sha };
  });
}

/** The reference `log`. */
export function referenceLog(context: ReferenceContext, input: RpcInput<'log'>): Promise<RpcOutput<'log'>> {
  return runMethod(RPC_SCHEMAS.log, input, async ({ repo, ref, limit, offset, since }) => {
    const state = requireRepo(context, repo);
    const start = requireRevision(state, ref);
    const history = walkHistory(lookupIn(state), start.commit.sha).filter(
      (commit) => since === undefined || Date.parse(commit.committer.date) >= Date.parse(since),
    );
    return { commits: history.slice(offset, offset + limit), hasMore: history.length > offset + limit };
  });
}

/** The reference `commitExists`. */
export function referenceCommitExists(
  context: ReferenceContext,
  input: RpcInput<'commitExists'>,
): Promise<RpcOutput<'commitExists'>> {
  return runMethod(RPC_SCHEMAS.commitExists, input, async ({ repo, sha, branch }) => {
    const state = requireRepo(context, repo);
    if (!state.commits.has(sha)) return { exists: false };
    if (branch === undefined) return { exists: true };
    const head = state.branches.get(branch);
    return { exists: head !== undefined && contains(lookupIn(state), head, sha) };
  });
}
