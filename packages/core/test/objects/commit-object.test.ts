// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { describe, expect, it } from 'vite-plus/test';

import { isCoreError } from '../../src/core-error.ts';
import { createCommit, decodeCommit, encodeCommit } from '../../src/objects/commit-object.ts';
import { hashObject } from '../../src/objects/hash-object.ts';
import type { CommitFields } from '../../src/schemas/git-object.ts';

const TREE = 'ca2954efa39bbe2b06603870092b566af10a9f4e';
const PARENT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com', date: '2025-11-20T09:30:00.000Z' };
const GRACE = { name: 'Grace Hopper', email: 'grace@example.com', date: '2025-11-20T09:31:00.000Z' };

/** `git commit-tree` with these identities and dates (1763631000 / 1763631060 +0000) gives this id. */
const FIXTURE: CommitFields = {
  tree: TREE,
  parents: [],
  author: ADA,
  committer: GRACE,
  message: 'Initial commit\n',
};
const FIXTURE_SHA = '746d5ca86f17946c808f8b680c5f7718402a2f67';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

function invalidReason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (isCoreError(error, 'invalid_object') && error.body.code === 'invalid_object') {
      return error.body.details.reason;
    }
    throw error;
  }
  return undefined;
}

describe('encodeCommit', () => {
  it('hashes identically to git commit-tree', async () => {
    expect(await hashObject('commit', encodeCommit(FIXTURE))).toBe(FIXTURE_SHA);
  });

  it('writes headers in git order with parents and +0000 dates', () => {
    expect(text(encodeCommit({ ...FIXTURE, parents: [PARENT, TREE] }))).toBe(
      [
        `tree ${TREE}`,
        `parent ${PARENT}`,
        `parent ${TREE}`,
        'author Ada Lovelace <ada@example.com> 1763631000 +0000',
        'committer Grace Hopper <grace@example.com> 1763631060 +0000',
        '',
        'Initial commit\n',
      ].join('\n'),
    );
  });

  it('drops fractional seconds', () => {
    const later = { ...ADA, date: '2025-11-20T09:30:00.999Z' };
    expect(encodeCommit({ ...FIXTURE, author: later })).toEqual(encodeCommit(FIXTURE));
  });

  it('writes the epoch itself as 0 and refuses any earlier date', () => {
    const epoch = { ...ADA, date: '1970-01-01T00:00:00.000Z' };
    expect(text(encodeCommit({ ...FIXTURE, author: epoch, committer: epoch }))).toContain(
      'author Ada Lovelace <ada@example.com> 0 +0000\ncommitter Ada Lovelace <ada@example.com> 0 +0000',
    );
    const before = { ...ADA, date: '1969-12-31T23:59:59.000Z' };
    expect(() => encodeCommit({ ...FIXTURE, author: before })).toThrow(/1970/);
    expect(() => encodeCommit({ ...FIXTURE, committer: before })).toThrow(ZodError);
    expect(() => encodeCommit({ ...FIXTURE, author: { ...ADA, date: '1900-01-01T00:00:00Z' } })).toThrow(
      ZodError,
    );
  });

  it('refuses fields the schema rejects', () => {
    expect(() => encodeCommit({ ...FIXTURE, parents: [PARENT, PARENT, PARENT] })).toThrow(ZodError);
    expect(() => encodeCommit({ ...FIXTURE, message: '' })).toThrow(ZodError);
    expect(() => encodeCommit({ ...FIXTURE, author: { ...ADA, name: 'A <b>' } })).toThrow(ZodError);
  });
});

describe('createCommit', () => {
  it('returns the object and a contract commit with whole-second dates', async () => {
    const { object, commit } = await createCommit({
      ...FIXTURE,
      author: { ...ADA, date: '2025-11-20T09:30:00.250Z' },
    });
    expect(object.sha).toBe(FIXTURE_SHA);
    expect(object.type).toBe('commit');
    expect(commit).toEqual({
      sha: FIXTURE_SHA,
      tree: TREE,
      parents: [],
      author: ADA,
      committer: GRACE,
      message: 'Initial commit\n',
      idempotencyKey: null,
    });
  });

  it('parses the idempotency trailer into the commit', async () => {
    const { commit } = await createCommit({
      ...FIXTURE,
      message: 'Publish\n\nGateway-Idempotency-Key: cms:publish:1\n',
    });
    expect(commit.idempotencyKey).toBe('cms:publish:1');
  });
});

