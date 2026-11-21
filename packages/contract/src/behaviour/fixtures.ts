// SPDX-License-Identifier: Apache-2.0
import type { GitGateway, RpcInput } from '../git-gateway.ts';
import type { Commit } from '../schemas/commit.ts';
import type { CommitActionInput } from '../schemas/commit-action.ts';
import { expectStatus, present } from './assertions.ts';

/** The author behaviour cases commit as. */
export const AUTHOR = { name: 'Behaviour Suite', email: 'behaviour@example.com' };

let keyCounter = 0;

/** A fresh idempotency key, unique across runs. */
export function freshKey(label = 'case'): string {
  keyCounter += 1;
  return `${label}-${keyCounter}-${crypto.randomUUID()}`;
}

/** Extra commit fields a case may set. */
export type CommitOptions = Partial<Omit<RpcInput<'commit'>, 'repo' | 'branch' | 'actions'>>;

/** Commits the actions to the branch, failing unless a new commit was written; returns it. */
export async function commitActions(
  gateway: GitGateway,
  repo: string,
  branch: string,
  actions: CommitActionInput[],
  options: CommitOptions = {},
): Promise<Commit> {
  const output = await gateway.commit({
    repo,
    branch,
    actions,
    message: options.message ?? `Change ${branch}`,
    author: options.author ?? AUTHOR,
    idempotencyKey: options.idempotencyKey ?? freshKey(),
    ...(options.committer === undefined ? {} : { committer: options.committer }),
    ...(options.expectedHead === undefined ? {} : { expectedHead: options.expectedHead }),
    ...(options.startBranch === undefined ? {} : { startBranch: options.startBranch }),
  });
  return expectStatus(output, 'committed').commit;
}

/** Upserts each file with text content (null deletes it) in one commit; returns the commit. */
export function writeFiles(
  gateway: GitGateway,
  repo: string,
  branch: string,
  files: Record<string, string | null>,
  options: CommitOptions = {},
): Promise<Commit> {
  const actions: CommitActionInput[] = Object.entries(files).map(([path, content]) =>
    content === null ? { action: 'delete', path } : { action: 'upsert', path, content },
  );
  return commitActions(gateway, repo, branch, actions, options);
}

/** Creates the repository with `main` holding the given text files; returns the first commit. */
export async function seedRepo(
  gateway: GitGateway,
  repo: string,
  files: Record<string, string> = { 'README.md': '# Seed\n' },
): Promise<Commit> {
  await gateway.createRepo({ repo, defaultBranch: 'main' });
  return writeFiles(gateway, repo, 'main', files);
}

/** Creates `branch` from `from` with one commit of the given files; returns that commit. */
export function branchFrom(
  gateway: GitGateway,
  repo: string,
  from: string,
  branch: string,
  files: Record<string, string | null>,
): Promise<Commit> {
  return writeFiles(gateway, repo, branch, files, { startBranch: from });
}

/** The head of a branch, or null. */
export async function headOf(gateway: GitGateway, repo: string, branch: string): Promise<string | null> {
  return (await gateway.resolveRef({ repo, ref: branch }))?.sha ?? null;
}

/** The head of a branch, failing when it does not exist. */
export async function requireHead(gateway: GitGateway, repo: string, branch: string): Promise<string> {
  return present(await headOf(gateway, repo, branch), `branch ${branch} should exist`);
}

/** The text content of a file at a ref, or null when absent. */
export async function readText(
  gateway: GitGateway,
  repo: string,
  ref: string,
  path: string,
): Promise<string | null> {
  const file = await gateway.readFile({ repo, ref, path, encoding: 'text' });
  return file === null ? null : file.content;
}

/** Every file path at a ref, sorted. */
export async function filePaths(gateway: GitGateway, repo: string, ref: string): Promise<string[]> {
  const listing = await gateway.listTree({ repo, ref, recursive: true });
  return (listing?.entries ?? []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
}
