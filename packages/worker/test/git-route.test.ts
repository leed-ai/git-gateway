// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vite-plus/test';

import { resolveGitRequest } from '../src/proxy/git-route.ts';

const at = (path: string) => resolveGitRequest(new URL(`https://git.example.com${path}`));

describe('resolveGitRequest', () => {
  it('resolves the three smart-HTTP endpoints', () => {
    expect(at('/site.git/info/refs?service=git-upload-pack')).toEqual({
      repo: 'site',
      endpoint: 'info-refs',
      service: 'git-upload-pack',
      operation: 'read',
    });
    expect(at('/site.git/info/refs?service=git-receive-pack')).toEqual({
      repo: 'site',
      endpoint: 'info-refs',
      service: 'git-receive-pack',
      operation: 'write',
    });
    expect(at('/site.git/git-upload-pack')).toEqual({
      repo: 'site',
      endpoint: 'upload-pack',
      service: 'git-upload-pack',
      operation: 'read',
    });
    expect(at('/a.b-c_d.git/git-receive-pack')).toEqual({
      repo: 'a.b-c_d',
      endpoint: 'receive-pack',
      service: 'git-receive-pack',
      operation: 'write',
    });
  });

  it('decodes the repository name and checks it against the contract', () => {
    expect(at('/s%69te.git/git-upload-pack')).toMatchObject({ repo: 'site' });
    expect(at('/-x.git/git-upload-pack')).toBe('not-found');
    expect(at('/a%2Fb.git/git-upload-pack')).toBe('not-found');
  });

  it('tells dumb HTTP from paths that are not git at all', () => {
    expect(at('/site.git/info/refs')).toBe('dumb-http');
    expect(at('/site.git/HEAD')).toBe('not-found');
    expect(at('/site/git-upload-pack')).toBe('not-found');
  });
});