describe('decodeCommit', () => {
  it('round-trips what encodeCommit writes', async () => {
    const { commit } = await createCommit({ ...FIXTURE, parents: [PARENT] });
    expect(decodeCommit(commit.sha, encodeCommit({ ...FIXTURE, parents: [PARENT] }))).toEqual(commit);
  });

  it('converts other time zones to UTC and skips extra headers', () => {
    const data = bytes(
      [
        `tree ${TREE}`,
        `parent ${PARENT}`,
        'author Ada Lovelace <ada@example.com> 1763631000 +0200',
        'committer Ada Lovelace <ada@example.com> 1763631000 -0500',
        'encoding UTF-8',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' abcdef',
        ' -----END PGP SIGNATURE-----',
        '',
        'Signed work',
        '',
        'Gateway-Idempotency-Key: k1',
        '',
      ].join('\n'),
    );
    expect(decodeCommit(FIXTURE_SHA, data)).toEqual({
      sha: FIXTURE_SHA,
      tree: TREE,
      parents: [PARENT],
      author: ADA,
      committer: { ...ADA },
      message: 'Signed work\n\nGateway-Idempotency-Key: k1\n',
      idempotencyKey: 'k1',
    });
  });

  it.each([
    ['content that is not UTF-8', Uint8Array.of(0xff, 0xfe), /UTF-8/],
    ['a missing author', bytes(`tree ${TREE}\ncommitter Ada <a@b.co> 1 +0000\n\nm`), /author/],
    [
      'a malformed committer',
      bytes(`tree ${TREE}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada\n\nm`),
      /committer/,
    ],
    ['a missing tree', bytes('author Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> 1 +0000\n\nm'), /tree/],
    [
      'a parent line after the author, which git does not read as a parent',
      bytes(
        `tree ${TREE}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> 1 +0000\nparent ${PARENT}\n\nm`,
      ),
      /parent lines only straight after it/,
    ],
    [
      'a parent line before the tree',
      bytes(
        `parent ${PARENT}\ntree ${TREE}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> 1 +0000\n\nm`,
      ),
      /must start with a tree line/,
    ],
    [
      'no message',
      bytes(`tree ${TREE}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> 1 +0000`),
      /message/,
    ],
    [
      'an octopus merge',
      bytes(
        `tree ${TREE}\nparent ${PARENT}\nparent ${PARENT}\nparent ${PARENT}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> 1 +0000\n\nm`,
      ),
      /parents/,
    ],
    [
      'a timestamp beyond what a Date holds',
      bytes(`tree ${TREE}\nauthor Ada <a@b.co> 8640000000001 +0000\ncommitter Ada <a@b.co> 1 +0000\n\nm`),
      /author timestamp out of range/,
    ],
    [
      'a timestamp beyond the safe integers',
      bytes(`tree ${TREE}\nauthor Ada <a@b.co> 1 +0000\ncommitter Ada <a@b.co> ${'9'.repeat(30)} +0000\n\nm`),
      /committer timestamp out of range/,
    ],
  ])('refuses %s', (_, data, reason) => {
    expect(invalidReason(() => decodeCommit(FIXTURE_SHA, data))).toMatch(reason);
  });

  it('refuses a timestamp a Date holds but a commit date cannot express as an invalid_object', () => {
    const data = bytes(
      `tree ${TREE}\nauthor Ada <a@b.co> 8640000000000 +0000\ncommitter Ada <a@b.co> 1 +0000\n\nm`,
    );
    expect(invalidReason(() => decodeCommit(FIXTURE_SHA, data))).toMatch(/author/);
  });
});
