// SPDX-License-Identifier: Apache-2.0

/** Example values shared by the schemas' `examples` metadata, so examples agree with each other. */
export const EXAMPLE_SHA_A = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
/** A second example commit id. */
export const EXAMPLE_SHA_B = '8f3c2a9e1b7d4c6f0a5e2d9b8c7a6f5e4d3c2b1a';
/** An example tree id (git's empty tree). */
export const EXAMPLE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** An example identity. */
export const EXAMPLE_IDENTITY = { name: 'Ada Lovelace', email: 'ada@example.com' };
/** An example timestamp. */
export const EXAMPLE_TIMESTAMP = '2026-11-20T09:30:00.000Z';
/** An example signature. */
export const EXAMPLE_SIGNATURE = { ...EXAMPLE_IDENTITY, date: EXAMPLE_TIMESTAMP };
/** An example stored commit. */
export const EXAMPLE_COMMIT = {
  sha: EXAMPLE_SHA_B,
  tree: EXAMPLE_TREE,
  parents: [EXAMPLE_SHA_A],
  author: EXAMPLE_SIGNATURE,
  committer: EXAMPLE_SIGNATURE,
  message: 'Update about page\n\nGateway-Idempotency-Key: cms:publish:2f9c1e\n',
  idempotencyKey: 'cms:publish:2f9c1e',
};
