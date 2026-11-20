// SPDX-License-Identifier: Apache-2.0
import { assertEqual, assertTrue, present } from '@leed-ai/git-gateway-contract/behaviour/assertions';
import { sameBytes } from '@leed-ai/git-gateway-contract/reference/bytes';

import { backendCase, type BackendCase } from './backend-case.ts';
import { pseudoRandomBytes } from './backend-fixtures.ts';
import { seedRepo } from './push-helpers.ts';

const GROUP = 'content';

/** Large and binary files, deep trees. */
export const contentCases: readonly BackendCase[] = [
  backendCase(
    GROUP,
    'a large binary file round-trips through readBlob, readFile and fetch',
    async (context) => {
      const bytes = pseudoRandomBytes(context.largeFileBytes);
      const seeded = await seedRepo(context, { 'assets/large.bin': { content: bytes } });
      const blob = present(
        seeded.objects.find((object) => object.type === 'blob' && object.data.length === bytes.length),
        'blob',
      );
      const { backend, repo } = context;
      assertTrue(
        sameBytes(present(await backend.readBlob(repo, blob.sha), 'readBlob'), bytes),
        'readBlob bytes',
      );
      assertTrue(
        sameBytes(present(await backend.readFile(repo, 'main', 'assets/large.bin'), 'readFile'), bytes),
        'readFile bytes',
      );
      const fetched = await (await context.client('read')).fetchPack({ wants: [seeded.sha] });
      const got = present(
        fetched.objects.find((object) => object.sha === blob.sha),
        'fetched blob',
      );
      assertTrue(sameBytes(got.data, bytes), 'fetched bytes');
    },
  ),
  backendCase(GROUP, 'an empty file and a deep tree are stored and read back', async (context) => {
    const deep = Array.from({ length: 24 }, (_, index) => `d${index}`).join('/');
    await seedRepo(context, { 'empty.txt': '', [`${deep}/leaf.txt`]: 'leaf\n' });
    const { backend, repo } = context;
    assertEqual(
      present(await backend.readFile(repo, 'main', 'empty.txt'), 'empty file').length,
      0,
      'empty file is empty',
    );
    assertEqual(
      new TextDecoder().decode(present(await backend.readFile(repo, 'main', `${deep}/leaf.txt`), 'leaf')),
      'leaf\n',
      'deep leaf',
    );
  }),
];
