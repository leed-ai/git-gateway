// SPDX-License-Identifier: Apache-2.0
import { utf8 } from '@leed-ai/git-gateway-contract/reference/bytes';
import { readIdempotencyTrailer } from '@leed-ai/git-gateway-contract/reference/trailer';
import { Commit } from '@leed-ai/git-gateway-contract/schemas/commit';
import type { Signature } from '@leed-ai/git-gateway-contract/schemas/identity';

import { coreError } from '../core-error.ts';
import { CommitFields, type GitObject } from '../schemas/git-object.ts';
import { commitHeaderLines, readCommitParents } from './commit-parents.ts';
import { createObject } from './hash-object.ts';

const IDENT = /^(.*) <([^<>\n]*)> (\d+) ([+-]\d{4})$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
/** The largest seconds-since-epoch a JavaScript Date holds (8.64e15 ms). */
const MAX_EPOCH_SECONDS = 8.64e12;

/** Whole seconds since the epoch of an ISO 8601 UTC timestamp. */
const epochSeconds = (date: string): number => Math.floor(Date.parse(date) / 1000);

/** The ISO 8601 UTC timestamp of some whole seconds since the epoch. */
const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** A signature with its date truncated to the whole second git stores. */
function storedSignature(signature: Signature): Signature {
  return { name: signature.name, email: signature.email, date: isoOf(epochSeconds(signature.date)) };
}

const identLine = (signature: Signature): string =>
  `${signature.name} <${signature.email}> ${epochSeconds(signature.date)} +0000`;

/**
 * Encodes the content of a commit object in git's format, dates as "<seconds> +0000". Throws a
 * ZodError for fields {@link CommitFields} rejects, including dates before 1970.
 */
export function encodeCommit(fields: CommitFields): Uint8Array {
  const parsed = CommitFields.parse(fields);
  const headers = [
    `tree ${parsed.tree}`,
    ...parsed.parents.map((parent) => `parent ${parent}`),
    `author ${identLine(parsed.author)}`,
    `committer ${identLine(parsed.committer)}`,
  ];
  return utf8(`${headers.join('\n')}\n\n${parsed.message}`);
}

/** A new commit object and the contract {@link Commit} describing it (dates in whole seconds). */
export interface CreatedCommit {
  readonly object: GitObject;
  readonly commit: Commit;
}

/** Builds a commit object from its fields and describes it as a contract {@link Commit}. */
export async function createCommit(fields: CommitFields): Promise<CreatedCommit> {
  const parsed = CommitFields.parse(fields);
  const object = await createObject('commit', encodeCommit(parsed));
  const commit = Commit.parse({
    sha: object.sha,
    tree: parsed.tree,
    parents: [...parsed.parents],
    author: storedSignature(parsed.author),
    committer: storedSignature(parsed.committer),
    message: parsed.message,
    idempotencyKey: readIdempotencyTrailer(parsed.message),
  });
  return { object, commit };
}

function invalidCommit(sha: string, reason: string): Error {
  return coreError('invalid_object', 'Invalid commit object', { sha, type: 'commit', reason });
}

function parseIdent(sha: string, header: string, value: string | undefined): Signature {
  const match = value === undefined ? null : IDENT.exec(value);
  if (match === null) throw invalidCommit(sha, `missing or malformed ${header} line`);
  const seconds = Number(match[3]);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_EPOCH_SECONDS) {
    throw invalidCommit(sha, `${header} timestamp out of range`);
  }
  return { name: match[1] ?? '', email: match[2] ?? '', date: isoOf(seconds) };
}

/**
 * Decodes the content of a commit object with id `sha` into a contract {@link Commit}. Parents are
 * read as git reads them: only the `parent` lines straight after the leading tree line; a commit
 * with a `parent` header anywhere else is refused, as git's fsck refuses it. Dates are
 * converted to UTC (the original time zone is not kept); headers other than tree, parent,
 * author and committer (encoding, gpgsig, mergetag) are skipped. Throws an invalid_object
 * CoreError for content that is not a commit or that the Commit schema cannot represent (e.g.
 * more than two parents, an empty message or an identity git allows but the schema does not).
 */
export function decodeCommit(sha: string, data: Uint8Array): Commit {
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    throw invalidCommit(sha, 'content is not UTF-8');
  }
  const split = text.indexOf('\n\n');
  const headerLines = commitHeaderLines(text);
  const parents = readCommitParents(headerLines);
  if (parents === null) {
    throw invalidCommit(
      sha,
      'the header must start with a tree line, with parent lines only straight after it',
    );
  }
  const headers = new Map<string, string[]>();
  for (const line of headerLines) {
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    headers.set(key, [...(headers.get(key) ?? []), line.slice(space + 1)]);
  }
  const parsed = Commit.safeParse({
    sha,
    tree: headers.get('tree')?.[0],
    parents,
    author: parseIdent(sha, 'author', headers.get('author')?.[0]),
    committer: parseIdent(sha, 'committer', headers.get('committer')?.[0]),
    message: split === -1 ? '' : text.slice(split + 2),
    idempotencyKey: split === -1 ? null : readIdempotencyTrailer(text.slice(split + 2)),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidCommit(sha, `${issue?.path.join('.') ?? 'commit'}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}
