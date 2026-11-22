// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { proveFastForward } from '../src/policy/fast-forward.ts';
import { FakeBackend } from './helpers/fake-backend.ts';

const sha = (n: number): string => n.toString(16).padStart(40, '0');

/** Storage holding a merge history: 1 ← 2 ← 4 and 1 ← 3, 4 merging 2 and 3. */
function storage(): FakeBackend {
  const backend = new FakeBackend();
  backend.addCommit(sha(1), []);
  backend.addCommit(sha(2), [sha(1)]);
  backend.addCommit(sha(3), [sha(1)]);
  backend.addCommit(sha(4), [sha(2), sha(3)]);
  return backend;
}

describe('proveFastForward', () => {
  it('proves ancestry through storage, merges included', async () => {
    const backend = storage();
    const sources = { repo: 'site', backend, maxReads: 100 };
    expect(await proveFastForward(sha(1), sha(4), sources)).toBe('yes');
    expect(await proveFastForward(sha(3), sha(4), sources)).toBe('yes');
    expect(await proveFastForward(sha(4), sha(4), sources)).toBe('yes');
    expect(await proveFastForward(sha(3), sha(2), sources)).toBe('no');
    expect(await proveFastForward(sha(4), sha(1), sources)).toBe('no');
  });

  it('takes commits from the pack before storage', async () => {
    const backend = storage();
    const packCommits = new Map([[sha(9), [sha(4)]]]);
    expect(
      await proveFastForward(sha(2), sha(9), { repo: 'site', backend, packCommits, maxReads: 100 }),
    ).toBe('yes');
    expect(
      await proveFastForward(sha(8), sha(9), { repo: 'site', backend, packCommits, maxReads: 100 }),
    ).toBe('no');
  });

  it('is unknown when a commit is missing, storage fails, or the read limit is reached', async () => {
    const backend = storage();
    expect(await proveFastForward(sha(1), sha(7), { repo: 'site', backend, maxReads: 100 })).toBe('unknown');
    expect(await proveFastForward(sha(1), sha(4), { repo: 'site', backend, maxReads: 1 })).toBe('unknown');
    backend.failReads = true;
    expect(await proveFastForward(sha(1), sha(4), { repo: 'site', backend, maxReads: 100 })).toBe('unknown');
  });

  it('reads each commit once even when histories rejoin', async () => {
    const backend = storage();
    await proveFastForward(sha(9), sha(4), { repo: 'site', backend, maxReads: 100 });
    expect(backend.commitReads).toBe(4);
  });
});

/** {@link storage} with the isAncestor capability turned on. */
function capable(): FakeBackend {
  const backend = storage();
  backend.answerAncestry();
  return backend;
}

describe('proveFastForward with the isAncestor capability', () => {
  it('asks the backend instead of walking history, and reads no commit', async () => {
    const backend = capable();
    const sources = { repo: 'site', backend, maxReads: 100 };
    expect(await proveFastForward(sha(1), sha(4), sources)).toBe('yes');
    expect(await proveFastForward(sha(3), sha(2), sources)).toBe('no');
    expect(await proveFastForward(sha(4), sha(4), sources)).toBe('yes');
    expect(backend.commitReads).toBe(0);
    expect(backend.ancestryQueries).toBe(2);
  });

  it('walks the pack first and asks once per commit where the walk leaves it', async () => {
    const backend = capable();
    // 9 merges 7 and 8 (both in the pack); 7 sits on 2 and 8 on 3, both in storage.
    const packCommits = new Map([
      [sha(9), [sha(7), sha(8)]],
      [sha(7), [sha(2)]],
      [sha(8), [sha(3)]],
    ]);
    const sources = { repo: 'site', backend, packCommits, maxReads: 100 };
    expect(await proveFastForward(sha(8), sha(9), sources)).toBe('yes');
    expect(backend.ancestryQueries).toBe(0);
    expect(await proveFastForward(sha(1), sha(9), sources)).toBe('yes');
    expect(await proveFastForward(sha(4), sha(9), sources)).toBe('no');
    expect(backend.ancestryQueries).toBe(1 + 2);
  });

  it('is unknown when the backend cannot place a commit, fails, or would be asked too often', async () => {
    const backend = capable();
    expect(await proveFastForward(sha(1), sha(7), { repo: 'site', backend, maxReads: 100 })).toBe('unknown');
    const packCommits = new Map([[sha(9), [sha(2), sha(3)]]]);
    expect(await proveFastForward(sha(4), sha(9), { repo: 'site', backend, packCommits, maxReads: 1 })).toBe(
      'unknown',
    );
    backend.failReads = true;
    expect(await proveFastForward(sha(1), sha(4), { repo: 'site', backend, maxReads: 100 })).toBe('unknown');
    expect(backend.commitReads).toBe(0);
  });
});
